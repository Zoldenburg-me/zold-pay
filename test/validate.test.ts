import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseIntentInput } from "../server/src/validate.js";

const CHALLENGE = "c".repeat(43);
const base = () => ({
  amount: 12.5,
  reference: "order-77",
  redirect_uri: "https://shop.test/cb",
  state: "st",
  code_challenge: CHALLENGE,
});
const opts = { maxAmountEur: 10_000, allowInsecureLoopback: false };

const bad = (over: Record<string, unknown>, message: RegExp) => {
  const out = parseIntentInput({ ...base(), ...over }, opts);
  assert.equal(out.ok, false, JSON.stringify(over));
  if (!out.ok) assert.match(out.error, message);
};

describe("parseIntentInput", () => {
  it("accepts a well-formed request and returns normalised values", () => {
    const out = parseIntentInput({ ...base(), destination_iban: "DE89 3704 0044 0532 0130 00" }, opts);
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.value.amountEur, 12.5);
      assert.equal(out.value.redirectUri, "https://shop.test/cb");
      assert.equal(out.value.destinationIban, "DE89 3704 0044 0532 0130 00");
    }
  });

  it("accepts numeric strings (query-string callers)", () => {
    const out = parseIntentInput({ ...base(), amount: "12.50" }, opts);
    assert.equal(out.ok && out.value.amountEur, 12.5);
  });

  for (const amount of ["abc", "", "Infinity", "NaN", 0, -1, 1e12, 10_000.01, 1.005, [], {}, null, undefined]) {
    it(`rejects amount ${JSON.stringify(amount)}`, () => bad({ amount }, /amount/));
  }
  it("accepts the maximum amount exactly", () => {
    assert.equal(parseIntentInput({ ...base(), amount: 10_000 }, opts).ok, true);
  });

  it("caps reference and state lengths", () => {
    // 120, not 140: the checkout appends its own unique reference to the SEPA remittance line.
    bad({ reference: "r".repeat(121) }, /reference/);
    bad({ reference: 42 }, /reference/);
    bad({ state: "s".repeat(513) }, /state/);
  });

  it("requires an S256 challenge of the right shape", () => {
    bad({ code_challenge: undefined }, /code_challenge/);
    bad({ code_challenge: "short" }, /code_challenge/);
    bad({ code_challenge: "!".repeat(43) }, /code_challenge/);
    bad({ code_challenge_method: "plain" }, /S256/);
  });

  const redirects = [
    "javascript:alert(1)", "data:text/html,x", "not a url", "ftp://shop.test/cb",
    "http://shop.test/cb", "https://user:pw@shop.test/cb", "https://shop.test/cb#frag", `https://shop.test/${"a".repeat(2100)}`,
  ];
  for (const redirect_uri of redirects) {
    it(`rejects redirect_uri ${redirect_uri.slice(0, 40)}`, () => bad({ redirect_uri }, /redirect_uri/));
  }

  it("allows http only for loopback, and only when permitted", () => {
    const local = { ...opts, allowInsecureLoopback: true };
    assert.equal(parseIntentInput({ ...base(), redirect_uri: "http://localhost:4000/cb" }, local).ok, true);
    assert.equal(parseIntentInput({ ...base(), redirect_uri: "http://127.0.0.1:4000/cb" }, local).ok, true);
    assert.equal(parseIntentInput({ ...base(), redirect_uri: "http://shop.test/cb" }, local).ok, false);
    assert.equal(parseIntentInput({ ...base(), redirect_uri: "http://localhost:4000/cb" }, opts).ok, false);
  });
});
