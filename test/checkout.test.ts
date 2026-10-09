import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";

const { hashSecret } = await import("../server/src/secrets.js");
const { initStore, store } = await import("../server/src/store.js");
const co = await import("../server/src/checkout.js");

const IBAN = "DE89370400440532013000";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const NOW = "2026-10-09T10:00:00.000Z";

function setup() {
  initStore(path.join(mkdtempSync(path.join(tmpdir(), "pay-co-")), "checkout.json"));
  const merchant = store.addMerchant({
    id: "m1", name: "Shop", clientId: "shop", clientSecretHash: hashSecret("s3cret"),
    settlementIbans: [IBAN], redirectUris: ["https://shop.test/cb"], createdAt: NOW,
  });
  const intent = co.createIntent(merchant, {
    amountEur: 12.5, reference: "order-77", redirectUri: "https://shop.test/cb", state: "st", codeChallenge: CHALLENGE,
  });
  return { merchant, intent };
}

const transfer = (over: Partial<co.CoreTransfer> = {}): co.CoreTransfer => ({
  id: "t1", userId: "u1", rail: "sepa", state: "PAYOUT_SUBMITTED", recipientIban: IBAN, receiveEur: 12.5,
  reference: "order-77", ...over,
});

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

describe("attachTransfer", () => {
  it("mints a one-time code and stores only its hash", () => {
    const { intent } = setup();
    const { redirectUrl } = co.attachTransfer(intent, "u1", transfer(), "Ada Lovelace");
    const url = new URL(redirectUrl);
    const code = url.searchParams.get("code")!;
    assert.equal(url.searchParams.get("state"), "st");
    const stored = store.findPaymentIntent(intent.id)!;
    assert.equal((stored as any).code, undefined);
    assert.equal(stored.codeHash, hashSecret(code));
    assert.ok(stored.codeExpiresAt && Date.parse(stored.codeExpiresAt) > Date.now());
  });

  const refusals: Array<[string, Partial<co.CoreTransfer>, RegExp]> = [
    ["a transfer owned by someone else", { userId: "u2" }, /does not belong/],
    ["a non-SEPA rail", { rail: "cash" }, /SEPA/],
    ["a different destination account", { recipientIban: "GB82WEST12345698765432" }, /account/],
    ["a different amount", { receiveEur: 12 }, /amount/],
    ["an unauthorised transfer", { state: "CREATED" }, /not settled/],
    ["a cash-rail-only state", { state: "PAYOUT_READY" }, /not settled/],
    ["a failed transfer", { state: "FAILED" }, /failed|not settled/],
    ["a refunded transfer", { state: "REFUNDED" }, /refunded|not settled/],
    ["a transfer in manual review", { state: "MANUAL_REVIEW" }, /review|not settled/],
    ["a different payment reference", { reference: "someone-elses-order" }, /reference/],
    ["a transfer with no reference when the intent has one", { reference: undefined }, /reference/],
  ];
  for (const [name, over, message] of refusals) {
    it(`refuses ${name}`, () => {
      const { intent } = setup();
      assert.throws(() => co.attachTransfer(intent, "u1", transfer(over)), message);
      assert.equal(store.findPaymentIntent(intent.id)!.codeHash, undefined);
    });
  }

  it("does not require a reference match when the intent has none", () => {
    const { merchant } = setup();
    const bare = co.createIntent(merchant, {
      amountEur: 12.5, reference: "", redirectUri: "https://shop.test/cb", state: "st", codeChallenge: CHALLENGE,
    });
    assert.doesNotThrow(() => co.attachTransfer(bare, "u1", transfer({ reference: undefined })));
  });

  it("marks the intent PAID when the payout is already complete, else AUTHORIZED", () => {
    const a = setup().intent;
    co.attachTransfer(a, "u1", transfer({ state: "PAID" }));
    assert.equal(store.findPaymentIntent(a.id)!.status, "PAID");
    const b = setup().intent;
    co.attachTransfer(b, "u1", transfer({ state: "PAYOUT_SUBMITTED" }));
    assert.equal(store.findPaymentIntent(b.id)!.status, "AUTHORIZED");
  });
});

describe("exchangeCode and status", () => {
  function attached() {
    const { intent } = setup();
    const { redirectUrl } = co.attachTransfer(intent, "u1", transfer(), "Ada Lovelace");
    return { intent, code: new URL(redirectUrl).searchParams.get("code")! };
  }

  it("exchanges the code once, returning the payer name only in that response", () => {
    const { intent, code } = attached();
    const out = co.exchangeCode("shop", "s3cret", code, VERIFIER);
    assert.equal(out.payer?.name, "Ada Lovelace");
    assert.ok(out.payer?.sub);
    assert.equal(store.findPaymentIntent(intent.id)!.payerName, undefined);
    assert.throws(() => co.exchangeCode("shop", "s3cret", code, VERIFIER), /unknown or used code/);
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

  it("rejects a wrong secret, wrong verifier and an expired code", () => {
    const { intent, code } = attached();
    assert.throws(() => co.exchangeCode("shop", "bad", code, VERIFIER), /bad client credentials/);
    assert.throws(() => co.exchangeCode("shop", "s3cret", code, "x".repeat(43)), /PKCE/);
    store.updatePaymentIntent(intent.id, { codeExpiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.throws(() => co.exchangeCode("shop", "s3cret", code, VERIFIER), /expired|unknown or used code/);
    assert.equal(store.findPaymentIntent(intent.id)!.payerName, undefined);
  });
});

describe("one transfer, one checkout", () => {
  const second = (merchant: any, state = "st2") =>
    co.createIntent(merchant, {
      amountEur: 12.5, reference: "order-77", redirectUri: "https://shop.test/cb", state, codeChallenge: CHALLENGE,
    });

  it("refuses a transfer that already paid another checkout, so one payment cannot mint many codes", () => {
    const { merchant, intent } = setup();
    co.attachTransfer(intent, "u1", transfer(), "Ada");
    const other = second(merchant);
    assert.throws(() => co.attachTransfer(other, "u1", transfer()), /already/);
    assert.equal(store.findPaymentIntent(other.id)!.codeHash, undefined);
  });

  it("refuses when the intent has no pinned destination or the transfer names no recipient", () => {
    const { intent } = setup();
    store.updatePaymentIntent(intent.id, { destinationIban: "" });
    assert.throws(() => co.attachTransfer(intent, "u1", transfer({ recipientIban: undefined })), /account/);
    assert.throws(() => co.attachTransfer(intent, "u1", transfer({ recipientIban: "" })), /account/);
  });

  it("caps pending checkouts per merchant", () => {
    const { merchant } = setup(); // one pending already
    const make = () =>
      co.createIntent(merchant, {
        amountEur: 1, reference: "", redirectUri: "https://shop.test/cb", state: "", codeChallenge: CHALLENGE,
      }, 3);
    make();
    make();
    assert.throws(make, /too many pending/);
  });
});

describe("production merchant check", () => {
  const m = (redirectUris: string[]) => ({
    id: "x", name: "X", clientId: "x", clientSecretHash: "h", settlementIbans: [IBAN], redirectUris, createdAt: NOW,
  });
  it("refuses a wildcard redirect URI outside the local demo", () => {
    assert.throws(() => co.assertNoWildcardRedirects([m(["https://ok.test/cb"]), m(["*"])]), /wildcard/);
    assert.doesNotThrow(() => co.assertNoWildcardRedirects([m(["https://ok.test/cb"])]));
  });
});
