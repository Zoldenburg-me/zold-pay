import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    // Made for this checkout, so it is a second payment: refused, and recorded for a refund.
    assert.equal(refusal(() => attach(intent.id, { id: "t2" })).code, "duplicate_payment");
    // Not made for this checkout: plainly refused.
    assert.equal(refusal(() => attach(intent.id, { id: "t3", receiveEur: 1 })).code, "checkout_closed");
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
    // Refused, but the settled payment is recorded for a refund rather than lost.
    assert.equal(refusal(() => attach(intent.id)).code, "late_payment");
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

/** A claim token as the page makes it: 32 random bytes, base64url. */
const newClaimToken = () => randomBytes(32).toString("base64url");

/**
 * Two tabs (or two devices) that both load an open checkout must not both be able to
 * pay it: the second payment would reach the merchant, and a SEPA payout cannot be
 * recalled. So the page claims the checkout BEFORE any core transfer exists, and only
 * the claim holder may go on to pay. The page makes the claim token itself and keeps
 * it before asking, so a lost answer can be retried with the same token.
 */
describe("claiming a checkout before paying", () => {
  let intentId: string;
  beforeEach(() => void (intentId = setup().intent.id));

  it("moves an open checkout to PAYING for one payer, storing only a hash of the page's token", () => {
    const token = newClaimToken();
    co.claimIntent(intentId, "u1", token);
    const saved = store.findPaymentIntent(intentId)!;
    assert.equal(saved.status, "PAYING");
    assert.equal(saved.claimUserId, "u1");
    assert.equal(saved.claimTokenHash, hashSecret(token));
    assert.equal(JSON.stringify(saved).includes(token), false);
  });

  it("refuses a second claim from another tab of the same payer, and from another payer", () => {
    co.claimIntent(intentId, "u1", newClaimToken());
    for (const [user, token] of [["u1", newClaimToken()], ["u2", newClaimToken()]] as const) {
      const e = refusal(() => co.claimIntent(intentId, user, token));
      assert.equal(e.code, "payment_in_progress");
      assert.equal(e.status, 409);
    }
  });

  it("lets the holder claim again with its token, so a lost answer does not lock the checkout", () => {
    const token = newClaimToken();
    co.claimIntent(intentId, "u1", token);
    co.claimIntent(intentId, "u1", token);
    assert.equal(store.findPaymentIntent(intentId)!.status, "PAYING");
    assert.equal(refusal(() => co.claimIntent(intentId, "u2", token)).code, "payment_in_progress");
  });

  it("refuses the holder's resume once the checkout is past its time limit", () => {
    const token = newClaimToken();
    co.claimIntent(intentId, "u1", token);
    store.updatePaymentIntent(intentId, { createdAt: ago(INTENT_TTL_MS + MIN) });
    assert.equal(refusal(() => co.claimIntent(intentId, "u1", token)).code, "checkout_expired");
    assert.equal(refusal(() => co.claimIntent(intentId, "u2", newClaimToken())).code, "payment_in_progress");
  });

  it("refuses to claim a checkout that is already paid, expired, or unknown", () => {
    co.claimIntent(intentId, "u1", newClaimToken());
    attach(intentId);
    assert.equal(refusal(() => co.claimIntent(intentId, "u1", newClaimToken())).code, "checkout_closed");

    const late = setup().intent.id;
    store.updatePaymentIntent(late, { createdAt: ago(INTENT_TTL_MS + MIN) });
    assert.equal(refusal(() => co.claimIntent(late, "u1", newClaimToken())).code, "checkout_expired");

    assert.equal(refusal(() => co.claimIntent("nope", "u1", newClaimToken())).code, "unknown_checkout");
  });

  it("releases a claim back to PENDING only for the token holder, and only before a payment is attached", () => {
    const token = newClaimToken();
    co.claimIntent(intentId, "u1", token);
    assert.equal(refusal(() => co.releaseClaim(intentId, "wrong")).code, "not_claim_holder");
    co.releaseClaim(intentId, token);
    const released = store.findPaymentIntent(intentId)!;
    assert.equal(released.status, "PENDING");
    assert.equal(released.claimUserId, undefined);
    assert.equal(released.claimTokenHash, undefined);

    const again = newClaimToken();
    co.claimIntent(intentId, "u2", again);
    attach(intentId, { userId: "u2" });
    assert.equal(refusal(() => co.releaseClaim(intentId, again)).code, "checkout_closed");
  });

  it("attaches the claim holder's payment and clears the claim", () => {
    co.claimIntent(intentId, "u1", newClaimToken());
    assert.ok(codeOf(attach(intentId).redirectUrl));
    const saved = store.findPaymentIntent(intentId)!;
    assert.equal(saved.status, "AUTHORIZED");
    assert.equal(saved.claimUserId, undefined);
    assert.equal(saved.claimTokenHash, undefined);
    assert.equal(saved.claimedAt, undefined);
  });

  it("attaches a payment made after the claim was released and taken again by the same payer", () => {
    co.claimIntent(intentId, "u1", "a".repeat(43));
    co.releaseClaim(intentId, "a".repeat(43));
    assert.ok(codeOf(attach(intentId).redirectUrl), "a released checkout is PENDING, and PENDING can be attached");
  });

  it("still counts a claimed checkout as open for the pending cap, and keeps it a day", () => {
    const merchantId = store.findPaymentIntent(intentId)!.merchantId;
    co.claimIntent(intentId, "u1", newClaimToken());
    assert.equal(store.pendingCount(merchantId), 1);
    // A claimed checkout may have money in flight, so it outlives an abandoned open one.
    store.updatePaymentIntent(intentId, { createdAt: ago(2 * 60 * MIN) });
    store.sweep();
    assert.ok(store.findPaymentIntent(intentId), "kept while a payment may still arrive");
    store.updatePaymentIntent(intentId, { createdAt: ago(25 * 60 * MIN) });
    store.sweep();
    assert.equal(store.findPaymentIntent(intentId), undefined);
  });
});

/**
 * A payment made for a checkout that cannot be attached to it: a second payment
 * for a paid checkout, a payment by someone who does not hold the claim, or one
 * that arrived after the checkout closed. The money has left the payer and SEPA
 * cannot be recalled by us, so it is recorded on the checkout, never dropped.
 */
describe("payments that cannot be attached", () => {
  let intentId: string;
  beforeEach(() => void (intentId = setup().intent.id));
  const recorded = () => store.findPaymentIntent(intentId)!.unattachedPayments ?? [];

  it("records a second settled payment for a paid checkout once, with its state, and shows it to the merchant", () => {
    co.claimIntent(intentId, "u1", newClaimToken());
    attach(intentId);
    const dup = refusal(() => attach(intentId, { id: "t2", userId: "u2" }));
    assert.equal(dup.code, "duplicate_payment");
    assert.equal(dup.status, 409);
    refusal(() => attach(intentId, { id: "t2", userId: "u2" }));
    assert.equal(recorded().length, 1);
    const [entry] = recorded();
    assert.equal(entry.transferId, "t2");
    assert.equal(entry.reason, "duplicate");
    assert.equal(entry.state, "PAYOUT_SUBMITTED");
    assert.ok(Number.isFinite(Date.parse(entry.recordedAt)));
    assert.deepEqual(co.merchantView(store.findPaymentIntent(intentId)!).unattachedPayments, [
      { transferId: "t2", amountEur: 12.5, reason: "duplicate", state: "PAYOUT_SUBMITTED", recordedAt: entry.recordedAt },
    ]);
    assert.equal(store.findPaymentIntent(intentId)!.transferId, "t1", "the first payment still backs the checkout");
  });

  it("records a payment by someone who does not hold the claim, and the holder can still finish", () => {
    co.claimIntent(intentId, "u1", newClaimToken());
    assert.equal(refusal(() => attach(intentId, { id: "t9", userId: "u2" })).code, "duplicate_payment");
    assert.equal(store.findPaymentIntent(intentId)!.status, "PAYING");
    assert.equal(recorded()[0].reason, "claimed_by_another");
    assert.ok(codeOf(attach(intentId).redirectUrl));
  });

  it("records the claim holder's settled payment that arrives after the attach window, instead of losing it", () => {
    co.claimIntent(intentId, "u1", newClaimToken());
    store.updatePaymentIntent(intentId, { createdAt: ago(INTENT_TTL_MS + ATTACH_GRACE_MS + MIN) });
    const e = refusal(() => attach(intentId));
    assert.equal(e.code, "late_payment");
    assert.equal(store.findPaymentIntent(intentId)!.status, "EXPIRED");
    assert.equal(recorded()[0].reason, "late");
    // An expired checkout holding a recorded payment is not swept with the abandoned ones.
    store.sweep(Date.now() + 2 * 60 * MIN);
    assert.ok(store.findPaymentIntent(intentId));
  });

  it("records a settled payment for a checkout that had already expired", () => {
    store.updatePaymentIntent(intentId, { status: "EXPIRED" });
    assert.equal(refusal(() => attach(intentId, { id: "t5" })).code, "late_payment");
    assert.equal(recorded()[0].transferId, "t5");
  });

  it("does not record a late payment that has not settled, or that was not made for this checkout", () => {
    store.updatePaymentIntent(intentId, { createdAt: ago(INTENT_TTL_MS + ATTACH_GRACE_MS + MIN) });
    assert.equal(refusal(() => attach(intentId, { state: "PAYOUT_PENDING" })).code, "checkout_expired");
    assert.equal(refusal(() => attach(intentId, { receiveEur: 1 })).code, "checkout_expired");
    assert.deepEqual(recorded(), []);
  });

  it("does not record a second transfer that has not moved money, and asks the page to retry", () => {
    co.claimIntent(intentId, "u1", newClaimToken());
    attach(intentId);
    for (const state of ["CREATED", "PAYOUT_PENDING"]) {
      const e = refusal(() => attach(intentId, { id: "t-draft", userId: "u2", state }));
      assert.equal(e.code, "not_settled");
      assert.equal(e.retryable, true);
    }
    assert.deepEqual(recorded(), []);
  });

  it("does not record a failed second transfer, or one not made for this checkout", () => {
    co.claimIntent(intentId, "u1", newClaimToken());
    attach(intentId);
    assert.equal(refusal(() => attach(intentId, { id: "t3", userId: "u2", state: "FAILED" })).code, "checkout_closed");
    assert.equal(refusal(() => attach(intentId, { id: "t4", userId: "u2", receiveEur: 99 })).code, "checkout_closed");
    assert.deepEqual(recorded(), []);
  });

  it(`keeps at most ${co.MAX_UNATTACHED_PAYMENTS} records, flags the rest, and never counts a retry twice`, () => {
    co.claimIntent(intentId, "u1", newClaimToken());
    attach(intentId);
    for (let n = 0; n <= co.MAX_UNATTACHED_PAYMENTS; n++) refusal(() => attach(intentId, { id: `d${n}`, userId: "u2" }));
    refusal(() => attach(intentId, { id: "d0", userId: "u2" }));
    const saved = store.findPaymentIntent(intentId)!;
    assert.equal(saved.unattachedPayments!.length, co.MAX_UNATTACHED_PAYMENTS);
    assert.equal(saved.unattachedPaymentsTruncated, true);
    assert.equal(co.merchantView(saved).unattachedPaymentsTruncated, true);
  });
});

describe("compatibility", () => {
  it("keeps the payer subject issued before this change (NUL-separated HMAC input)", () => {
    // Computed by main's payerSubject with CHECKOUT_SUBJECT_SECRET=test-subject-secret.
    assert.equal(co.payerSubject("m1", "u1"), "O5e7okxICZOuRcM2lTKHyU9Pr16daW2t");
  });

  it("claims and attaches a checkout loaded from a file written before claims existed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pay-legacy-"));
    const file = path.join(dir, "checkout.json");
    const legacyIntent = {
      id: "legacy-1", merchantId: "m1", amountEur: 12.5, reference: "order-77", payRef: "ZP0123456789AB",
      destinationIban: IBAN, redirectUri: "https://shop.test/cb", state: "st", codeChallenge: CHALLENGE,
      status: "PENDING", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify({ merchants: [merchantRecord("m1", "shop", "s3cret")], paymentIntents: [legacyIntent] }));
    initStore(file);
    co.claimIntent("legacy-1", "u1", newClaimToken());
    assert.ok(codeOf(attach("legacy-1").redirectUrl));
  });
});
