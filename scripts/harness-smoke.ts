/**
 * Harness smoke test: this service against a RUNNING core.
 *
 * 1. In the core repo:   npm run dev            (local hardhat chain + API on :3000)
 * 2. Start this service: CORE_API_URL=http://127.0.0.1:3000 CHECKOUT_PUBLIC_ORIGIN=http://localhost:3100 \
 *                        CHECKOUT_SUBJECT_SECRET=anything npm start
 * 3. Run:                npm run harness:smoke
 *
 * It checks that the proxy, sessions and error relaying work against the real
 * core as far as the local harness can go. A SEPA payment itself needs a live
 * Monerium connection (sandbox credentials or the user's own API keys), which a
 * local harness cannot provide, so the run stops at the core's own refusal and
 * says so. The attach and token exchange logic is covered by test/flow.test.ts.
 *
 * Refuses to run against anything that is not a no-real-money chain.
 */
import assert from "node:assert/strict";

const CORE = (process.env.CORE_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const PAY = (process.env.PAY_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");

const json = async (r: Response): Promise<any> => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t.slice(0, 200) };
  }
};

let n = 0;
const ok = (label: string) => console.log(`  ${++n}. ${label}`);

console.log(`harness smoke: pay ${PAY} -> core ${CORE}`);

// Safety first: never create users on a real-money deployment.
const coreHealth = await json(await fetch(`${CORE}/api/health`));
assert.equal(coreHealth.realMoney, false, "refusing to run: the core reports realMoney !== false");
ok(`core is a no-real-money chain (chain ${coreHealth.chainId})`);

const health = await json(await fetch(`${PAY}/bff/health`));
assert.equal(health.ok, true, "pay service cannot reach the core");
assert.equal(health.core.reachable, true);
ok("pay service reaches the core");

const cfg = await json(await fetch(`${PAY}/bff/config`));
assert.match(cfg.appUrl, /^https?:\/\//);
assert.equal("devShortcuts" in cfg, false);
ok("config exposes the account-creation link and no dev shortcuts");

const ch = await json(
  await fetch(`${PAY}/api/webauthn/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose: "login" }),
  }),
);
assert.ok(ch.challenge && ch.rpId, "login challenge must carry a challenge and an rpId");
ok(`login challenge relayed from the core (rpId ${ch.rpId})`);

for (const [path, body] of [
  ["/api/users", { name: "x" }],
  ["/api/users/u_1/passkey", {}],
  ["/api/users/u_1/passkey-safe/deployment", {}],
] as const) {
  const r = await fetch(`${PAY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(r.status, 404, `${path} must not be reachable through the checkout`);
}
ok("signup, passkey registration and Safe deployment are not reachable through the proxy");

// A throwaway user made on the core, the way the main app would.
const email = `smoke-${Date.now()}@example.test`;
const created = await fetch(`${CORE}/api/users`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Smoke Tester", email, country: "DE" }),
});
assert.equal(created.status, 201, "could not create a throwaway user on the core");
const user = await json(created);
const auth = { authorization: `Bearer ${user.sessionToken}` };
ok("throwaway user created on the core");

const me = await json(await fetch(`${PAY}/api/users/${user.id}`, { headers: auth }));
assert.equal(me.id, user.id);
for (const field of ["kycStatus", "balanceEur"]) assert.ok(field in me, `core user is missing "${field}"`);
ok(`core user read back through the proxy with its session (kycStatus ${me.kycStatus})`);

const noSession = await fetch(`${PAY}/api/users/${user.id}`);
assert.ok([401, 403].includes(noSession.status), `expected 401/403 without a session, got ${noSession.status}`);
ok("the same read without a session is refused by the core");

const quote = await fetch(`${PAY}/api/quotes`, {
  method: "POST",
  headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ userId: user.id, rail: "sepa", sendEur: 5 }),
});
const q = await json(quote);
if (quote.status === 409 && q.code === "MONERIUM_NOT_CONNECTED") {
  ok("SEPA quote reached the core, which refused: no Monerium connection (expected in a local harness)");
  console.log("\nHARNESS SMOKE PASSED — stopped at the Monerium gate; a full SEPA run needs a Monerium sandbox connection");
} else {
  assert.equal(quote.status, 200, `unexpected quote response ${quote.status}: ${JSON.stringify(q).slice(0, 200)}`);
  ok("SEPA quote returned by the core");
  console.log("\nHARNESS SMOKE PASSED — the account can quote; continue with the browser checklist for the payment");
}
