/**
 * Fixed-window, in-memory rate limiter, keyed on the client address unless told
 * otherwise (a merchant's client id, say).
 *
 * One process, so no shared state: fine for a single checkout instance, and an
 * honest limit to state if this is ever scaled out. IPv6 clients are keyed on
 * their /64, because a single subscriber typically controls the whole prefix and
 * would otherwise get a fresh bucket per address.
 */
import type express from "express";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  now?: () => number;
  /** The bucket for a request; undefined leaves the request to the other limits. */
  keyOf?: (req: express.Request) => string | undefined;
}

function expandV6(ip: string): string[] {
  const [head = "", tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  if (tail === undefined) return h;
  const t = tail ? tail.split(":") : [];
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
}

/** Bucket key for a client address: IPv4 as-is, IPv6 reduced to its /64. */
export function ipKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const plain = ip.replace(/^::ffff:/i, "");
  if (!plain.includes(":")) return plain;
  return expandV6(plain)
    .slice(0, 4)
    .map((g) => g.padStart(4, "0").toLowerCase())
    .join(":");
}

export function createRateLimiter(opts: RateLimitOptions): express.RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const clock = opts.now ?? Date.now;
  const keyOf = opts.keyOf ?? ((req) => ipKey(req.ip ?? req.socket?.remoteAddress));
  let nextSweep = 0;

  return (req, res, next) => {
    const t = clock();
    if (t >= nextSweep) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      nextSweep = t + opts.windowMs;
    }
    const key = keyOf(req);
    if (key === undefined) return next();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));
      res.status(429).json({ error: "too many requests" });
      return;
    }
    next();
  };
}
