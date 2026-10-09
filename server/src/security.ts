/**
 * Browser-facing hardening: response headers, a foreign-origin guard for
 * state-changing requests, and a per-response CSP nonce for the checkout page.
 *
 * The checkout URL carries the intent id and the redirect back carries the
 * authorization code, so the page must never leak either through a Referer, be
 * framed, or run injected script next to a device key held in localStorage.
 */
import { randomBytes } from "node:crypto";
import type express from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Applies to every response; the page overrides the CSP with a nonce-bearing one. */
export function securityHeaders(production: boolean): express.RequestHandler {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=()",
    );
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (production) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (req.path.startsWith("/api/") || req.path.startsWith("/bff/")) res.setHeader("Cache-Control", "no-store");
    next();
  };
}

/**
 * Refuse state-changing requests that a browser marks as coming from another
 * origin. Server-to-server calls (the merchant back channel) carry no Origin
 * header and pass; a browser always sends one on a cross-site POST.
 */
export function originPolicy(publicOrigin: string): express.RequestHandler {
  return (req, res, next) => {
    const origin = req.header("origin");
    if (SAFE_METHODS.has(req.method) || origin === undefined || origin === publicOrigin) return next();
    res.status(403).json({ error: "foreign origin" });
  };
}

export const newNonce = (): string => randomBytes(16).toString("base64");

export function pageCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** Mark every inline <script>/<style> (those without a src) with a nonce placeholder. */
export function addNoncePlaceholders(html: string): string {
  return html.replace(/<(script|style)\b((?:(?!\bsrc=)[^>])*)>/g, '<$1$2 nonce="__N__">');
}

export const fillNonce = (template: string, nonce: string): string => template.replaceAll("__N__", nonce);
