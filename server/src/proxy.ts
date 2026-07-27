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

/** Exactly what the checkout page needs, and nothing else. */
const ALLOW: Rule[] = [
  { method: "GET", pattern: "/api/health" },

  // Intent display + the attach that mints the merchant's redirect code.
  { method: "GET", pattern: "/api/checkout/intents/:id" },
  { method: "POST", pattern: "/api/checkout/intents/:id/attach" },

  // Account creation and read-back.
  { method: "POST", pattern: "/api/users" },
  { method: "GET", pattern: "/api/users/:id" },
  { method: "GET", pattern: "/api/users/:id/kyc" },

  // WebAuthn: register, sign in, step up.
  { method: "POST", pattern: "/api/webauthn/challenge" },
  { method: "POST", pattern: "/api/users/:id/passkey" },
  { method: "POST", pattern: "/api/passkey/login" },

  // FP4 device key binding.
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
 *   /api/checkout/authorize     merchant-facing; the merchant calls the core
 *                               directly, it is not a browser route.
 *   /api/checkout/token,        merchant confidential exchange + polling; a
 *   /api/checkout/status/:id    client secret must never transit this origin.
 *   /api/kyc/review             operator token; approving KYC is not a
 *                               checkout capability.
 *   /api/users/:id/kyc/mock-review, /api/simulate/*
 *                               self-approval and minted balance. Reachable
 *                               only via this service's /bff/dev/* routes,
 *                               which are loopback- and opt-in-gated.
 *   /api/users/:id/monerium/*   account linking belongs in the consumer app.
 *   /api/webhooks/*             rail callbacks, not user traffic.
 */

function matches(rule: Rule, method: string, path: string): boolean {
  if (rule.method !== method) return false;
  const want = rule.pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return false;
  return want.every((seg, i) => (seg === ":id" ? got[i].length > 0 && got[i] !== ":id" : seg === got[i]));
}

export function isAllowed(method: string, path: string): boolean {
  return ALLOW.some((r) => matches(r, method, path));
}

/** First hop's client address, for the core's per-IP rate limits. */
function clientIp(req: express.Request): string {
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
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
  if (CONFIG.forwardClientIp) {
    // Append rather than replace: if something already sits in front of us the
    // core needs the whole chain to count hops correctly.
    const existing = req.header("x-forwarded-for");
    headers["x-forwarded-for"] = existing ? `${existing}, ${clientIp(req)}` : clientIp(req);
  }

  const url = CONFIG.coreApiUrl + path + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
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
