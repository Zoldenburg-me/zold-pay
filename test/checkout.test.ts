import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { CoreTransfer } from "../server/src/checkout.js";

process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";

const { hashSecret } = await import("../server/src/secrets.js");
const { ATTACH_GRACE_MS, INTENT_TTL_MS, initStore, store } = await import("../server/src/store.js");
const co = await import("../server/src/checkout.js");

const IBAN = "DE89370400440532013000";
const OTHER_IBAN = "GB82WEST12345698765432";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const NOW = "2026-10-09T10:00:00.000Z";
const MIN = 60_000;

const merchantRecord = (id: string, clientId: string, secret: string, redirectUris = ["https://shop.test/cb"]) => ({
  id, name: id, clientId, clientSecretHash: hashSecret(secret), settlementIbans: [IBAN], redirectUris, createdAt: NOW,
});

const intentArgs = (over: Record<string, unknown> = {}) => ({
  amountEur: 12.5, reference: "order-77", redirectUri: "https://shop.test/cb", state: "st", codeChallenge: CHALLENGE, ...over,
});

function setup() {
  initStore(path.join(mkdtempSync(path.join(tmpdir(), "pay-co-")), "checkout.json"));
  const merchant = store.addMerchant(merchantRecord("m1", "shop", "s3cret"));
  const intent = co.createIntent(merchant, intentArgs());
  return { merchant, intent };
}

/** A settled SEPA transfer that pays `intent` exactly, the way the checkout page creates it. */
const transfer = (intent: { payRef: string; reference: string }, over: Partial<CoreTransfer> = {}): CoreTransfer => ({
  id: "t1", userId: "u1", rail: "sepa", state: "PAYOUT_SUBMITTED", recipientIban: IBAN, receiveEur: 12.5,
  reference: co.transferReference(intent), ...over,
});

const attach = (id: string, over: Partial<CoreTransfer> = {}, name?: string) =>
  co.attachTransfer(id, transfer(store.findPaymentIntent(id)!, over), name);

const codeOf = (redirectUrl: string) => new URL(redirectUrl).searchParams.get("code")!;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as InstanceType<typeof co.CheckoutError>;
  }
  assert.fail("expected a refusal");
};

describe("client credentials", () => {
  beforeEach(() => void setup());
  it("accepts the right secret and rejects wrong or non-string input", () => {
    const m = store.findMerchantByClientId("shop")!;
    assert.equal(co.clientSecretMatches(m, "s3cret"), true);
    assert.equal(co.clientSecretMatches(m, "nope"), false);
    assert.equal(co.clientSecretMatches(m, undefined), false);
    assert.equal(co.clientSecretMatches(m, 123), false);
  });
});

describe("destination and redirect allowlists", () => {
  const merchant = merchantRecord("m", "m", "s", ["https://shop.test/cb"]);
  it("resolves the default, a named account in any spacing or case, and refuses anything else", () => {
    assert.equal(co.resolveDestination(merchant), IBAN);
    assert.equal(co.resolveDestination(merchant, "de89 3704 0044 0532 0130 00"), IBAN);
    assert.throws(() => co.resolveDestination(merchant, OTHER_IBAN), { message: /not a registered settlement account/ });
    assert.throws(() => co.resolveDestination({ ...merchant, settlementIbans: [] }), { message: /no registered settlement account/ });
  });

  it("allows only the exact registered redirect URIs", () => {
    assert.equal(co.redirectAllowed(merchant, "https://shop.test/cb"), true);
    for (const bad of ["https://evil.test/cb", "https://shop.test/cb/", "https://shop.test/cb?x=1", "http://shop.test/cb", ""]) {
      assert.equal(co.redirectAllowed(merchant, bad), false, bad);
    }
  });
});

describe("attachTransfer", () => {
  it("mints a one-time code and stores only its hash", () => {
    const { intent } = setup();
    const { redirectUrl } = attach(intent.id, {}, "Ada Lovelace");
    const url = new URL(redirectUrl);
    const code = codeOf(redirectUrl);
    assert.equal(url.searchParams.get("state"), "st");
    const stored = store.findPaymentIntent(intent.id)!;
    assert.equal((stored as any).code, undefined);
    assert.equal(stored.codeHash, hashSecret(code));
    assert.equal(stored.userId, "u1");
    assert.ok(stored.codeExpiresAt && Date.parse(stored.codeExpiresAt) > Date.now());
  });

  const refusals: Array<[string, Partial<CoreTransfer>, string]> = [
    ["a non-SEPA rail", { rail: "cash" }, "checkout transfer must be a SEPA payout"],
    ["a different destination account", { recipientIban: OTHER_IBAN }, "transfer does not pay the account this checkout was created for"],
    ["a different amount", { receiveEur: 12 }, "transfer amount does not match the checkout"],
    ["a transfer that reports no amount", { receiveEur: undefined }, "transfer amount does not match the checkout"],
    ["an amount off by a cent", { receiveEur: 12.51 }, "transfer amount does not match the checkout"],
    ["an unauthorised transfer", { state: "CREATED" }, "transfer not settled (state CREATED)"],
    ["a cash-rail-only state", { state: "PAYOUT_READY" }, "transfer not settled (state PAYOUT_READY)"],
    ["a failed transfer", { state: "FAILED" }, "transfer failed"],
    ["a refunded transfer", { state: "REFUNDED" }, "transfer refunded"],
    ["a transfer in manual review", { state: "MANUAL_REVIEW" }, "transfer is in manual review"],
    ["another checkout's payment reference", { reference: "order-77 ZP000000000000" }, "transfer payment reference does not match the checkout"],
    ["a transfer with no reference", { reference: undefined }, "transfer payment reference does not match the checkout"],
    ["the merchant's bare reference, which anyone could have paid earlier", { reference: "order-77" }, "transfer payment reference does not match the checkout"],
  ];
  for (const [name, over, message] of refusals) {
    it(`refuses ${name}`, () => {
      const { intent } = setup();
      assert.throws(() => attach(intent.id, over), { message });
      assert.equal(store.findPaymentIntent(intent.id)!.codeHash, undefined, "no code may be minted");
      assert.equal(store.findPaymentIntent(intent.id)!.status, "PENDING");
    });
  }

  it("treats a transfer that is not settled yet as retryable, and a failed one as final", () => {
    const { intent } = setup();
    const pending = refusal(() => attach(intent.id, { state: "CREATED" }));
    assert.equal(pending.status, 409);
    assert.equal(pending.retryable, true);
    const failed = refusal(() => attach(intent.id, { state: "FAILED" }));
    assert.equal(failed.status, 400);
    assert.equal(failed.retryable, false);
  });

  it("binds a checkout with no merchant reference to its own unique reference, so an older payment cannot be replayed", () => {
    const { merchant } = setup();
    const bare = co.createIntent(merchant, intentArgs({ reference: "" }));
    assert.match(bare.payRef, /^ZP[0-9A-F]{12}$/);
    assert.equal(co.transferReference(bare), bare.payRef);
    assert.throws(() => attach(bare.id, { id: "t-old", reference: undefined }), { message: /reference/ });
    assert.throws(() => attach(bare.id, { id: "t-old", reference: "" }), { message: /reference/ });
    assert.doesNotThrow(() => attach(bare.id));
  });

  it("gives every checkout its own reference, and keeps the merchant's inside it", () => {
    const { merchant, intent } = setup();
    const other = co.createIntent(merchant, intentArgs());
    assert.notEqual(intent.payRef, other.payRef);
    assert.equal(co.transferReference(intent), `order-77 ${intent.payRef}`);
    assert.ok(co.transferReference({ reference: "r".repeat(120), payRef: intent.payRef }).length <= 140, "must fit a SEPA remittance line");
  });

  it("marks the intent PAID when the payout is already complete, else AUTHORIZED", () => {
    const a = setup().intent;
    attach(a.id, { state: "PAID" });
    assert.equal(store.findPaymentIntent(a.id)!.status, "PAID");
    const b = setup().intent;
    attach(b.id, { state: "PAYOUT_SUBMITTED" });
    assert.equal(store.findPaymentIntent(b.id)!.status, "AUTHORIZED");
  });

  it("refuses an unknown checkout and one whose merchant is gone", () => {
    const { intent } = setup();
    assert.throws(() => co.attachTransfer("nope", transfer(intent)), { message: "unknown checkout" });
    initStore(path.join(mkdtempSync(path.join(tmpdir(), "pay-co-")), "checkout.json"));
    store.addPaymentIntent({ ...intent });
    assert.throws(() => attach(intent.id), { message: "merchant not found" });
  });

  it("refuses a different transfer once the checkout is authorized", () => {
    const { intent } = setup();
    attach(intent.id);
    const before = store.findPaymentIntent(intent.id)!.codeHash;
    assert.throws(() => attach(intent.id, { id: "t2" }), { message: "intent already authorized" });
    assert.equal(store.findPaymentIntent(intent.id)!.codeHash, before, "the first code is untouched");
  });
});

describe("attachTransfer retries and timing", () => {
  it("is idempotent for the same transfer: a lost response can be recovered with a fresh code", () => {
    const { intent } = setup();
    const first = codeOf(attach(intent.id, {}, "Ada Lovelace").redirectUrl);
    const second = codeOf(attach(intent.id, {}, "Ada Lovelace").redirectUrl);
    assert.notEqual(first, second);
    assert.throws(() => co.exchangeCode("shop", "s3cret", first, VERIFIER), { message: "unknown or used code" });
    assert.equal(co.exchangeCode("shop", "s3cret", second, VERIFIER).status, "AUTHORIZED");
    assert.equal(store.findPaymentIntent(intent.id)!.transferId, "t1");
  });

  it("keeps a PAID checkout PAID when the same transfer is attached again", () => {
    const { intent } = setup();
    attach(intent.id, { state: "PAID" });
    attach(intent.id, { state: "PAID" });
    assert.equal(store.findPaymentIntent(intent.id)!.status, "PAID");
  });

  it("refuses a retry once the merchant has exchanged the code", () => {
    const { intent } = setup();
    co.exchangeCode("shop", "s3cret", codeOf(attach(intent.id).redirectUrl), VERIFIER);
    assert.throws(() => attach(intent.id), { message: "checkout already completed" });
    assert.equal(store.findPaymentIntent(intent.id)!.codeHash, undefined, "no new code after the exchange");
  });

  it("does not let a different user retry someone else's attached transfer", () => {
    const { intent } = setup();
    attach(intent.id);
    assert.throws(() => attach(intent.id, { userId: "u2" }), { message: "intent already authorized" });
  });

  it("still accepts a payment that finished a little after the checkout's own time limit", () => {
    const { intent } = setup();
    store.updatePaymentIntent(intent.id, { createdAt: ago(INTENT_TTL_MS + 5 * MIN) });
    assert.ok(ATTACH_GRACE_MS > 5 * MIN);
    assert.doesNotThrow(() => attach(intent.id));
  });

  it("refuses, and marks the checkout expired, once the grace period is also over", () => {
    const { intent } = setup();
    store.updatePaymentIntent(intent.id, { createdAt: ago(INTENT_TTL_MS + ATTACH_GRACE_MS + MIN) });
    assert.throws(() => attach(intent.id), { message: "checkout expired" });
    assert.equal(store.findPaymentIntent(intent.id)!.status, "EXPIRED");
  });

  it("refuses when the intent's pinned destination is empty or the transfer names no recipient", () => {
    const { intent } = setup();
    store.updatePaymentIntent(intent.id, { destinationIban: "" });
    assert.throws(() => attach(intent.id, { recipientIban: undefined }), { message: /account/ });
    assert.throws(() => attach(intent.id, { recipientIban: "" }), { message: /account/ });
  });
});

describe("parseCoreTransfer", () => {
  const good = { id: "t1", userId: "u1", rail: "sepa", state: "PAID", recipientIban: IBAN, receiveEur: 12.5, reference: "r" };
  it("accepts the shape the core returns", () => {
    assert.deepEqual(co.parseCoreTransfer(good, "t1"), good);
  });
  it("refuses anything that cannot be trusted to decide a payment", () => {
    const bad: Array<[string, unknown]> = [
      ["not an object", "oops"],
      ["null", null],
      ["a different transfer id", { ...good, id: "t2" }],
      ["no id", { ...good, id: undefined }],
      ["no amount", { ...good, receiveEur: undefined }],
      ["a non-finite amount", { ...good, receiveEur: Number.NaN }],
      ["a string amount", { ...good, receiveEur: "12.5" }],
      ["a user id that is not a plain id", { ...good, userId: "../x" }],
      ["no user id", { ...good, userId: undefined }],
      ["no state", { ...good, state: undefined }],
    ];
    for (const [name, raw] of bad) {
      assert.throws(() => co.parseCoreTransfer(raw, "t1"), co.CoreResponseError, name);
    }
  });
});

describe("exchangeCode and status", () => {
  function attached() {
    const { intent } = setup();
    return { intent, code: codeOf(attach(intent.id, {}, "Ada Lovelace").redirectUrl) };
  }

  it("exchanges the code once, returning the payer name only in that response", () => {
    const { intent, code } = attached();
    const out = co.exchangeCode("shop", "s3cret", code, VERIFIER);
    assert.equal(out.payer?.name, "Ada Lovelace");
    assert.ok(out.payer?.sub);
    assert.equal(store.findPaymentIntent(intent.id)!.payerName, undefined);
    assert.throws(() => co.exchangeCode("shop", "s3cret", code, VERIFIER), { message: "unknown or used code" });
  });

  it("stores only a hash of the status token and lets the merchant poll without the name", () => {
    const { intent, code } = attached();
    const { statusToken } = co.exchangeCode("shop", "s3cret", code, VERIFIER);
    const stored = store.findPaymentIntent(intent.id)!;
    assert.equal((stored as any).statusToken, undefined);
    assert.equal(stored.statusTokenHash, hashSecret(statusToken));
    const polled = co.statusByToken(intent.id, statusToken);
    assert.equal(polled.payer?.name, undefined);
    assert.ok(polled.payer?.sub);
    assert.throws(() => co.statusByToken(intent.id, "wrong"), /bad token/);
  });

  it("rejects a wrong secret and a wrong verifier, without burning the code", () => {
    const { code } = attached();
    assert.throws(() => co.exchangeCode("shop", "bad", code, VERIFIER), { message: "bad client credentials" });
    assert.throws(() => co.exchangeCode("shop", "s3cret", code, "x".repeat(43)), { message: "PKCE verification failed" });
    assert.equal(co.exchangeCode("shop", "s3cret", code, VERIFIER).status, "AUTHORIZED");
  });

  it("burns an expired code and drops the payer name it guarded", () => {
    const { intent, code } = attached();
    store.updatePaymentIntent(intent.id, { codeExpiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.throws(() => co.exchangeCode("shop", "s3cret", code, VERIFIER), { message: "code expired" });
    assert.equal(store.findPaymentIntent(intent.id)!.payerName, undefined);
    assert.throws(() => co.exchangeCode("shop", "s3cret", code, VERIFIER), { message: "unknown or used code" });
  });

  it("will not hand one merchant's code to another merchant, even with that merchant's own credentials", () => {
    const { intent, code } = attached();
    store.addMerchant(merchantRecord("m2", "other", "other-secret"));
    assert.throws(() => co.exchangeCode("other", "other-secret", code, VERIFIER), { message: "unknown or used code" });
    assert.equal(co.exchangeCode("shop", "s3cret", code, VERIFIER).intentId, intent.id, "the owner can still exchange it");
  });
});

describe("one transfer, one checkout", () => {
  it("refuses a transfer that already paid another checkout, so one payment cannot mint many codes", () => {
    const { merchant, intent } = setup();
    attach(intent.id, {}, "Ada");
    const other = co.createIntent(merchant, intentArgs({ state: "st2" }));
    // The same transfer, carrying the OTHER checkout's reference so only the reuse check can stop it.
    assert.throws(() => attach(other.id, { reference: co.transferReference(other) }), { message: "this transfer already paid another checkout" });
    assert.equal(store.findPaymentIntent(other.id)!.codeHash, undefined);
  });
});

describe("pending checkout caps", () => {
  const make = (merchant: any, cap: number, channel?: "front" | "back") =>
    co.createIntent(merchant, intentArgs({ amountEur: 1, reference: "", state: "", ...(channel ? { channel } : {}) }), cap);

  it("caps pending checkouts per merchant", () => {
    const { merchant } = setup(); // one pending already
    make(merchant, 3);
    make(merchant, 3);
    assert.throws(() => make(merchant, 3), { message: /too many pending/ });
  });

  it("does not count checkouts past their time limit, so abandoned ones cannot lock a merchant out", () => {
    const { merchant, intent } = setup();
    make(merchant, 2);
    assert.throws(() => make(merchant, 2), { message: /too many pending/ });
    store.updatePaymentIntent(intent.id, { createdAt: ago(INTENT_TTL_MS + MIN) });
    assert.doesNotThrow(() => make(merchant, 2));
  });

  it("counts the unauthenticated front channel on its own, so it cannot crowd out the authenticated back channel", () => {
    const { merchant } = setup(); // one back-channel checkout
    make(merchant, 2, "front");
    make(merchant, 2, "front");
    assert.throws(() => make(merchant, 2, "front"), { message: /too many pending/ });
    assert.doesNotThrow(() => make(merchant, 3, "back"), "the back channel is unaffected by a full front channel");
  });
});

describe("production merchant check", () => {
  const m = (redirectUris: string[]) => merchantRecord("x", "x", "h", redirectUris);
  it("refuses a wildcard redirect URI outside the local demo", () => {
    assert.throws(() => co.assertNoWildcardRedirects([m(["https://ok.test/cb"]), m(["*"])]), /wildcard/);
    assert.doesNotThrow(() => co.assertNoWildcardRedirects([m(["https://ok.test/cb"])]));
  });
});
