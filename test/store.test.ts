import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const { hashSecret } = await import("../server/src/secrets.js");
const { initStore, store } = await import("../server/src/store.js");

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
});
