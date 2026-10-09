import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "pay-http-"));
process.env.CHECKOUT_DB_PATH = path.join(dir, "checkout.json");
process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";
process.env.CHECKOUT_PUBLIC_ORIGIN = "http://localhost:3100";
process.env.CORE_API_URL = "http://127.0.0.1:9"; // nothing listens: core is unreachable
process.env.RATE_LIMIT_CREDENTIAL = "12"; // per route and client; the intent tests make 10 calls
process.env.RATE_LIMIT_GENERAL = "1000";

const { app } = await import("../server/src/server.js");
const { store } = await import("../server/src/store.js");
const { hashSecret } = await import("../server/src/secrets.js");
const { createErrorHandler } = await import("../server/src/errors.js");

const CHALLENGE = createHash("sha256").update("v".repeat(43)).digest("base64url");
let base = "";
let server: ReturnType<typeof app.listen>;

before(async () => {
  store.addMerchant({
    id: "m-http", name: "HTTP Shop", clientId: "http-shop", clientSecretHash: hashSecret("http-secret"),
    settlementIbans: ["DE89370400440532013000"], redirectUris: ["https://shop.test/cb", "*"], createdAt: new Date().toISOString(),
  });
  await new Promise<void>((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const call = (p: string, init: RequestInit & { json?: unknown } = {}) =>
  fetch(base + p, {
    ...init,
    headers: { ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers as any) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });

const intentBody = (over: Record<string, unknown> = {}) => ({
  client_id: "http-shop", client_secret: "http-secret", amount: 5, reference: "r", redirect_uri: "https://shop.test/cb",
  state: "s", code_challenge: CHALLENGE, ...over,
});

describe("security headers", () => {
  it("tells the page where new users create an account, and nothing about dev shortcuts", async () => {
    const cfg = (await (await call("/bff/config")).json()) as Record<string, unknown>;
    assert.equal(cfg.publicOrigin, "http://localhost:3100");
    assert.equal(cfg.appUrl, "http://localhost:3100/app");
    assert.equal("devShortcuts" in cfg, false);
  });

  it("sets hardening headers on API responses", async () => {
    const r = await call("/bff/config");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-powered-by"), null);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  it("serves the checkout page with a fresh nonce bound to every inline script and style", async () => {
    const a = await call("/checkout");
    const b = await call("/checkout");
    const [ha, hb] = [a.headers.get("content-security-policy") ?? "", b.headers.get("content-security-policy") ?? ""];
    const na = /'nonce-([^']+)'/.exec(ha)?.[1];
    const nb = /'nonce-([^']+)'/.exec(hb)?.[1];
    assert.ok(na && nb && na !== nb, "nonce must be present and differ per response");
    assert.match(ha, /script-src 'self' 'nonce-/);
    assert.doesNotMatch(ha, /script-src[^;]*unsafe-inline/);
    const html = await a.text();
    assert.equal(html.includes("__N__"), false);
    for (const tag of html.match(/<(script|style)\b[^>]*>/g) ?? []) {
      if (/\bsrc=/.test(tag)) continue;
      assert.ok(tag.includes(`nonce="${na}"`), `inline tag without nonce: ${tag}`);
    }
  });
});

describe("origin policy", () => {
  it("rejects state-changing browser requests from a foreign origin", async () => {
    for (const origin of ["https://evil.test", "null"]) {
      const r = await call("/api/checkout/token", { method: "POST", json: {}, headers: { origin } });
      assert.equal(r.status, 403, origin);
    }
  });
  it("lets server-to-server calls (no Origin) and same-origin calls through", async () => {
    assert.equal((await call("/api/checkout/token", { method: "POST", json: {} })).status, 400);
    const same = await call("/api/checkout/token", { method: "POST", json: {}, headers: { origin: "http://localhost:3100" } });
    assert.equal(same.status, 400);
  });
});

describe("intent creation validation", () => {
  it("creates an intent for a valid request and never echoes the secret", async () => {
    const r = await call("/api/checkout/intents", { method: "POST", json: intentBody() });
    assert.equal(r.status, 201);
    assert.equal((await r.text()).includes("http-secret"), false);
  });
  for (const [name, over] of [
    ["a non-numeric amount", { amount: "abc" }],
    ["an infinite amount", { amount: "Infinity" }],
    ["an enormous amount", { amount: 1e12 }],
    ["a javascript: redirect", { redirect_uri: "javascript:alert(1)" }],
    ["an over-long state", { state: "s".repeat(600) }],
    ["a malformed code challenge", { code_challenge: "short" }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`rejects ${name} with 400`, async () => {
      const r = await call("/api/checkout/intents", { method: "POST", json: intentBody(over) });
      assert.equal(r.status, 400);
    });
  }
  it("answers 401 for unknown clients and wrong secrets alike", async () => {
    assert.equal((await call("/api/checkout/intents", { method: "POST", json: intentBody({ client_id: "nope" }) })).status, 401);
    assert.equal((await call("/api/checkout/intents", { method: "POST", json: intentBody({ client_secret: "nope" }) })).status, 401);
    assert.equal((await call("/api/checkout/intents", { method: "POST", json: intentBody({ client_id: "x".repeat(300) }) })).status, 401);
  });
});

describe("error handling", () => {
  it("answers malformed JSON with 400, not 500", async () => {
    const r = await call("/api/checkout/token", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    assert.equal(r.status, 400);
  });

  it("returns a reference for unexpected errors and never leaks the message", () => {
    const logged: unknown[][] = [];
    const handler = createErrorHandler((...args) => void logged.push(args));
    let status = 0;
    let body: any;
    const res: any = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) };
    handler(new Error("secret db path /etc/shadow"), {} as any, res, () => {});
    assert.equal(status, 500);
    assert.match(body.ref, /^[0-9a-f]{12}$/);
    assert.equal(JSON.stringify(body).includes("shadow"), false);
    assert.ok(JSON.stringify(logged[0]).includes(body.ref));
  });

  it("relays an unreachable core as 502 without leaking addresses", async () => {
    const r = await call("/api/users/u1");
    assert.ok([502, 504].includes(r.status));
    assert.equal((await r.text()).includes("127.0.0.1"), false);
  });
});

describe("sign-in rate limiting", () => {
  it("applies the tight bucket to the login and challenge routes", async () => {
    for (const p of ["/api/passkey/login", "/api/webauthn/challenge"]) {
      const statuses: number[] = [];
      for (let i = 0; i < 15; i++) statuses.push((await call(p, { method: "POST", json: {} })).status);
      assert.ok(statuses.includes(429), `${p}: expected a 429 in ${statuses.join(",")}`);
    }
  });
});

// Last: it exhausts the credential bucket for this client.
describe("rate limiting", () => {
  it("throttles credential endpoints after the configured number of attempts", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      statuses.push((await call("/api/checkout/token", { method: "POST", json: {} })).status);
    }
    assert.ok(statuses.includes(429), `expected a 429 in ${statuses.join(",")}`);
    const limited = await call("/api/checkout/token", { method: "POST", json: {} });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  });
});
