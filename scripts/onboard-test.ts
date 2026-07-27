/**
 * New-user checkout onboarding — headless orchestration test.
 *
 * Drives everything a first-timer does at the merchant's checkout EXCEPT the
 * two WebAuthn ceremonies, which no headless runner can perform: account
 * creation, KYC, the FP4 device key, funding, the device-signed SEPA payment
 * into the merchant's IBAN, and the merchant's PKCE code exchange. The passkey
 * steps are covered by BROWSER-CHECKLIST.md, by hand, in a real browser.
 *
 * The core API's own guards make this possible: with ALLOW_SIMULATION on, an
 * account with no passkey yet may bind a device key without a step-up. That is
 * the same allowance the main repo's checkout-test.ts relies on.
 *
 * PREREQUISITE — a running core Zold API (`npm run dev` in the main repo).
 * This test deliberately does not spawn or reset it: the core's store is a
 * single db.json at its repo root, and a test in another repo has no business
 * wiping it.
 *
 * Run: npm run onboard:test
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = (process.env.CORE_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const PORT = Number(process.env.CHECKOUT_TEST_PORT ?? 3113);
const BFF = `http://127.0.0.1:${PORT}`;
const AMOUNT = 40;
const TEST_DB = path.join(ROOT, "data/checkout-test.json");

let token = "";
const children: ChildProcess[] = [];

/** Call the checkout service (proxy or its own routes). */
async function svc(p: string, body?: any, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { accept: "application/json", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(BFF + p, {
    method: body !== undefined ? "POST" : "GET",
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: ${(data as any).error ?? res.statusText}`);
  return data as any;
}

/** Raw status from the checkout service, for the allowlist assertions. */
async function svcStatus(p: string, method = "GET"): Promise<number> {
  const res = await fetch(BFF + p, {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: method === "POST" ? "{}" : undefined,
  });
  return res.status;
}

/** Call the core API directly, as the merchant's backend would. */
async function coreApi(p: string, body?: any, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { accept: "application/json", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(CORE + p, {
    method: body !== undefined ? "POST" : "GET",
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: ${(data as any).error ?? res.statusText}`);
  return data as any;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  console.log("1/9 core API preflight…");
  try {
    await coreApi("/api/health");
  } catch (e: any) {
    console.error(
      `\nCannot reach the core Zold API at ${CORE}.\n` +
        "Start it first (in the main repo):  npm run dev\n" +
        "Or point this test elsewhere:       CORE_API_URL=… npm run onboard:test\n",
    );
    throw e;
  }

  console.log("2/9 start the checkout service…");
  rmSync(TEST_DB, { force: true });
  children.push(
    spawn(process.execPath, [path.join(ROOT, "node_modules/.bin/tsx"), "server/src/server.ts"], {
      cwd: ROOT,
      stdio: "ignore",
      env: {
        ...process.env,
        CHECKOUT_PORT: String(PORT),
        CORE_API_URL: CORE,
        CHECKOUT_PUBLIC_ORIGIN: BFF,
        ALLOW_DEV_SHORTCUTS: "1",
        // Its own store, so a test run cannot disturb merchants or intents a
        // local demo is using.
        CHECKOUT_DB_PATH: TEST_DB,
        // Fixed, so the payer subject assertions below are reproducible.
        CHECKOUT_SUBJECT_SECRET: "test-subject-secret-do-not-use-anywhere-real",
      },
    }),
  );
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try {
      if ((await fetch(`${BFF}/bff/config`)).ok) break;
    } catch {}
    await wait(200);
  }
  const cfg = await svc("/bff/config");
  assert.equal(cfg.devShortcuts, true, "dev shortcuts enabled for this run");
  const health = await svc("/bff/health");
  assert.equal(health.core.reachable, true, "core API reachable through the service");

  console.log("3/9 proxy allowlist…");
  // Routes the checkout has no business exposing on its own origin must not be
  // reachable through it — the 404 comes from this service, not the core.
  assert.equal(await svcStatus("/api/kyc/review", "POST"), 404, "operator KYC review not proxied");
  assert.equal(await svcStatus("/api/simulate/sepa-deposit", "POST"), 404, "simulate deposit not proxied");
  assert.equal(await svcStatus("/api/webhooks/monerium", "POST"), 404, "rail webhooks not proxied");
  assert.equal(await svcStatus("/api/users/x/monerium/accounts"), 404, "Monerium linking not proxied");
  assert.equal(await svcStatus("/api/health"), 200, "allowlisted route reaches the core");
  // The core no longer serves /api/checkout/* at all (PR #68) — this service
  // is the authorization server, so these must be answered locally.
  assert.equal(
    (await fetch(`${CORE}/api/checkout/intents/none`)).status,
    404,
    "the core has no checkout routes left to forward to",
  );

  console.log("4/9 merchant starts a checkout (back channel, PKCE)…");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(8).toString("hex");
  const REDIRECT = "https://mony.example/callback";
  const CLIENT = { client_id: "demo-merchant", client_secret: "demo-secret" };
  // The demo merchant registers two settlement accounts; name the second, so
  // the test proves the payment lands where the merchant asked rather than in
  // the default.
  const SECOND_IBAN = "DE02120300000000202051";

  // A destination is only selectable on the authenticated back channel.
  await assert.rejects(
    () =>
      svc(
        `/api/checkout/authorize?client_id=demo-merchant&amount=${AMOUNT}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${codeChallenge}` +
          `&destination_iban=${SECOND_IBAN}`,
      ),
    /client secret/,
    "front-channel authorize refuses to pick a destination",
  );
  await assert.rejects(
    () => svc("/api/checkout/intents", { ...CLIENT, client_secret: "wrong", amount: AMOUNT, redirect_uri: REDIRECT, code_challenge: codeChallenge }),
    /client credentials/,
    "back channel needs the client secret",
  );
  // An account the merchant has not registered cannot be paid, even with a
  // valid secret — the allowlist is what survives a leaked credential.
  await assert.rejects(
    () =>
      svc("/api/checkout/intents", {
        ...CLIENT,
        amount: AMOUNT,
        redirect_uri: REDIRECT,
        code_challenge: codeChallenge,
        destination_iban: "DE89370400440532013001",
      }),
    /not a registered settlement account/,
    "unregistered destination refused",
  );

  const authz = await svc("/api/checkout/intents", {
    ...CLIENT,
    amount: AMOUNT,
    reference: "mony-user-new",
    redirect_uri: REDIRECT,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    destination_iban: SECOND_IBAN,
  });
  assert.ok(
    String(authz.checkoutUrl).startsWith(BFF),
    `checkoutUrl is absolute and points at this service, got ${authz.checkoutUrl}`,
  );
  assert.equal(authz.destinationIban, SECOND_IBAN, "the named settlement account was pinned");
  const intentId = authz.intentId as string;
  assert.ok(intentId, "intent created");

  // The checkout page reads the intent through this service.
  const intent = await svc(`/api/checkout/intents/${intentId}`);
  assert.equal(intent.amountEur, AMOUNT);
  assert.equal(intent.merchantIban, SECOND_IBAN, "the page is shown the account this intent pays");
  // The page's view is unauthenticated — it must never carry payer identity.
  assert.equal(intent.payer, undefined, "public intent view discloses no payer");

  console.log("5/9 new user creates an account…");
  const user = await svc("/api/users", { name: "First Timer", country: "DE", email: "first@example.com" });
  token = user.sessionToken;
  assert.ok(user.id && user.address, "account + smart wallet address");

  console.log("6/9 KYC…");
  let kyc = await svc(`/api/users/${user.id}/kyc`);
  if (kyc.kycStatus !== "approved") {
    await svc("/bff/dev/kyc-approve", { userId: user.id });
    kyc = await svc(`/api/users/${user.id}/kyc`);
  }
  assert.equal(kyc.kycStatus, "approved", "account approved before it can bind a key or hold money");

  console.log("7/9 bind the device key (FP4)…");
  const device = privateKeyToAccount(generatePrivateKey());
  const bound = await svc(`/api/users/${user.id}/authorizer`, { address: device.address });
  assert.equal(
    (bound.authorizerAddress ?? "").toLowerCase(),
    device.address.toLowerCase(),
    "the browser's key is the account's on-chain authorizer",
  );

  console.log("8/9 fund, quote and pay the merchant…");
  const me = await svc(`/api/users/${user.id}`);
  assert.ok(me.iban, "an IBAN was issued after approval");

  // Size the send so the merchant receives exactly the intent amount.
  const probe = await svc("/api/quotes", { userId: user.id, rail: "sepa", sendEur: AMOUNT });
  const fee = Math.round((probe.sendEur - probe.receiveEur) * 100) / 100;
  const quote = await svc("/api/quotes", { userId: user.id, rail: "sepa", sendEur: AMOUNT + fee });
  assert.ok(Math.abs(quote.receiveEur - AMOUNT) < 0.01, `merchant receives ~€${AMOUNT}, got ${quote.receiveEur}`);

  // A brand-new account has nothing. This is the funding gap, papered over here
  // by the local simulation only — there is no instant rail in a real deploy.
  await svc("/bff/dev/fund", { iban: me.iban, amountEur: Math.ceil(quote.sendEur) });
  const funded = await svc(`/api/users/${user.id}`);
  assert.ok(funded.balanceEur >= quote.sendEur, `funded (${funded.balanceEur} >= ${quote.sendEur})`);

  const created = await svc("/api/transfers", {
    quoteId: quote.id,
    recipientName: intent.merchant || "Mony (demo)",
    recipientIban: intent.merchantIban,
    reference: intent.reference,
  });
  // Only meaningful against a core that carries it; older cores ignore the
  // field, so this asserts the wiring rather than the bank statement.
  assert.equal(created.reference, "mony-user-new", "the merchant reference is stored on the transfer");
  assert.equal(
    created.authorization.authorizer.toLowerCase(),
    device.address.toLowerCase(),
    "the terms are addressed to this device",
  );
  const td = created.authorization.typedData;
  const signature = await device.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: { ...td.message, amount: BigInt(td.message.amount), deadline: BigInt(td.message.deadline) },
  });
  const paid = await svc(`/api/transfers/${created.id}/authorize`, { signature });
  assert.ok(["PAID", "PAYOUT_SUBMITTED"].includes(paid.state), `transfer state ${paid.state}`);

  const attach = await svc(`/api/checkout/intents/${intentId}/attach`, { transferId: paid.id });
  const redirect = new URL(attach.redirectUrl);
  assert.equal(redirect.origin + redirect.pathname, "https://mony.example/callback");
  assert.equal(redirect.searchParams.get("state"), state, "state echoed back to the merchant");
  const code = redirect.searchParams.get("code")!;
  assert.ok(code, "authorization code issued");

  console.log("9/9 merchant exchanges the code…");
  token = "";
  await assert.rejects(
    () =>
      svc("/api/checkout/token", {
        client_id: "demo-merchant",
        client_secret: "demo-secret",
        code,
        code_verifier: "wrong",
      }),
    /PKCE/,
    "bad PKCE verifier rejected",
  );
  await assert.rejects(
    () =>
      svc("/api/checkout/token", {
        client_id: "demo-merchant",
        client_secret: "wrong-secret",
        code,
        code_verifier: codeVerifier,
      }),
    /client credentials/,
    "bad client secret rejected",
  );
  const settled = await svc("/api/checkout/token", {
    client_id: "demo-merchant",
    client_secret: "demo-secret",
    code,
    code_verifier: codeVerifier,
  });
  assert.equal(settled.status, "PAID", `expected PAID, got ${settled.status}`);
  assert.equal(settled.amountEur, AMOUNT);
  assert.equal(settled.reference, "mony-user-new", "merchant reference preserved");
  assert.equal(settled.destinationIban, SECOND_IBAN, "settled into the account the merchant named");
  assert.ok(settled.payer?.sub, "merchant gets a payer subject");
  assert.notEqual(settled.payer.sub, user.id, "the subject is not the raw user id");
  assert.equal(settled.payer.name, "First Timer", "merchant gets the payer's legal name");

  // The code is one-time: a replay after the exchange must not mint a second
  // status token.
  await assert.rejects(
    () =>
      svc("/api/checkout/token", {
        client_id: "demo-merchant",
        client_secret: "demo-secret",
        code,
        code_verifier: codeVerifier,
      }),
    /unknown or used code/,
    "burned code cannot be exchanged twice",
  );

  const polled = await svc(`/api/checkout/status/${intentId}`, undefined, {
    authorization: `Bearer ${settled.statusToken}`,
  });
  assert.equal(polled.status, "PAID", "merchant can poll with the issued bearer");

  console.log(
    "\nONBOARD TEST PASSED — new user: account → KYC → device key → funded → device-signed SEPA → merchant code → PAID",
  );
  console.log("(passkey registration and the send-time ceremony are not covered here — see BROWSER-CHECKLIST.md)");
} finally {
  for (const c of children) c.kill();
}
