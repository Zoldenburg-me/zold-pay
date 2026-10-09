import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The merchant flow over real HTTP: intent -> attach -> code exchange -> status,
 * against a stub core. The stub returns the shapes the real core returns (checked
 * against a running core: a transfer carries id, userId, rail, state,
 * recipientIban, receiveEur and reference; GET /api/transfers/:id needs the
 * owner's session). The WebAuthn ceremonies need a real browser and are out of scope.
 */
const IBAN = "DE89370400440532013000";
const OWNER = "tok-owner";
const STRANGER = "tok-stranger";
let transferState = "PAYOUT_SUBMITTED";
// The reference the stub's next transfers carry: the page sends the checkout's own
// `transferReference`, so tests set this from the intent they just created.
let transferReference: string | undefined;
let transferAmount = 25;
let userLookupFails = false;
let garbageTransfer = false;
// Each payment is its own core transfer: a transfer can back only one checkout.
let transferSeq = 0;
const freshTransfer = () => `t${++transferSeq}`;

let lastRequest: { url?: string; headers: Record<string, unknown> } | undefined;
let secretHits = 0;

const coreStub: Server = createServer((req, res) => {
  const tok = (req.headers.authorization ?? "").replace("Bearer ", "");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  lastRequest = { url: req.url, headers: { ...req.headers } };
  if (req.url?.startsWith("/api/health")) {
    // What a core might say about itself: none of it is for the public.
    return send(200, { ok: true, version: "1.2.3", db: "/var/lib/zold/db.json", chainId: 8453 });
  }
  if (req.url === "/api/quotes") {
    res.writeHead(302, { location: "/secret" });
    return void res.end();
  }
  if (req.url === "/secret") {
    secretHits++;
    return send(200, { leak: true });
  }
  if (tok !== OWNER) return send(tok === STRANGER ? 403 : 401, { error: "not your transfer" });
  const transferMatch = /^\/api\/transfers\/(t\d+)$/.exec(req.url ?? "");
  if (transferMatch) {
    if (garbageTransfer) return send(200, { surprise: true });
    return send(200, {
      id: transferMatch[1], userId: "u1", rail: "sepa", state: transferState, recipientIban: IBAN,
      receiveEur: transferAmount, reference: transferReference,
    });
  }
  if (req.url === "/api/users/u1") {
    if (userLookupFails) return send(500, { error: "user lookup exploded" });
    return send(200, { id: "u1", name: "Ada Lovelace" });
  }
  send(404, { error: "not found" });
});
await new Promise<void>((resolve) => coreStub.listen(0, "127.0.0.1", resolve));

process.env.CORE_API_URL = `http://127.0.0.1:${(coreStub.address() as any).port}`;
process.env.CHECKOUT_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "pay-flow-")), "checkout.json");
process.env.CHECKOUT_SUBJECT_SECRET = "flow-subject-secret";
process.env.RATE_LIMIT_CREDENTIAL = "200";
process.env.RATE_LIMIT_GENERAL = "2000";

const { app } = await import("../server/src/server.js");
const { store } = await import("../server/src/store.js");
const { hashSecret } = await import("../server/src/secrets.js");

let base = "";
let server: ReturnType<typeof app.listen>;
before(async () => {
  store.addMerchant({
    id: "m-flow", name: "Flow Shop", clientId: "flow-shop", clientSecretHash: hashSecret("flow-secret"),
    settlementIbans: [IBAN], redirectUris: ["https://shop.test/cb"], createdAt: new Date().toISOString(),
  });
  await new Promise<void>((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => {
  server.close();
  coreStub.close();
});

const call = (p: string, init: { method?: string; json?: unknown; token?: string; headers?: Record<string, string>; redirect?: "follow" | "manual" | "error" } = {}) =>
  fetch(base + p, {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    redirect: init.redirect,
    headers: {
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const intentBody = (over: Record<string, unknown> = {}) => ({
  client_id: "flow-shop", client_secret: "flow-secret", amount: 25, reference: "order-1001",
  redirect_uri: "https://shop.test/cb", state: "xyz", code_challenge: CHALLENGE, ...over,
});

/** Create a checkout and point the stub core at the transfer the page would create for it. */
async function newIntent(reference = "order-1001", amount = 25) {
  const r = await call("/api/checkout/intents", { json: intentBody({ reference, amount }) });
  assert.equal(r.status, 201);
  const { intentId } = (await r.json()) as { intentId: string };
  const info = (await (await call(`/api/checkout/intents/${intentId}`)).json()) as { transferReference: string };
  transferReference = info.transferReference;
  transferAmount = amount;
  transferState = "PAYOUT_SUBMITTED";
  userLookupFails = false;
  garbageTransfer = false;
  return { intentId, transferReference: info.transferReference };
}

const attachTo = (intentId: string, transferId = freshTransfer(), token = OWNER) =>
  call(`/api/checkout/intents/${intentId}/attach`, { json: { transferId }, token });
const codeFrom = async (r: Response) => new URL(((await r.json()) as any).redirectUrl).searchParams.get("code")!;
const exchange = (code: string) =>
  call("/api/checkout/token", { json: { client_id: "flow-shop", client_secret: "flow-secret", code, code_verifier: VERIFIER } });

describe("merchant flow over HTTP", () => {
  it("runs intent -> attach -> exchange -> poll, and the code works once", async () => {
    const { intentId } = await newIntent();

    const info = await (await call(`/api/checkout/intents/${intentId}`)).json() as any;
    assert.equal(info.merchant, "Flow Shop");
    assert.equal(info.merchantIban, IBAN);
    assert.match(info.transferReference, /^order-1001 ZP[0-9A-F]{12}$/, "the payment carries a reference unique to this checkout");
    assert.equal("payerSub" in info, false, "the public view carries no payer data");

    const attach = await attachTo(intentId);
    assert.equal(attach.status, 200);
    const url = new URL(((await attach.json()) as any).redirectUrl);
    assert.equal(url.origin + url.pathname, "https://shop.test/cb");
    assert.equal(url.searchParams.get("state"), "xyz");
    const code = url.searchParams.get("code")!;

    const out = (await (await exchange(code)).json()) as any;
    assert.equal(out.status, "AUTHORIZED");
    assert.equal(out.payer.name, "Ada Lovelace");
    assert.ok(out.payer.sub && out.statusToken);

    assert.equal((await exchange(code)).status, 400, "a code must be single-use");

    const poll = await call(`/api/checkout/status/${intentId}`, { token: out.statusToken });
    assert.equal(poll.status, 200);
    assert.equal(((await poll.json()) as any).payer.name, undefined, "the payer name is not available on later polls");
    assert.equal((await call(`/api/checkout/status/${intentId}`, { token: "wrong" })).status, 404);
  });

  it("refuses to attach another person's transfer", async () => {
    const { intentId } = await newIntent();
    assert.equal((await attachTo(intentId, freshTransfer(), STRANGER)).status, 403);
    assert.equal((await call(`/api/checkout/intents/${intentId}/attach`, { json: { transferId: freshTransfer() } })).status, 401);
  });

  it("refuses a transfer for a different amount or reference, with the reason", async () => {
    const wrongAmount = await newIntent("order-2", 30);
    transferAmount = 25;
    const a = await attachTo(wrongAmount.intentId);
    assert.equal(a.status, 400);
    assert.equal(((await a.json()) as any).error, "transfer amount does not match the checkout");

    const wrongRef = await newIntent("order-3", 25);
    transferReference = "order-3"; // the bare merchant reference, without this checkout's unique part
    const b = await attachTo(wrongRef.intentId);
    assert.equal(b.status, 400);
    assert.equal(((await b.json()) as any).error, "transfer payment reference does not match the checkout");
  });

  it("refuses a failed payout for good, and asks the page to retry one that has not settled yet", async () => {
    const expected: Record<string, [number, string]> = {
      FAILED: [400, "transfer failed"],
      REFUNDED: [400, "transfer refunded"],
      MANUAL_REVIEW: [400, "transfer is in manual review"],
      CREATED: [409, "transfer not settled (state CREATED)"],
    };
    for (const [state, [status, message]] of Object.entries(expected)) {
      const { intentId } = await newIntent("order-4", 25);
      transferState = state;
      const r = await attachTo(intentId);
      const body = (await r.json()) as any;
      assert.equal(r.status, status, state);
      assert.equal(body.error, message, state);
      assert.equal(body.retryable === true, status === 409, `${state} retryable`);
      assert.equal(store.findPaymentIntent(intentId)!.status, "PENDING", `${state} must not authorize the checkout`);
    }
  });

  it("rejects a code exchange with the wrong secret or the wrong PKCE verifier, without burning the code", async () => {
    const { intentId } = await newIntent();
    const code = await codeFrom(await attachTo(intentId));
    const badSecret = await call("/api/checkout/token", {
      json: { client_id: "flow-shop", client_secret: "nope", code, code_verifier: VERIFIER },
    });
    assert.equal(badSecret.status, 400);
    const badVerifier = await call("/api/checkout/token", {
      json: { client_id: "flow-shop", client_secret: "flow-secret", code, code_verifier: "x".repeat(43) },
    });
    assert.equal(badVerifier.status, 400);
    assert.equal((await exchange(code)).status, 200, "failed attempts must not burn the code");
  });

  it("serves the checkout page itself with a nonce-bound policy", async () => {
    const r = await call("/checkout?intent=anything");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-/);
    assert.match(await r.text(), /Sign in and pay/);
    assert.equal(r.headers.get("cache-control"), "no-store", "a page with a per-response nonce must never be cached");
  });

  it("lets one payment back only one checkout, so it cannot mint codes for several", async () => {
    const first = await newIntent();
    const second = await newIntent();
    const transferId = freshTransfer();
    transferReference = first.transferReference;
    assert.equal((await attachTo(first.intentId, transferId)).status, 200);
    // Even a transfer that carries the second checkout's reference cannot be reused.
    transferReference = second.transferReference;
    const b = await attachTo(second.intentId, transferId);
    assert.equal(b.status, 400);
    assert.match(((await b.json()) as any).error, /already paid another checkout/);
    assert.equal(store.findPaymentIntent(second.intentId)!.status, "PENDING");
  });

  it("rejects a transferId that could walk the core's paths", async () => {
    const { intentId } = await newIntent();
    for (const transferId of ["..", "../users", "a/b", "%2e%2e", "x".repeat(200)]) {
      assert.equal((await attachTo(intentId, transferId)).status, 400, transferId);
    }
  });
});

describe("recovering from a lost attach", () => {
  it("re-issues the code for the same transfer, and the first code stops working", async () => {
    const { intentId } = await newIntent();
    const transferId = freshTransfer();
    const first = await codeFrom(await attachTo(intentId, transferId));
    const retry = await attachTo(intentId, transferId);
    assert.equal(retry.status, 200, "the page can ask again after a lost response");
    const second = await codeFrom(retry);
    assert.notEqual(first, second);
    assert.equal((await exchange(first)).status, 400);
    assert.equal((await exchange(second)).status, 200);
  });

  it("refuses to re-issue once the merchant has the code, or for a different transfer", async () => {
    const { intentId } = await newIntent();
    const transferId = freshTransfer();
    const code = await codeFrom(await attachTo(intentId, transferId));
    // A second payment made for this checkout: refused, and recorded for a refund.
    const other = await attachTo(intentId, freshTransfer());
    assert.equal(other.status, 409);
    assert.equal(((await other.json()) as any).code, "duplicate_payment");
    assert.equal((await exchange(code)).status, 200);
    const late = await attachTo(intentId, transferId);
    assert.equal(late.status, 400);
    assert.equal(((await late.json()) as any).code, "checkout_completed");
  });

  it("does not fail a funded attach just because the payer's name could not be looked up", async () => {
    const { intentId } = await newIntent();
    userLookupFails = true;
    const r = await attachTo(intentId);
    assert.equal(r.status, 200);
    const out = (await (await exchange(await codeFrom(r))).json()) as any;
    assert.equal(out.status, "AUTHORIZED");
    assert.ok(out.payer.sub);
    assert.equal(out.payer.name, undefined, "no name rather than a failed payment");
  });
});

describe("a core that misbehaves", () => {
  it("does not attach on a response that is not a transfer", async () => {
    const { intentId } = await newIntent();
    garbageTransfer = true;
    const r = await attachTo(intentId);
    assert.equal(r.status, 502);
    assert.equal(store.findPaymentIntent(intentId)!.status, "PENDING");
  });

  it("relays the core's own refusal when it does not know the transfer", async () => {
    const { intentId } = await newIntent();
    const r = await attachTo(intentId, "t0-unknown");
    assert.equal(r.status, 404);
    assert.equal(store.findPaymentIntent(intentId)!.status, "PENDING");
  });
});

describe("what a merchant may ask for", () => {
  it("refuses a redirect URI that is not registered, so a code cannot be sent to an attacker", async () => {
    const before = store.pendingCount("m-flow");
    for (const redirect_uri of ["https://evil.test/cb", "https://shop.test/cb/", "https://shop.test/cb?next=https://evil.test"]) {
      const r = await call("/api/checkout/intents", { json: intentBody({ redirect_uri }) });
      assert.equal(r.status, 400, redirect_uri);
      assert.match(((await r.json()) as any).error, /redirect_uri not allowed/, redirect_uri);
    }
    assert.equal(store.pendingCount("m-flow"), before, "nothing was created");
  });

  it("refuses a destination account the merchant did not register", async () => {
    const r = await call("/api/checkout/intents", { json: intentBody({ destination_iban: "GB82WEST12345698765432" }) });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).error, /not a registered settlement account/);
  });

  it("answers an unknown client and a wrong secret identically", async () => {
    const unknown = await call("/api/checkout/intents", { json: intentBody({ client_id: "nobody" }) });
    const wrong = await call("/api/checkout/intents", { json: intentBody({ client_secret: "nope" }) });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(await unknown.json(), await wrong.json());
  });
});

describe("the unauthenticated front channel", () => {
  const authorize = (over: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const q = new URLSearchParams({
      client_id: "flow-shop", amount: "5", reference: "front-1", redirect_uri: "https://shop.test/cb", state: "s",
      code_challenge: CHALLENGE, ...over,
    });
    return call(`/api/checkout/authorize?${q}`, { headers, redirect: "manual" });
  };

  it("cannot name a destination account, because the client id is public", async () => {
    const before = store.pendingCount("m-flow", "front");
    const r = await authorize({ destination_iban: IBAN });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).error, /cannot be set/);
    assert.equal(store.pendingCount("m-flow", "front"), before);
  });

  it("refuses an unknown client and an unregistered redirect", async () => {
    assert.equal((await authorize({ client_id: "nobody" })).status, 400);
    const r = await authorize({ redirect_uri: "https://evil.test/cb" });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).error, /redirect_uri not allowed/);
  });

  it("creates a checkout on its own channel, answering JSON or a redirect to the page", async () => {
    const json = await authorize({}, { accept: "application/json" });
    assert.equal(json.status, 201);
    const created = (await json.json()) as any;
    assert.match(created.checkoutUrl, /\/checkout\?intent=/);
    assert.equal(store.findPaymentIntent(created.intentId)!.channel, "front");

    const redirect = await authorize();
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location") ?? "", /\/checkout\?intent=/);
  });
});

describe("proxy hygiene", () => {
  it("never forwards a client-supplied X-Forwarded-For or the query string", async () => {
    await fetch(`${base}/api/users/u1?debug=1`, { headers: { "x-forwarded-for": "6.6.6.6", authorization: `Bearer ${OWNER}` } });
    assert.equal(lastRequest?.url, "/api/users/u1");
    const xff = String(lastRequest?.headers["x-forwarded-for"] ?? "");
    assert.equal(xff.includes("6.6.6.6"), false, xff);
    assert.equal(xff, "127.0.0.1");
  });

  it("does not follow redirects from the core", async () => {
    const r = await call("/api/quotes", { json: {}, token: OWNER });
    assert.equal(r.status, 302);
    assert.equal(secretHits, 0);
  });
});

describe("claiming a checkout before paying, over HTTP", () => {
  const newClaimToken = () => randomBytes(32).toString("base64url");
  // null means no session at all (undefined would fall back to the default).
  const claim = (intentId: string, claimToken = newClaimToken(), token: string | null = OWNER, userId = "u1") =>
    call(`/api/checkout/intents/${intentId}/claim`, { json: { userId, claimToken }, token: token ?? undefined });
  const release = (intentId: string, claimToken: unknown) =>
    call(`/api/checkout/intents/${intentId}/release`, { json: { claimToken } });
  const json = async (r: Response) => (await r.json()) as { code?: string; [k: string]: unknown };

  it("needs a session, a page-made token, and only for the payer that session belongs to", async () => {
    const { intentId } = await newIntent();
    assert.equal((await claim(intentId, newClaimToken(), null)).status, 401);
    assert.equal((await claim(intentId, newClaimToken(), STRANGER)).status, 403, "the core says this session is not u1");
    assert.equal((await claim(intentId, newClaimToken(), OWNER, "../admin")).status, 400);
    assert.equal((await claim(intentId, "short")).status, 400, "a guessable token cannot hold a checkout");
    assert.equal((await call(`/api/checkout/intents/${intentId}/claim`, { json: { userId: "u1" }, token: OWNER })).status, 400);
  });

  it("lets one tab claim, refuses the second with a code, and lets the first retry with its token", async () => {
    const { intentId } = await newIntent();
    const mine = newClaimToken();
    assert.equal((await claim(intentId, mine)).status, 200);
    const second = await claim(intentId);
    assert.equal(second.status, 409);
    assert.equal((await json(second)).code, "payment_in_progress");
    // The first answer was lost: the same token claims again.
    assert.equal((await claim(intentId, mine)).status, 200);
    const page = await json(await call(`/api/checkout/intents/${intentId}`));
    assert.equal(page.status, "PAYING");
  });

  it("gives the checkout to exactly one of two tabs that claim it at the same moment", async () => {
    const { intentId } = await newIntent();
    const replies = await Promise.all([claim(intentId), claim(intentId)]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
    const loser = replies.find((r) => r.status === 409)!;
    assert.equal((await json(loser)).code, "payment_in_progress");
  });

  it("releases only for the claim holder, after which the checkout can be claimed again", async () => {
    const { intentId } = await newIntent();
    const mine = newClaimToken();
    await claim(intentId, mine);
    const wrong = await release(intentId, newClaimToken());
    assert.equal(wrong.status, 403);
    assert.equal((await json(wrong)).code, "not_claim_holder");
    assert.equal((await release(intentId, 42)).status, 400);
    assert.equal((await release(intentId, mine)).status, 204);
    assert.equal((await claim(intentId)).status, 200);
  });

  it("records a second payment for a paid checkout and shows it to the merchant", async () => {
    const { intentId } = await newIntent();
    await claim(intentId);
    const code = await codeFrom(await attachTo(intentId));
    const dup = await attachTo(intentId);
    assert.equal(dup.status, 409);
    assert.equal((await json(dup)).code, "duplicate_payment");
    const out = (await (await exchange(code)).json()) as { unattachedPayments: { amountEur: number; reason: string }[] };
    assert.equal(out.unattachedPayments.length, 1);
    assert.equal(out.unattachedPayments[0].amountEur, 25);
    assert.equal(out.unattachedPayments[0].reason, "duplicate");
  });
});

describe("health", () => {
  it("says only whether the core is reachable, never what the core says about itself", async () => {
    const r = await call("/bff/health");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, core: { reachable: true } });
  });

  it("does not forward the core's own health endpoint", async () => {
    assert.equal((await call("/api/health")).status, 404);
  });
});
