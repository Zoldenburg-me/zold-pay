/**
 * Minimal typed client for the core Zold API.
 *
 * Used by this service's own routes (dev shortcuts, health). The browser does
 * not go through here — it goes through the allowlisted proxy in proxy.ts, so
 * that a route reachable from the checkout origin is always a deliberate entry
 * in one list rather than whatever this file happens to expose.
 */
import { CONFIG } from "./config.js";

export interface CoreError extends Error {
  status: number;
  body: unknown;
}

function coreError(status: number, body: any): CoreError {
  const message =
    (body && typeof body === "object" && typeof body.error === "string" && body.error) ||
    `core API returned ${status}`;
  return Object.assign(new Error(message), { status, body }) as CoreError;
}

export interface CoreCallOptions {
  method?: string;
  body?: unknown;
  /** Caller's session bearer, forwarded verbatim. */
  sessionToken?: string;
  /**
   * Leave X-Forwarded-For off. Required for the core's /api/simulate/* routes,
   * which refuse any request carrying a forwarding header.
   */
  headers?: Record<string, string>;
}

export async function core<T = any>(path: string, opts: CoreCallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.sessionToken) headers.authorization = `Bearer ${opts.sessionToken}`;

  const res = await fetch(CONFIG.coreApiUrl + path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(CONFIG.coreTimeoutMs),
  });

  const text = await res.text();
  let data: any = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 500) };
    }
  }
  if (!res.ok) throw coreError(res.status, data);
  return data as T;
}
