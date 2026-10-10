/**
 * Zold's checkout webhook: "transfer X changed state, read it now".
 *
 *   POST /bff/zold/webhook   body {"transferId": "..."}, Standard Webhooks signed
 *
 * Mounted only when ZOLD_WEBHOOK_SECRET is set, and before the JSON parser,
 * because the signature is over the raw bytes. The delivery is never believed
 * about a state: it only makes the transfer's checkout due on the settle
 * poller's next tick (settle.ts), so even a valid replay causes one read and
 * nothing more. Zold holds its retries in memory, so the poller, not this, is
 * what makes settlement reliable.
 *
 * Signing (standardwebhooks.com, as Zold's http/standard-webhooks.ts): HMAC-SHA256
 * over `${webhook-id}.${webhook-timestamp}.${rawBody}` with the base64-decoded
 * `whsec_` key, sent as `v1,<base64>`, several space-separated during a rotation.
 * Zold sends a unix-seconds timestamp; that is the only form accepted here.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { isId } from "./validate.js";

/** The replay window: a delivery signed further from now than this is refused. */
export const TOLERANCE_SEC = 300;
/** The body is `{"transferId":"<uuid>"}`; anything near this size is not from Zold. */
const BODY_LIMIT = "4kb";
const MAX_ID = 128;
const MAX_SIGNATURE = 1024;
/** Refused deliveries are logged at most this often, as a count, never with header values. */
const REFUSED_LOG_INTERVAL_MS = 60_000;
/**
 * Delivery ids remembered for dedupe. Past this the oldest is forgotten even
 * inside the replay window; filling it takes the secret, and a replay then costs
 * one more read.
 */
const MAX_REMEMBERED = 10_000;
const UNIX_SECONDS = /^\d{1,12}$/;

type WebhookInput = {
  id: string;
  timestamp: string;
  signature: string;
  raw: Buffer;
  secret: string;
  now?: number;
};

export function verifyStandardWebhook(input: WebhookInput): boolean {
  return checkStandardWebhook(input) === "ok";
}

/** Why a delivery is refused, so the log can tell a wrong secret from a drifting clock. */
function checkStandardWebhook(input: WebhookInput): "ok" | "bad_timestamp" | "bad_signature" {
  const { id, timestamp, signature, raw, secret } = input;
  if (!id || !signature || !secret) return "bad_signature";
  if (!UNIX_SECONDS.test(timestamp)) return "bad_timestamp";
  const now = input.now ?? Date.now();
  if (Math.abs(now - Number(timestamp) * 1000) > TOLERANCE_SEC * 1000) return "bad_timestamp";
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]);
  const expected = Buffer.from(`v1,${createHmac("sha256", key).update(signed).digest("base64")}`);
  const matches = signature
    .split(" ")
    .filter(Boolean)
    .some((candidate) => {
      const b = Buffer.from(candidate);
      return b.length === expected.length && timingSafeEqual(b, expected);
    });
  return matches ? "ok" : "bad_signature";
}

/** `{"transferId": id}` and nothing else, or undefined. */
function parseBody(raw: Buffer): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  const transferId = (body as { transferId?: unknown }).transferId;
  return keys.length === 1 && isId(transferId) ? transferId : undefined;
}

export interface ZoldWebhookOptions {
  secret: string;
  /** Ask for this transfer's checkout to be read soon. Must not wait on Zold. */
  onTransfer: (transferId: string) => void;
  now?: () => number;
  log?: (...args: unknown[]) => void;
}

export function createZoldWebhookRouter(opts: ZoldWebhookOptions): express.Router {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? console.error;
  const seen = new Map<string, number>();
  const refused = { bad_signature: 0, bad_timestamp: 0 };
  let refusedLoggedAt = Number.NEGATIVE_INFINITY;

  /**
   * A forgery attempt, a secret that differs from Zold's, or our clock and Zold's
   * drifting apart, shows up in the log, as counts and never header values.
   */
  const noteRefused = (at: number, why: keyof typeof refused) => {
    refused[why]++;
    if (at - refusedLoggedAt < REFUSED_LOG_INTERVAL_MS) return;
    const total = refused.bad_signature + refused.bad_timestamp;
    log(
      `checkout webhook: refused ${total} deliveries since the last report ` +
        `(${refused.bad_signature} bad signature: is ZOLD_WEBHOOK_SECRET Zold's? ${refused.bad_timestamp} outside the time window: clock drift?)`,
    );
    refused.bad_signature = 0;
    refused.bad_timestamp = 0;
    refusedLoggedAt = at;
  };

  const remember = (id: string, at: number) => {
    for (const [k, until] of seen) {
      if (until > at && seen.size < MAX_REMEMBERED) break;
      seen.delete(k);
    }
    // Kept for twice the window: by then a replay is refused on its timestamp anyway.
    seen.set(id, at + 2 * TOLERANCE_SEC * 1000);
  };

  const router = express.Router();
  router.post(
    "/bff/zold/webhook",
    (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ error: "send application/json" })),
    express.raw({ type: () => true, limit: BODY_LIMIT }),
    (req, res) => {
      const id = req.header("webhook-id") ?? "";
      const timestamp = req.header("webhook-timestamp") ?? "";
      const signature = req.header("webhook-signature") ?? "";
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const at = now();
      const verdict =
        id.length > MAX_ID || signature.length > MAX_SIGNATURE
          ? "bad_signature"
          : checkStandardWebhook({ id, timestamp, signature, raw, secret: opts.secret, now: at });
      if (verdict !== "ok") {
        noteRefused(at, verdict);
        return res.status(401).json({ error: "bad signature" });
      }
      if (seen.has(id)) return res.status(204).end();
      const transferId = parseBody(raw);
      if (!transferId) return res.status(400).json({ error: "expected {transferId}" });
      remember(id, at);
      // Same answer whether or not the transfer is one of ours.
      opts.onTransfer(transferId);
      res.status(204).end();
    },
  );
  return router;
}
