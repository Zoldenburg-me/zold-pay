/**
 * Shopify request authentication and the shapes Shopify hands us, ported from
 * Zold's services/api/src/shopify/hmac.ts.
 *
 *  - Webhooks carry `X-Shopify-Hmac-Sha256`: base64 of HMAC-SHA256 over the RAW
 *    body with the app secret. It must be computed over the bytes as sent, which
 *    is why the webhook route is mounted with express.raw before any JSON parser.
 *  - The OAuth callback carries `hmac` in the QUERY: hex of HMAC-SHA256 over the
 *    other parameters, sorted by key and joined as key=value&…
 *
 * Every comparison is constant-time. A shop domain is checked against the
 * myshopify.com shape before it becomes a host we call.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const MAX_SHOP = 255;

export const normaliseShop = (shop: unknown): string => String(shop ?? "").trim().toLowerCase();

export function isValidShopDomain(shop: unknown): shop is string {
  return typeof shop === "string" && shop.length <= MAX_SHOP && SHOP_RE.test(shop);
}

function sameBytes(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Two lower-case hex strings, compared in constant time. False for anything that is not hex. */
export function sameHex(a: string, b: string): boolean {
  return a.length === b.length && /^[0-9a-f]+$/.test(a) && /^[0-9a-f]+$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** `X-Shopify-Hmac-Sha256` over the raw body. */
export function verifyBodyHmac(rawBody: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!rawBody || !header || !secret) return false;
  return sameBytes(signBody(rawBody, secret), header.trim());
}

export function signBody(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

/** The OAuth callback's `hmac` query parameter. */
export function verifyQueryHmac(query: Record<string, unknown>, secret: string): boolean {
  const provided = typeof query.hmac === "string" ? query.hmac : "";
  if (!provided || !secret) return false;
  return sameBytes(signQuery(query, secret), provided);
}

export function signQuery(query: Record<string, unknown>, secret: string): string {
  // Shopify's documented escaping for the OAuth message: & and % in keys and
  // values, = in keys.
  const esc = (s: string, key: boolean) => s.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, key ? "%3D" : "=");
  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => {
      const v = query[k];
      const val = Array.isArray(v) ? v.join(",") : String(v ?? "");
      return `${esc(k, true)}=${esc(val, false)}`;
    })
    .join("&");
  return createHmac("sha256", secret).update(message).digest("hex");
}

const MAX_ORDER_NAME = 40;

/**
 * Shopify's order name ("#1001"), fit to store and to put in a log line:
 * control characters removed (a newline would forge a log line), trimmed, at
 * most 40 characters. Undefined when nothing is left.
 */
export function cleanOrderName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim();
  return name && name.length <= MAX_ORDER_NAME ? name : undefined;
}

/** `gid://shopify/Order/<digits>` from a numeric id or a gid, or undefined. */
export function orderGidOf(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim();
  if (/^\d{1,20}$/.test(s)) return `gid://shopify/Order/${s}`;
  if (/^gid:\/\/shopify\/Order\/\d{1,20}$/.test(s)) return s;
  return undefined;
}

export const numericOrderId = (gid: string): string => gid.slice(gid.lastIndexOf("/") + 1);

/** What Liquid's `{{ id | hmac_sha256: key }}` renders: lower-case hex, the key used as text. */
export const orderLinkProof = (secret: string, orderId: string): string =>
  createHmac("sha256", secret).update(orderId).digest("hex");
