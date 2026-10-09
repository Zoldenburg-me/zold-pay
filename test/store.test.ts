import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const { hashSecret } = await import("../server/src/secrets.js");
const { INTENT_TTL_MS, initStore, store } = await import("../server/src/store.js");

const tmpDb = () => path.join(mkdtempSync(path.join(tmpdir(), "pay-store-")), "checkout.json");
const NOW = "2026-10-09T10:00:00.000Z";

const legacy = () => ({
  merchants: [
    {
      id: "m1", name: "Legacy", clientId: "legacy-client", clientSecret: "plain-secret",
      settlementIbans: ["DE89370400440532013000"], redirectUris: ["https://m.test/cb"], createdAt: NOW,
    },
  ],
  paymentIntents: [
    {
      id: "i-open", merchantId: "m1", amountEur: 5, reference: "r1", destinationIban: "DE89370400440532013000",
      redirectUri: "https://m.test/cb", state: "s", codeChallenge: "c", status: "AUTHORIZED",
      code: "plain-code", statusToken: "plain-status", payerName: "Ada Lovelace", createdAt: NOW, updatedAt: NOW,
    },
    {
      id: "i-done", merchantId: "m1", amountEur: 6, reference: "r2", destinationIban: "DE89370400440532013000",
      redirectUri: "https://m.test/cb", state: "s", codeChallenge: "c", status: "PAID",
      statusToken: "plain-status-2", payerName: "Grace Hopper", createdAt: NOW, updatedAt: NOW,
    },
  ],
});

describe("store migration", () => {
  it("replaces plaintext secrets and tokens with hashes on disk", () => {
    const file = tmpDb();
    writeFileSync(file, JSON.stringify(legacy()));
    initStore(file);
    const onDisk = readFileSync(file, "utf8");
    for (const secret of ["plain-secret", "plain-code", "plain-status", "plain-status-2"]) {
      assert.equal(onDisk.includes(secret), false, `${secret} must not remain on disk`);
    }
    assert.equal(store.findMerchantByClientId("legacy-client")?.clientSecretHash, hashSecret("plain-secret"));
  });

  it("keeps a legacy unexchanged code usable and a legacy status token valid", () => {
    const file = tmpDb();
    writeFileSync(file, JSON.stringify(legacy()));
    initStore(file);
    assert.equal(store.findPaymentIntentByCode("plain-code")?.id, "i-open");
    assert.equal(store.findPaymentIntent("i-done")?.statusTokenHash, hashSecret("plain-status-2"));
  });

  it("drops payer names that are no longer needed", () => {
    const file = tmpDb();
    writeFileSync(file, JSON.stringify(legacy()));
    initStore(file);
    assert.equal(store.findPaymentIntent("i-done")?.payerName, undefined);
    assert.equal(readFileSync(file, "utf8").includes("Grace Hopper"), false);
  });

  it("is idempotent", () => {
    const file = tmpDb();
    writeFileSync(file, JSON.stringify(legacy()));
    initStore(file);
    const first = readFileSync(file, "utf8");
    initStore(file);
    assert.equal(readFileSync(file, "utf8"), first);
  });

  it("writes the file readable by its owner only", () => {
    const file = tmpDb();
    initStore(file);
    store.addMerchant({
      id: "m2", name: "New", clientId: "new-client", clientSecretHash: hashSecret("s"),
      settlementIbans: ["DE89370400440532013000"], redirectUris: ["https://m.test/cb"], createdAt: NOW,
    });
    assert.equal(statSync(file).mode & 0o077, 0);
  });

  it("never matches an empty or unknown code", () => {
    initStore(tmpDb());
    assert.equal(store.findPaymentIntentByCode(""), undefined);
    assert.equal(store.findPaymentIntentByCode("nope"), undefined);
  });
});

describe("housekeeping", () => {
  const base = (over: Record<string, unknown>) => ({
    merchantId: "m", amountEur: 1, reference: "", destinationIban: "DE89370400440532013000",
    redirectUri: "https://m.test/cb", state: "", codeChallenge: "c",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  }) as any;

  it("prunes old pending intents but keeps fresh and settled ones", () => {
    initStore(tmpDb());
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    store.addPaymentIntent(base({ id: "old-pending", status: "PENDING", createdAt: old }));
    store.addPaymentIntent(base({ id: "old-paid", status: "PAID", createdAt: old }));
    store.addPaymentIntent(base({ id: "fresh", status: "PENDING" }));
    store.sweep();
    assert.equal(store.findPaymentIntent("old-pending"), undefined);
    assert.ok(store.findPaymentIntent("old-paid"));
    assert.ok(store.findPaymentIntent("fresh"));
  });

  it("drops the payer name of an expired code from memory and disk without a restart", () => {
    const file = tmpDb();
    initStore(file);
    store.addPaymentIntent(base({
      id: "i1", status: "AUTHORIZED", payerName: "Ada Lovelace", codeHash: "h",
      codeExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    store.sweep();
    assert.equal(store.findPaymentIntent("i1")?.payerName, undefined);
    assert.equal(readFileSync(file, "utf8").includes("Ada Lovelace"), false);
  });

  it("counts pending intents per merchant and finds the intent a transfer already paid", () => {
    initStore(tmpDb());
    store.addPaymentIntent(base({ id: "a", merchantId: "m1", status: "PENDING" }));
    store.addPaymentIntent(base({ id: "b", merchantId: "m1", status: "PENDING" }));
    store.addPaymentIntent(base({ id: "c", merchantId: "m2", status: "PENDING" }));
    store.addPaymentIntent(base({ id: "d", merchantId: "m1", status: "AUTHORIZED", transferId: "t-9" }));
    assert.equal(store.pendingCount("m1"), 2);
    assert.equal(store.findPaymentIntentByTransfer("t-9")?.id, "d");
    assert.equal(store.findPaymentIntentByTransfer("nope"), undefined);
  });

  it("counts only live pending checkouts, per channel", () => {
    initStore(tmpDb());
    const stale = new Date(Date.now() - INTENT_TTL_MS - 60_000).toISOString();
    store.addPaymentIntent(base({ id: "live-back", merchantId: "m1", status: "PENDING" }));
    store.addPaymentIntent(base({ id: "live-front", merchantId: "m1", status: "PENDING", channel: "front" }));
    store.addPaymentIntent(base({ id: "stale-back", merchantId: "m1", status: "PENDING", createdAt: stale }));
    store.addPaymentIntent(base({ id: "stale-front", merchantId: "m1", status: "PENDING", channel: "front", createdAt: stale }));
    assert.equal(store.pendingCount("m1"), 1, "back channel is the default and ignores stale ones");
    assert.equal(store.pendingCount("m1", "back"), 1);
    assert.equal(store.pendingCount("m1", "front"), 1);
  });

  it("gives intents saved before payRef existed a unique one, once, and keeps it across restarts", () => {
    const file = tmpDb();
    writeFileSync(file, JSON.stringify(legacy()));
    initStore(file);
    const a = store.findPaymentIntent("i-open")!.payRef;
    const b = store.findPaymentIntent("i-done")!.payRef;
    assert.match(a, /^ZP[0-9A-F]{12}$/);
    assert.notEqual(a, b);
    initStore(file);
    assert.equal(store.findPaymentIntent("i-open")!.payRef, a);
  });
});

// A write that fails (disk full, permissions) must leave memory exactly as it was,
// or a request that returned a 500 would still have changed what the service believes.
describe("durability when the disk write fails", () => {
  const skip = process.getuid?.() === 0 ? "running as root: directory permissions are not enforced" : false;
  const intent = (over: Record<string, unknown>) => ({
    merchantId: "m1", amountEur: 1, reference: "", payRef: "ZP000000000001", destinationIban: "DE89370400440532013000",
    redirectUri: "https://m.test/cb", state: "", codeChallenge: "c",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  }) as any;

  /** Run `fn` with the store's directory read-only, then restore it so cleanup works. */
  function withBrokenDisk(fn: () => void, dir: string) {
    chmodSync(dir, 0o500);
    try {
      fn();
    } finally {
      chmodSync(dir, 0o700);
    }
  }
  const fresh = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pay-durable-"));
    initStore(path.join(dir, "checkout.json"));
    return dir;
  };

  it("does not add an intent that could not be saved", { skip }, () => {
    const dir = fresh();
    withBrokenDisk(() => assert.throws(() => store.addPaymentIntent(intent({ id: "ghost", status: "PENDING" }))), dir);
    assert.equal(store.findPaymentIntent("ghost"), undefined);
    store.addPaymentIntent(intent({ id: "real", status: "PENDING" }));
    assert.ok(store.findPaymentIntent("real"), "the store recovers once the disk does");
  });

  it("does not add a merchant that could not be saved", { skip }, () => {
    const dir = fresh();
    withBrokenDisk(() => assert.throws(() => store.addMerchant({
      id: "gm", name: "G", clientId: "ghost", clientSecretHash: "h", settlementIbans: [], redirectUris: [], createdAt: NOW,
    })), dir);
    assert.equal(store.findMerchantByClientId("ghost"), undefined);
  });

  it("keeps an unsaved update out of memory, so a burned code is never half-burned", { skip }, () => {
    const dir = fresh();
    store.addPaymentIntent(intent({ id: "i1", status: "AUTHORIZED", codeHash: "h", codeExpiresAt: new Date(Date.now() + 60_000).toISOString() }));
    withBrokenDisk(() => assert.throws(() => store.updatePaymentIntent("i1", { codeHash: undefined, status: "PAID" })), dir);
    const after = store.findPaymentIntent("i1")!;
    assert.equal(after.codeHash, "h");
    assert.equal(after.status, "AUTHORIZED");
    store.updatePaymentIntent("i1", { codeHash: undefined });
    assert.equal(store.findPaymentIntent("i1")!.codeHash, undefined);
  });

  it("keeps an unsaved sweep out of memory", { skip }, () => {
    const dir = fresh();
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    store.addPaymentIntent(intent({ id: "old", status: "PENDING", createdAt: old }));
    withBrokenDisk(() => assert.throws(() => store.sweep()), dir);
    assert.ok(store.findPaymentIntent("old"), "memory still matches the file on disk");
    store.sweep();
    assert.equal(store.findPaymentIntent("old"), undefined);
  });

  it("sweepSafely reports a failed sweep instead of throwing out of a timer", { skip }, () => {
    const dir = fresh();
    store.addPaymentIntent(intent({ id: "old", status: "PENDING", createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() }));
    const logged: unknown[][] = [];
    withBrokenDisk(() => assert.equal(store.sweepSafely((...a) => logged.push(a)), false), dir);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /sweep failed/);
    assert.equal(store.sweepSafely(() => assert.fail("nothing to report")), true);
  });
});
