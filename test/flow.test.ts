import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
let transferReference: string | undefined = "order-1001";
let transferAmount = 25;
// Each payment is its own core transfer: a transfer can back only one checkout.
let transferSeq = 0;
const freshTransfer = () => `t${++transferSeq}`;

let lastHealth: { url?: string; headers: Record<string, unknown> } | undefined;
let secretHits = 0;

const coreStub: Server = createServer((req, res) => {
  const tok = (req.headers.authorization ?? "").replace("Bearer ", "");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url?.startsWith("/api/health")) {
    lastHealth = { url: req.url, headers: { ...req.headers } };
    return send(200, { ok: true });
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
    return send(200, {
      id: transferMatch[1], userId: "u1", rail: "sepa", state: transferState, recipientIban: IBAN,
      receiveEur: transferAmount, reference: transferReference,
    });
  }
  if (req.url === "/api/users/u1") return send(200, { id: "u1", name: "Ada Lovelace" });
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

const call = (p: string, init: { method?: string; json?: unknown; token?: string } = {}) =>
  fetch(base + p, {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

async function newIntent(reference = "order-1001", amount = 25) {
  transferReference = reference;
  transferAmount = amount;
  transferState = "PAYOUT_SUBMITTED";
  const r = await call("/api/checkout/intents", {
    json: {
      client_id: "flow-shop", client_secret: "flow-secret", amount, reference,
      redirect_uri: "https://shop.test/cb", state: "xyz", code_challenge: CHALLENGE,
    },
  });
  assert.equal(r.status, 201);
  return (await r.json()) as { intentId: string };
}

describe("merchant flow over HTTP", () => {
  it("runs intent -> attach -> exchange -> poll, and the code works once", async () => {
    const { intentId } = await newIntent();

    const info = await (await call(`/api/checkout/intents/${intentId}`)).json() as any;
    assert.equal(info.merchant, "Flow Shop");
    assert.equal(info.merchantIban, IBAN);
    assert.equal("payerSub" in info, false, "the public view carries no payer data");

    const attach = await call(`/api/checkout/intents/${intentId}/attach`, { json: { transferId: freshTransfer() }, token: OWNER });
    assert.equal(attach.status, 200);
    const url = new URL(((await attach.json()) as any).redirectUrl);
    assert.equal(url.origin + url.pathname, "https://shop.test/cb");
    assert.equal(url.searchParams.get("state"), "xyz");
    const code = url.searchParams.get("code")!;

    const exchange = await call("/api/checkout/token", {
      json: { client_id: "flow-shop", client_secret: "flow-secret", code, code_verifier: VERIFIER },
    });
    assert.equal(exchange.status, 200);
    const out = (await exchange.json()) as any;
    assert.equal(out.status, "AUTHORIZED");
    assert.equal(out.payer.name, "Ada Lovelace");
    assert.ok(out.payer.sub && out.statusToken);

    const replay = await call("/api/checkout/token", {
      json: { client_id: "flow-shop", client_secret: "flow-secret", code, code_verifier: VERIFIER },
    });
    assert.equal(replay.status, 400, "a code must be single-use");

    const poll = await call(`/api/checkout/status/${intentId}`, { token: out.statusToken });
    assert.equal(poll.status, 200);
    const polled = (await poll.json()) as any;
    assert.equal(polled.payer.name, undefined, "the payer name is not available on later polls");
    assert.equal((await call(`/api/checkout/status/${intentId}`, { token: "wrong" })).status, 404);
  });

  it("refuses to attach another person's transfer", async () => {
    const { intentId } = await newIntent();
    const r = await call(`/api/checkout/intents/${intentId}/attach`, { json: { transferId: freshTransfer() }, token: STRANGER });
    assert.equal(r.status, 403);
    assert.equal((await call(`/api/checkout/intents/${intentId}/attach`, { json: { transferId: freshTransfer() } })).status, 401);
  });

  it("refuses a transfer for a different amount, reference or a failed payout", async () => {
    const wrongAmount = await newIntent("order-2", 30);
    transferAmount = 25;
    assert.equal((await call(`/api/checkout/intents/${wrongAmount.intentId}/attach`, { json: { transferId: freshTransfer() }, token: OWNER })).status, 400);

    const wrongRef = await newIntent("order-3", 25);
    transferReference = "someone-elses";
    assert.equal((await call(`/api/checkout/intents/${wrongRef.intentId}/attach`, { json: { transferId: freshTransfer() }, token: OWNER })).status, 400);

    for (const state of ["FAILED", "REFUNDED", "MANUAL_REVIEW", "CREATED"]) {
      const { intentId } = await newIntent("order-4", 25);
      transferState = state;
      const r = await call(`/api/checkout/intents/${intentId}/attach`, { json: { transferId: freshTransfer() }, token: OWNER });
      assert.equal(r.status, 400, state);
    }
  });

  it("rejects a code exchange with the wrong secret or the wrong PKCE verifier", async () => {
    const { intentId } = await newIntent();
    const attach = await call(`/api/checkout/intents/${intentId}/attach`, { json: { transferId: freshTransfer() }, token: OWNER });
    const code = new URL(((await attach.json()) as any).redirectUrl).searchParams.get("code")!;
    const badSecret = await call("/api/checkout/token", {
      json: { client_id: "flow-shop", client_secret: "nope", code, code_verifier: VERIFIER },
    });
    assert.equal(badSecret.status, 400);
    const badVerifier = await call("/api/checkout/token", {
      json: { client_id: "flow-shop", client_secret: "flow-secret", code, code_verifier: "x".repeat(43) },
    });
    assert.equal(badVerifier.status, 400);
    const good = await call("/api/checkout/token", {
      json: { client_id: "flow-shop", client_secret: "flow-secret", code, code_verifier: VERIFIER },
    });
    assert.equal(good.status, 200, "failed attempts must not burn the code");
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
    const a = await call(`/api/checkout/intents/${first.intentId}/attach`, { json: { transferId }, token: OWNER });
    assert.equal(a.status, 200);
    const b = await call(`/api/checkout/intents/${second.intentId}/attach`, { json: { transferId }, token: OWNER });
    assert.equal(b.status, 400);
    assert.match(((await b.json()) as any).error, /already paid another checkout/);
    const stillOpen = (await (await call(`/api/checkout/intents/${second.intentId}`)).json()) as any;
    assert.equal(stillOpen.status, "PENDING");
  });

  it("rejects a transferId that could walk the core's paths", async () => {
    const { intentId } = await newIntent();
    for (const transferId of ["..", "../users", "a/b", "%2e%2e", "x".repeat(200)]) {
      const r = await call(`/api/checkout/intents/${intentId}/attach`, { json: { transferId }, token: OWNER });
      assert.equal(r.status, 400, transferId);
    }
  });
});

describe("proxy hygiene", () => {
  it("never forwards a client-supplied X-Forwarded-For or the query string", async () => {
    await fetch(`${base}/api/health?debug=1`, { headers: { "x-forwarded-for": "6.6.6.6" } });
    assert.equal(lastHealth?.url, "/api/health");
    const xff = String(lastHealth?.headers["x-forwarded-for"] ?? "");
    assert.equal(xff.includes("6.6.6.6"), false, xff);
    assert.equal(xff, "127.0.0.1");
  });

  it("does not follow redirects from the core", async () => {
    const r = await call("/api/quotes", { json: {}, token: OWNER });
    assert.equal(r.status, 302);
    assert.equal(secretHits, 0);
  });
});
