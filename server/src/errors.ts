/**
 * Error responses that are safe to show a caller.
 *
 * Client mistakes (malformed or oversized bodies) get a plain 4xx. Anything
 * unexpected gets a 500 carrying only a short reference; the detail goes to the
 * log under that reference, so an operator can find it and a caller learns
 * nothing about paths, queries or upstream text.
 */
import { randomBytes } from "node:crypto";
import type express from "express";

export function createErrorHandler(
  log: (...args: unknown[]) => void = (...args) => console.error(...args),
): express.ErrorRequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err, _req, res, _next) => {
    const status = (err as { status?: unknown; statusCode?: unknown } | undefined)?.status ??
      (err as { statusCode?: unknown } | undefined)?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? "request body too large" : "bad request" });
      return;
    }
    const ref = randomBytes(6).toString("hex");
    log(`[error ${ref}]`, err);
    res.status(500).json({ error: "checkout service error", ref });
  };
}
