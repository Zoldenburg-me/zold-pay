import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";
const { isAllowed } = await import("../server/src/proxy.js");

describe("proxy allowlist: what an existing user needs", () => {
  const allowed: Array<[string, string]> = [
    ["GET", "/api/health"],
    ["POST", "/api/webauthn/challenge"],
    ["POST", "/api/passkey/login"],
    ["GET", "/api/users/u_123"],
    ["GET", "/api/users/3f2b8c1e-aaaa-bbbb-cccc-1234567890ab/kyc"],
    ["POST", "/api/users/u_123/authorizer"],
    ["POST", "/api/quotes"],
    ["POST", "/api/transfers"],
    ["GET", "/api/transfers/t_9"],
    ["POST", "/api/transfers/t_9/authorize"],
  ];
  for (const [method, path] of allowed) {
    it(`allows ${method} ${path}`, () => assert.equal(isAllowed(method, path), true));
  }
});

describe("proxy allowlist: what must stay unreachable", () => {
  const blocked: Array<[string, string, string]> = [
    ["POST", "/api/users", "account creation belongs in the main app"],
    ["POST", "/api/users/u_1/passkey", "passkey registration belongs in the main app"],
    ["POST", "/api/users/u_1/passkey-safe/deployment", "Safe deployment belongs in the main app"],
    ["POST", "/api/users/u_1/monerium/connect/start", "Monerium linking belongs in the main app"],
    ["POST", "/api/users/u_1/kyc/mock-review", "removed in the core; never proxy self-approval"],
    ["POST", "/api/simulate/sepa-deposit", "removed in the core; never proxy minted balance"],
    ["POST", "/api/kyc/review", "operator route"],
    ["POST", "/api/webhooks/monerium", "rail callback"],
    ["GET", "/api/users", "no listing"],
    ["DELETE", "/api/users/u_1", "method not allowed"],
    ["PUT", "/api/transfers/t_1", "method not allowed"],
    ["GET", "/api/transfers", "no listing"],
    ["POST", "/api/checkout/token", "served locally, never forwarded"],
  ];
  for (const [method, path, why] of blocked) {
    it(`blocks ${method} ${path} (${why})`, () => assert.equal(isAllowed(method, path), false));
  }
});

describe("proxy allowlist: path tricks", () => {
  const tricks = [
    "/api/users/..",
    "/api/users/%2e%2e",
    "/api/users/%2E%2E",
    "/api/users/a%2Fb",
    "/api/users/a%5Cb",
    "/api/users/.",
    "/api/users/u_1/../admin",
    "/api//users/u_1",
    "/api/users/u_1/",
    "/api/users/u 1",
    "/api/users/u_1;x",
    `/api/users/${"a".repeat(200)}`,
    "/api/transfers/..%2f..%2fadmin",
  ];
  for (const path of tricks) {
    it(`blocks GET ${path.slice(0, 50)}`, () => assert.equal(isAllowed("GET", path), false));
  }
  it("does not let a placeholder-looking segment through", () => {
    assert.equal(isAllowed("GET", "/api/users/:id"), false);
  });
});
