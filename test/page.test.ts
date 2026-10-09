import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";
const { isAllowed } = await import("../server/src/proxy.js");

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const html = readFileSync(path.join(WEB, "checkout.html"), "utf8");
const device = readFileSync(path.join(WEB, "device.js"), "utf8");

const indexOfOrFail = (s: string, needle: string) => {
  const i = s.indexOf(needle);
  assert.ok(i >= 0, `expected checkout.html to contain: ${needle}`);
  return i;
};

// Source-level checks: the WebAuthn ceremonies themselves need a real browser
// (see BROWSER-CHECKLIST.md). These pin the wiring so it cannot regress silently.
describe("checkout page wiring", () => {
  it("collects both passkey assertions the core requires and sends them with the device signature", () => {
    for (const needle of [
      "created.authorization.safeExecution",
      "created.authorization.moneriumRedeem",
      "executionAssertion",
      "moneriumRedeemAssertion",
      "dev.passkeyAssertion(",
    ]) {
      indexOfOrFail(html, needle);
    }
  });

  it("verifies the payout destination, then signs the terms, then asks for the passkey assertions", () => {
    const destination = indexOfOrFail(html, "dev.destinationCommitment(");
    const deviceSig = indexOfOrFail(html, "dev.signTypedData(");
    const assertion = indexOfOrFail(html, "dev.passkeyAssertion(created");
    const authorize = indexOfOrFail(html, "/authorize`");
    assert.ok(destination < deviceSig && deviceSig < assertion && assertion < authorize);
  });

  it("names the step-up action when binding a spending key", () => {
    indexOfOrFail(html, 'purpose: "step_up", action');
    indexOfOrFail(html, 'passkeyStepUp("authorizer.bind")');
  });

  it("refuses an account that is not ready instead of failing halfway through", () => {
    indexOfOrFail(html, 'u.kycStatus !== "approved"');
    indexOfOrFail(html, 'passkeySafe.status !== "active"');
  });

  it("measures the balance the debit actually comes from", () => {
    indexOfOrFail(html, "safeBalanceEur");
  });

  it("has no account-creation, wizard or dev-shortcut paths left", () => {
    for (const gone of [
      "/bff/dev/", "mock-review", "simulate", 'purpose: "register"', "navigator.credentials.create",
      'api("/api/users",', "step-kyc", "step-device", "step-fund", 'id="wizard"', "startWizard", "devShortcuts",
    ]) {
      assert.equal(html.includes(gone), false, `checkout.html still contains: ${gone}`);
    }
  });

  it("only calls core endpoints that the proxy allowlist permits", () => {
    const calls: Array<[string, string]> = [
      ["POST", "/api/webauthn/challenge"],
      ["POST", "/api/passkey/login"],
      ["GET", "/api/users/u_1"],
      ["POST", "/api/users/u_1/authorizer"],
      ["POST", "/api/quotes"],
      ["POST", "/api/transfers"],
      ["POST", "/api/transfers/t_1/authorize"],
    ];
    for (const [method, p] of calls) assert.equal(isAllowed(method, p), true, `${method} ${p}`);
    for (const literal of ["/api/webauthn/challenge", "/api/passkey/login", "/api/quotes", "/api/transfers"]) {
      indexOfOrFail(html, literal);
    }
  });

  it("keeps the inline script and style nonce-able (no inline event handlers)", () => {
    assert.equal(/\son(click|change|submit|input|load|error)\s*=/.test(html), false);
  });

  it("does not adopt a browser key whose owner is unknown", () => {
    indexOfOrFail(html, "if (!user.authorizerAddress) return true");
  });

  it("forgets the session after paying and only follows https or same-origin redirects", () => {
    indexOfOrFail(html, 'sessionStorage.removeItem("zold-checkout-session")');
    indexOfOrFail(html, "new URL(redirectUrl");
  });
});

describe("device.js", () => {
  it("is the core's device library: exports passkeyAssertion and hands it to the page", () => {
    indexOfOrFail(device, "export async function passkeyAssertion");
    assert.match(device, /__deviceLibReady\(\{[^}]*passkeyAssertion[^}]*\}\)/);
  });

  it("keeps the legacy storage slot, so existing device keys stay readable", () => {
    indexOfOrFail(device, "zoll-device-key");
    indexOfOrFail(device, "zold-device-key");
  });
});
