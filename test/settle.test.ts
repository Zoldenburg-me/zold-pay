import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";

// A stand-in for Zold, started before the config is read so CORE_API_URL points at it.
const zoldRequests: { url: string; authorization?: string }[] = [];
const fakeZold = createServer((req, res) => {
  zoldRequests.push({ url: req.url ?? "", authorization: req.headers.authorization });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "t9", state: "PAID" }));
});
await new Promise<void>((r) => fakeZold.listen(0, "127.0.0.1", r));
process.env.CORE_API_URL = `http://127.0.0.1:${(fakeZold.address() as AddressInfo).port}`;
after(() => fakeZold.close());

const { hashSecret } = await import("../server/src/secrets.js");
const { initStore, store } = await import("../server/src/store.js");
const co = await import("../server/src/checkout.js");
const st = await import("../server/src/settle.js");

const IBAN = "DE89370400440532013000";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const NOW = "2026-10-10T10:00:00.000Z";
const SEC = 1000;

/** An AUTHORIZED checkout: a payment attached while its payout was still PAYOUT_SUBMITTED. */
function authorized(transferId = "t1", amountEur = 12.5) {
  const merchant = store.findMerchant("m1") ?? store.addMerchant({
    id: "m1", name: "m1", clientId: "shop", clientSecretHash: hashSecret("s3cret"),
    settlementIbans: [IBAN], redirectUris: ["https://shop.test/cb"], createdAt: NOW,
  });
  const intent = co.createIntent(merchant, {
    amountEur, reference: "order-77", redirectUri: "https://shop.test/cb", state: "st", codeChallenge: CHALLENGE,
  });
  co.attachTransfer(intent.id, {
    id: transferId, userId: "u1", rail: "sepa", state: "PAYOUT_SUBMITTED", recipientIban: IBAN, receiveEur: amountEur,
    reference: co.transferReference(intent),
  });
  const after = store.findPaymentIntent(intent.id)!;
  assert.equal(after.status, "AUTHORIZED");
  return after;
}

/** What GET /api/service/checkout/transfers/:id answers for `intent`'s transfer. */
const view = (intent: { transferId?: string; payRef: string; reference: string; amountEur: number }, over: Record<string, unknown> = {}) => ({
  id: intent.transferId, state: "PAID", rail: "sepa", receiveEur: intent.amountEur, recipientIban: "…3000",
  reference: co.transferReference(intent), updatedAt: NOW, ...over,
});

const coreError = (status: number) => Object.assign(new Error(`core API returned ${status}`), { status, body: undefined });

const quiet = { log: () => {} };

beforeEach(() => initStore(path.join(mkdtempSync(path.join(tmpdir(), "pay-settle-")), "checkout.json")));

describe("parseServiceTransfer", () => {
  it("accepts the service view and keeps only the fields settlement uses", () => {
    const parsed = st.parseServiceTransfer({ ...view({ transferId: "t1", payRef: "ZP0123456789AB", reference: "r", amountEur: 5 }), extra: "x" }, "t1");
    assert.deepEqual(Object.keys(parsed).sort(), ["id", "rail", "receiveEur", "recipientLast4", "reference", "state"]);
    assert.equal(parsed.recipientLast4, "3000");
  });

  const good = () => view({ transferId: "t1", payRef: "ZP0123456789AB", reference: "r", amountEur: 5 });
  for (const [name, over] of [
    ["a different transfer", { id: "t2" }],
    ["no state", { state: undefined }],
    ["no rail", { rail: 7 }],
    ["no amount", { receiveEur: "5" }],
    ["an infinite amount", { receiveEur: Number.POSITIVE_INFINITY }],
    ["no reference", { reference: undefined }],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.throws(() => st.parseServiceTransfer({ ...good(), ...over }, "t1"), co.CoreResponseError);
    });
  }

  it("refuses something that is not an object", () => {
    for (const raw of [null, "PAID", [good()], undefined]) {
      assert.throws(() => st.parseServiceTransfer(raw, "t1"), co.CoreResponseError);
    }
  });
});

describe("applySettlement", () => {
  it("moves an AUTHORIZED checkout to PAID when the payout is PAID", () => {
    const intent = authorized();
    assert.equal(st.applySettlement(intent.id, st.parseServiceTransfer(view(intent), "t1"), quiet), "paid");
    assert.equal(store.findPaymentIntent(intent.id)!.status, "PAID");
  });

  for (const state of ["FAILED", "REFUNDED"]) {
    it(`moves an AUTHORIZED checkout to FAILED when the payout is ${state}`, () => {
      const intent = authorized();
      assert.equal(st.applySettlement(intent.id, st.parseServiceTransfer(view(intent, { state }), "t1"), quiet), "failed");
      assert.equal(store.findPaymentIntent(intent.id)!.status, "FAILED");
    });
  }

  for (const state of ["PAYOUT_SUBMITTED", "MANUAL_REVIEW", "SOMETHING_NEW"]) {
    it(`leaves the checkout AUTHORIZED while the payout is ${state}`, () => {
      const intent = authorized();
      assert.equal(st.applySettlement(intent.id, st.parseServiceTransfer(view(intent, { state }), "t1"), quiet), "pending");
      assert.equal(store.findPaymentIntent(intent.id)!.status, "AUTHORIZED");
    });
  }

  for (const [name, over] of [
    ["a different reference", { reference: "order-77 ZP000000000000" }],
    ["a different amount", { receiveEur: 12.49 }],
    ["a different account", { recipientIban: "…3001" }],
    ["a non-SEPA rail", { rail: "cash" }],
    ["no account", { recipientIban: undefined }],
  ] as const) {
    it(`refuses to settle on ${name}`, () => {
      const intent = authorized();
      const logged: unknown[] = [];
      const outcome = st.applySettlement(intent.id, st.parseServiceTransfer(view(intent, over), "t1"), { log: (...a) => logged.push(a) });
      assert.equal(outcome, "mismatch");
      assert.equal(store.findPaymentIntent(intent.id)!.status, "AUTHORIZED");
      assert.equal(logged.length, 1);
    });
  }

  it("never touches a checkout that is not AUTHORIZED", () => {
    const intent = authorized();
    st.applySettlement(intent.id, st.parseServiceTransfer(view(intent), "t1"), quiet);
    // PAID is final here: a later FAILED does not take it back.
    assert.equal(st.applySettlement(intent.id, st.parseServiceTransfer(view(intent, { state: "FAILED" }), "t1"), quiet), "skipped");
    assert.equal(store.findPaymentIntent(intent.id)!.status, "PAID");
  });

  it("never settles a checkout from a transfer that is not the attached one", () => {
    const intent = authorized("t1");
    const other = st.parseServiceTransfer(view({ ...intent, transferId: "t2" }), "t2");
    assert.equal(st.applySettlement(intent.id, other, quiet), "skipped");
    assert.equal(store.findPaymentIntent(intent.id)!.status, "AUTHORIZED");
  });

  it("skips a checkout that no longer exists", () => {
    const intent = authorized();
    assert.equal(st.applySettlement("gone", st.parseServiceTransfer(view(intent), "t1"), quiet), "skipped");
  });
});

describe("settleIntent", () => {
  it("reads the attached transfer by its id and applies it", async () => {
    const intent = authorized();
    const asked: string[] = [];
    const outcome = await st.settleIntent(intent.id, async (id) => (asked.push(id), view(intent)), quiet);
    assert.equal(outcome, "paid");
    assert.deepEqual(asked, ["t1"]);
  });

  it("re-reads the checkout after the wait: one settled meanwhile is left alone", async () => {
    const intent = authorized();
    const outcome = await st.settleIntent(intent.id, async () => {
      store.updatePaymentIntent(intent.id, { status: "PAID" });
      return view(intent, { state: "FAILED" });
    }, quiet);
    assert.equal(outcome, "skipped");
    assert.equal(store.findPaymentIntent(intent.id)!.status, "PAID");
  });

  it("does not read at all for a checkout that is not AUTHORIZED", async () => {
    const intent = authorized();
    store.updatePaymentIntent(intent.id, { status: "PAID" });
    let reads = 0;
    assert.equal(await st.settleIntent(intent.id, async () => (reads++, view(intent)), quiet), "skipped");
    assert.equal(reads, 0);
  });

  it("treats a malformed answer as unreadable, without changing the checkout", async () => {
    const intent = authorized();
    await assert.rejects(st.settleIntent(intent.id, async () => ({ id: "t1" }), quiet), co.CoreResponseError);
    assert.equal(store.findPaymentIntent(intent.id)!.status, "AUTHORIZED");
  });
});

describe("settle poller", () => {
  const poller = (read: (id: string) => Promise<unknown>, over: Partial<Parameters<typeof st.createSettlePoller>[0]> = {}) =>
    st.createSettlePoller({ read, baseDelayMs: 30 * SEC, maxDelayMs: 3600 * SEC, batch: 50, log: () => {}, ...over });

  it("settles every AUTHORIZED checkout that is due", async () => {
    const a = authorized("t1");
    const b = authorized("t2", 7);
    const byId: Record<string, unknown> = { t1: view(a), t2: view(b, { state: "FAILED" }) };
    const result = await poller(async (id) => byId[id]).tick(Date.parse(NOW));
    assert.equal(result.checked, 2);
    assert.equal(store.findPaymentIntent(a.id)!.status, "PAID");
    assert.equal(store.findPaymentIntent(b.id)!.status, "FAILED");
  });

  it("backs off a payout that is still moving, doubling up to the cap", async () => {
    const a = authorized("t1");
    let reads = 0;
    const p = poller(async () => (reads++, view(a, { state: "PAYOUT_SUBMITTED" })), { baseDelayMs: 10 * SEC, maxDelayMs: 25 * SEC });
    const t0 = Date.parse(NOW);
    await p.tick(t0); // read 1, next in 10s
    await p.tick(t0 + 9 * SEC); // not due
    assert.equal(reads, 1);
    await p.tick(t0 + 10 * SEC); // read 2, next in 20s
    await p.tick(t0 + 29 * SEC); // not due
    assert.equal(reads, 2);
    await p.tick(t0 + 30 * SEC); // read 3, next in 25s (capped)
    await p.tick(t0 + 55 * SEC); // read 4
    assert.equal(reads, 4);
  });

  it("reads at most `batch` checkouts per tick, the longest-waiting first", async () => {
    const ids = ["t1", "t2", "t3"].map((t) => authorized(t));
    const asked: string[] = [];
    const p = poller(async (id) => (asked.push(id), view(ids.find((i) => i.transferId === id)!, { state: "PAYOUT_SUBMITTED" })), { batch: 2 });
    const t0 = Date.parse(NOW);
    await p.tick(t0);
    assert.equal(asked.length, 2);
    await p.tick(t0 + 1);
    assert.equal(asked.length, 3);
    assert.equal(new Set(asked).size, 3, "the one left out is read next, not the same two again");
  });

  for (const status of [401, 503, 429]) {
    it(`stops the tick on ${status}: the credential is the problem, not the transfer`, async () => {
      authorized("t1");
      authorized("t2", 7);
      let reads = 0;
      const logged: unknown[][] = [];
      const result = await poller(async () => {
        reads++;
        throw coreError(status);
      }, { log: (...a) => logged.push(a) }).tick(Date.parse(NOW));
      assert.equal(reads, 1);
      assert.equal(result.stopped, true);
      assert.equal(logged.length, 1);
      assert.match(String(logged[0]), new RegExp(`HTTP ${status}`));
    });
  }

  it("keeps going past one transfer that fails to read, and retries it later", async () => {
    const a = authorized("t1");
    const b = authorized("t2", 7);
    const p = poller(async (id) => {
      if (id === "t1") throw coreError(404);
      return view(b);
    });
    const t0 = Date.parse(NOW);
    const result = await p.tick(t0);
    assert.equal(result.checked, 2);
    assert.equal(store.findPaymentIntent(a.id)!.status, "AUTHORIZED");
    assert.equal(store.findPaymentIntent(b.id)!.status, "PAID");
    assert.equal(p.waiting(), 1, "the unread one is backed off, not dropped");
    assert.equal((await p.tick(t0 + 1)).checked, 0, "and not read again at once");
    assert.equal((await p.tick(t0 + 30 * SEC)).checked, 1, "but after the first wait");
  });

  it("backs off a transfer that does not match its checkout, and keeps reading it", async () => {
    const a = authorized("t1");
    const p = poller(async () => view(a, { receiveEur: 1 }));
    const t0 = Date.parse(NOW);
    await p.tick(t0);
    assert.equal(p.waiting(), 1);
    assert.equal((await p.tick(t0 + 1)).checked, 0);
  });

  it("forgets the backoff of a checkout that is no longer AUTHORIZED", async () => {
    const a = authorized("t1");
    const p = poller(async () => view(a, { state: "PAYOUT_SUBMITTED" }));
    await p.tick(Date.parse(NOW));
    assert.equal(p.waiting(), 1);
    store.updatePaymentIntent(a.id, { status: "PAID" });
    await p.tick(Date.parse(NOW) + 1);
    assert.equal(p.waiting(), 0);
  });

  it("logs a local failure as local, not as Zold being unreachable", async () => {
    authorized("t1");
    const logged: unknown[][] = [];
    await poller(async () => {
      throw new Error("ENOSPC: no space left on device");
    }, { log: (...a) => logged.push(a) }).tick(Date.parse(NOW));
    assert.match(String(logged[0]), /local error: ENOSPC/);
  });

  for (const [name, err, text] of [
    ["unreachable", new TypeError("fetch failed"), /SETTLE_STALLED Zold API unreachable/],
    ["timing out", Object.assign(new Error("x"), { name: "TimeoutError" }), /SETTLE_STALLED Zold API timed out/],
  ] as const) {
    it(`stops the tick when Zold is ${name}: fifty reads would each wait out the timeout`, async () => {
      authorized("t1");
      authorized("t2", 7);
      let reads = 0;
      const logged: unknown[][] = [];
      const result = await poller(async () => {
        reads++;
        throw err;
      }, { log: (...a) => logged.push(a) }).tick(Date.parse(NOW));
      assert.equal(reads, 1);
      assert.equal(result.stopped, true);
      assert.match(String(logged), text);
    });
  }

  it("does not mistake our own TypeError for Zold being unreachable", async () => {
    authorized("t1");
    authorized("t2", 7);
    const logged: unknown[][] = [];
    const result = await poller(async () => {
      throw new TypeError("Cannot read properties of undefined");
    }, { log: (...a) => logged.push(a) }).tick(Date.parse(NOW));
    assert.equal(result.stopped, false);
    assert.equal(result.checked, 2);
    assert.match(String(logged[0]), /local error: Cannot read/);
  });

  it("reports a stall once, every tenth stopped tick, and the recovery", async () => {
    const a = authorized("t1");
    let fail = true;
    const logged: string[] = [];
    const p = poller(async () => {
      if (fail) throw coreError(401);
      return view(a);
    }, { log: (m) => logged.push(String(m)) });
    for (let i = 0; i < 10; i++) await p.tick(Date.parse(NOW) + i);
    assert.equal(logged.filter((l) => l.startsWith("SETTLE_STALLED")).length, 2);
    assert.match(logged[1], /10 ticks stopped since 2026-10-10T10:00:00.000Z/);
    fail = false;
    await p.tick(Date.parse(NOW) + 20);
    assert.match(logged.at(-1)!, /SETTLE_RECOVERED after 10 stopped ticks/);
  });

  it("does not back off when Zold answered but our write failed: due again next tick", async () => {
    const a = authorized("t1");
    const logged: string[] = [];
    const original = store.updatePaymentIntent;
    store.updatePaymentIntent = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const p = poller(async () => view(a), { log: (m) => logged.push(String(m)) });
    try {
      await p.tick(Date.parse(NOW));
    } finally {
      store.updatePaymentIntent = original;
    }
    assert.match(logged[0], /SETTLE_STORE_WRITE_FAILED checkout .*: Zold says PAID, not saved: ENOSPC/);
    await p.tick(Date.parse(NOW) + 1);
    assert.equal(store.findPaymentIntent(a.id)!.status, "PAID");
  });

  it("reports a checkout AUTHORIZED for over a day, with Zold's last state, once a day", async () => {
    const a = authorized("t1");
    const logged: string[] = [];
    const p = poller(async () => view(a, { state: "PAYOUT_SUBMITTED" }), { log: (m) => logged.push(String(m)) });
    const created = Date.parse(a.createdAt);
    await p.tick(created + 1_000);
    assert.equal(logged.length, 0);
    await p.tick(created + 25 * 3600 * SEC);
    await p.tick(created + 30 * 3600 * SEC);
    const stuck = logged.filter((l) => l.startsWith("SETTLE_STUCK"));
    assert.equal(stuck.length, 1);
    assert.match(stuck[0], /AUTHORIZED for 25h \(Zold state PAYOUT_SUBMITTED\)/);
    await p.tick(created + 50 * 3600 * SEC);
    assert.equal(logged.filter((l) => l.startsWith("SETTLE_STUCK")).length, 2);
  });

  it("reports manual review at Zold once, not on every read", async () => {
    const a = authorized("t1");
    const logged: string[] = [];
    const p = poller(async () => view(a, { state: "MANUAL_REVIEW" }), { log: (m) => logged.push(String(m)), baseDelayMs: 1 });
    for (let i = 0; i < 4; i++) await p.tick(Date.parse(NOW) + i * 10);
    assert.equal(logged.filter((l) => l.startsWith("SETTLE_REVIEW")).length, 1);
  });

  it("reports a mismatch once per checkout, not on every read", async () => {
    const a = authorized("t1");
    const logged: string[] = [];
    const p = poller(async () => view(a, { receiveEur: 1 }), { log: (m) => logged.push(String(m)), baseDelayMs: 1 });
    for (let i = 0; i < 4; i++) await p.tick(Date.parse(NOW) + i * 10);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^SETTLE_MISMATCH checkout .*a different amount/);
  });

  it("does not run two ticks at once", async () => {
    authorized("t1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    const p = poller(async () => {
      reads++;
      await gate;
      return { id: "t1" };
    });
    const first = p.tick(Date.parse(NOW));
    try {
      const second = await p.tick(Date.parse(NOW));
      assert.equal(second.checked, 0);
    } finally {
      // Released whatever happens above, or a failing assertion leaves the first tick hanging.
      release();
    }
    await first;
    assert.equal(reads, 1, "the second tick's go-round finds nothing due: the read backed it off");
  });

  it("goes round again when a tick is asked for while one runs, so a webhook then is not lost", async () => {
    const a = authorized("t1");
    const b = authorized("t2", 7);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const states: Record<string, string> = { t1: "PAYOUT_SUBMITTED", t2: "PAYOUT_SUBMITTED" };
    const p = poller(async (id) => {
      if (id === "t1") await gate;
      return view(id === "t1" ? a : b, { state: states[id] });
    }, { batch: 1 });
    const t0 = Date.parse(NOW);
    const first = p.tick(t0);
    try {
      states.t2 = "PAID";
      assert.equal(p.nudge("t2"), true);
      await p.tick(t0); // skipped while the first runs, but asks it to go round again
    } finally {
      release();
    }
    await first;
    assert.equal(store.findPaymentIntent(b.id)!.status, "PAID");
  });

  it("forgets the backoff of a checkout that settled", async () => {
    const a = authorized("t1");
    const p = poller(async () => view(a));
    await p.tick(Date.parse(NOW));
    assert.equal(p.waiting(), 0);
  });
});

describe("FINAL states are only the three it names", () => {
  for (const state of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    it(`treats a state named ${state} as still moving, not as final`, () => {
      const intent = authorized();
      assert.equal(st.applySettlement(intent.id, st.parseServiceTransfer(view(intent, { state }), "t1"), quiet), "pending");
      assert.equal(store.findPaymentIntent(intent.id)!.status, "AUTHORIZED");
    });
  }
});

describe("sweep keeps a checkout whose payment failed after it was authorized", () => {
  it("drops a PAID or FAILED checkout after 90 days, but never an AUTHORIZED one", () => {
    const failed = authorized("t1");
    st.applySettlement(failed.id, st.parseServiceTransfer(view(failed, { state: "FAILED" }), "t1"), quiet);
    const waiting = authorized("t2", 7);
    store.sweep(Date.parse(failed.createdAt) + 91 * 24 * 3600 * SEC);
    assert.equal(store.findPaymentIntent(failed.id), undefined);
    assert.equal(store.findPaymentIntent(waiting.id)?.status, "AUTHORIZED");
  });

  it("does not drop a FAILED checkout that has a transfer, so the merchant can still read it", () => {
    const intent = authorized();
    st.applySettlement(intent.id, st.parseServiceTransfer(view(intent, { state: "FAILED" }), "t1"), quiet);
    store.sweep(Date.now() + 48 * 3600 * SEC);
    assert.equal(store.findPaymentIntent(intent.id)?.status, "FAILED");
  });
});

describe("poller nudge (the webhook)", () => {
  it("is not overwritten by a read that was already in flight with the old state", async () => {
    const a = authorized("t1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let state = "PAYOUT_SUBMITTED";
    let reads = 0;
    const p = st.createSettlePoller({
      read: async () => {
        reads++;
        const answer = view(a, { state });
        if (reads === 1) await gate;
        return answer;
      },
      baseDelayMs: 30 * SEC, maxDelayMs: 3600 * SEC, batch: 50, log: () => {},
    });
    const t0 = Date.parse(NOW);
    const first = p.tick(t0);
    try {
      state = "PAID";
      p.nudge("t1"); // arrives while the read with PAYOUT_SUBMITTED is in flight
    } finally {
      release();
    }
    await first; // that read backs off... unless the nudge survives it
    await p.tick(t0 + 1);
    assert.equal(store.findPaymentIntent(a.id)!.status, "PAID");
  });

  const poller = (read: (id: string) => Promise<unknown>) =>
    st.createSettlePoller({ read, baseDelayMs: 30 * SEC, maxDelayMs: 3600 * SEC, batch: 50, log: () => {} });

  it("makes a backed-off checkout due at once", async () => {
    const a = authorized("t1");
    let state = "PAYOUT_SUBMITTED";
    const p = poller(async () => view(a, { state }));
    const t0 = Date.parse(NOW);
    await p.tick(t0);
    state = "PAID";
    assert.equal(p.nudge("t1"), true);
    await p.tick(t0 + 1);
    assert.equal(store.findPaymentIntent(a.id)!.status, "PAID");
  });

  it("says no, and changes nothing, for a transfer no AUTHORIZED checkout has", async () => {
    const a = authorized("t1");
    const p = poller(async () => view(a, { state: "PAYOUT_SUBMITTED" }));
    await p.tick(Date.parse(NOW));
    assert.equal(p.nudge("unknown"), false);
    store.updatePaymentIntent(a.id, { status: "PAID" });
    assert.equal(p.nudge("t1"), false);
  });
});

describe("zoldTransferReader", () => {
  it("reads Zold's checkout-service route with the service token as a bearer", async () => {
    zoldRequests.length = 0;
    const body = await st.zoldTransferReader("zsc_test")("t9");
    assert.deepEqual(body, { id: "t9", state: "PAID" });
    assert.deepEqual(zoldRequests, [{ url: "/api/service/checkout/transfers/t9", authorization: "Bearer zsc_test" }]);
  });

  it("escapes the id into one path segment", async () => {
    zoldRequests.length = 0;
    await st.zoldTransferReader("zsc_test")("a/b").catch(() => {});
    assert.equal(zoldRequests[0]?.url, "/api/service/checkout/transfers/a%2Fb");
  });
});
