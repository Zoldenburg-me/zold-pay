/**
 * Allowlisted reverse proxy to the core Zold API.
 *
 * The checkout page is served from its own origin, so the browser cannot call
 * the core API directly without CORS and a second set of credentials. It calls
 * us instead and we forward.
 *
 * The list below is an allowlist, not a filter on a pass-through. A blanket
 * `/api/*` proxy would re-expose every core endpoint on a new origin — the
 * operator KYC decision route, the Monerium OAuth callback, the webhook
 * receiver — each of which has its own assumptions about who can reach it.
 * Anything not named here 404s at this service and never reaches the core.
 */
import type express from "express";
import { CONFIG } from "./config.js";

interface Rule {
  method: "GET" | "POST";
  /** Path pattern; `:id` matches one non-empty segment with no slashes. */
  pattern: string;
}

/**
 * Exactly what the checkout page needs for an EXISTING Zold user, and nothing
 * else. Creating an account (signup, passkey registration, Safe deployment,
 * Monerium identity) happens in the main app, which the checkout links new
 * users to; none of those routes are reachable through here.
 */
const ALLOW: Rule[] = [
  // Read back the signed-in user (balances, KYC state).
  { method: "GET", pattern: "/api/users/:id" },
  { method: "GET", pattern: "/api/users/:id/kyc" },

  // WebAuthn: sign in, and step up for sensitive actions.
  { method: "POST", pattern: "/api/webauthn/challenge" },
  { method: "POST", pattern: "/api/passkey/login" },

  // Device key binding, for an existing account that has not bound one yet.
  { method: "POST", pattern: "/api/users/:id/authorizer" },

  // Quote, create, device-sign, submit.
  { method: "POST", pattern: "/api/quotes" },
  { method: "POST", pattern: "/api/transfers" },
  { method: "GET", pattern: "/api/transfers/:id" },
  { method: "POST", pattern: "/api/transfers/:id/authorize" },
];

/**
 * Deliberately NOT proxied, so the reasoning survives the next person reading
 * the list above:
 *   /api/health                 the core's own health output (versions,
 *                               paths) is not the public's; /bff/health says
 *                               only whether the core is reachable.
 *   /api/checkout/*             served by THIS service — it is the
 *                               authorization server. Nothing to forward.
 *   /api/kyc/review             operator token; approving KYC is not a
 *                               checkout capability.
 *   POST /api/users, /api/users/:id/passkey, /api/users/:id/passkey-safe/*
 *                               signup, passkey registration, Safe
 *                               deployment: the main app's job.
 *   /api/users/:id/monerium/*   identity and account linking: the main app.
 *   /api/simulate/*, /kyc/mock-review
 *                               no longer exist in the core; never proxy
 *                               self-approval or minted balance.
 *   /api/webhooks/*             rail callbacks, not user traffic.
 */

/**
 * An id segment is a plain token. This is what stops `..`, `%2e%2e`, `%2F` and
 * friends: `fetch` normalises dot segments, so letting one through would turn
 * `/api/users/..` into a request for `/api/` on the core, around this list.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function matches(rule: Rule, method: string, path: string): boolean {
  if (rule.method !== method) return false;
  const want = rule.pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return false;
  return want.every((seg, i) => (seg === ":id" ? ID_RE.test(got[i] ?? "") : seg === got[i]));
}

export function isAllowed(method: string, path: string): boolean {
  // No percent-encoding in any allowed path: core ids never need it, and a
  // decoded slash or dot is exactly how an allowlist gets walked around.
  if (path.includes("%") || path.includes("//")) return false;
  return ALLOW.some((r) => matches(r, method, path));
}

/**
 * The client address as Express resolved it, honouring only the hops we were
 * told to trust. The inbound X-Forwarded-For is never forwarded: a client could
 * otherwise write the chain the core rate-limits on.
 */
function clientIp(req: express.Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

export const proxy: express.Handler = async (req, res) => {
  const path = req.path;
  if (!isAllowed(req.method, path)) {
    return res.status(404).json({ error: "not a checkout endpoint" });
  }

  const headers: Record<string, string> = { accept: "application/json" };
  const auth = req.header("authorization");
  if (auth) headers.authorization = auth;
  const hasBody = req.method === "POST";
  if (hasBody) headers["content-type"] = "application/json";
  if (CONFIG.forwardClientIp) headers["x-forwarded-for"] = clientIp(req);

  // No allowed route takes a query string, so none is forwarded.
  const url = CONFIG.coreApiUrl + path;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      // The core's answer is passed through as-is; a redirect is never chased
      // to a place the allowlist did not name.
      redirect: "manual",
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(CONFIG.coreTimeoutMs),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.type("application/json");
    // Pass the core's body through unchanged, including its error text: the
    // checkout UI shows the core's own refusal rather than inventing one.
    res.send(text || "{}");
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? "the Zold API did not respond in time" : "could not reach the Zold API",
    });
  }
};
