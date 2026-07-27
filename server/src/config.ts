/**
 * Checkout service configuration.
 *
 * This service holds no keys and no database. Everything it knows comes from
 * the core Zold API; the only real decisions here are which origin we are
 * served from and which core endpoints the browser is allowed to reach
 * through us.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Load .env if present (Node 20.12+ built-in; no dotenv dependency), same as
// the core app. Secrets stay out of the repo — see .env.example.
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — defaults apply
}

const bool = (v: string | undefined, dflt = false) =>
  v === undefined || v === "" ? dflt : v === "1" || v.toLowerCase() === "true";

export const CONFIG = {
  port: Number(process.env.CHECKOUT_PORT ?? 3100),

  /** Base URL of the core Zold API (the `services/api` server of the main repo). */
  coreApiUrl: (process.env.CORE_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),

  /** How long we wait on the core API before giving up on a request. */
  coreTimeoutMs: Number(process.env.CORE_TIMEOUT_MS ?? 30_000),

  /**
   * Public origin this service is served from, e.g. https://checkout.zold.app.
   * It must appear in the core API's WEBAUTHN_ORIGINS, or every passkey
   * ceremony started here is rejected server-side.
   */
  publicOrigin: (process.env.CHECKOUT_PUBLIC_ORIGIN ?? "http://localhost:3100").replace(/\/+$/, ""),

  /**
   * Send X-Forwarded-For to the core API so its per-IP rate limits key on the
   * real client rather than on this process.
   *
   * Deliberate consequence: the core refuses its /api/simulate/* routes for any
   * request carrying a forwarding header, so with this on (the default, and
   * correct for a hosted deploy) the simulation endpoints are NOT reachable
   * through the proxy. The dev shortcuts below exist for that reason — they
   * call the core from this process, on loopback, with no forwarding header.
   */
  forwardClientIp: bool(process.env.FORWARD_CLIENT_IP, true),

  /**
   * Local/sandbox conveniences: self-approve KYC and credit a simulated SEPA
   * deposit so a new-user run can complete without a funding rail. Off unless
   * asked for, and refused outright unless the core API is on loopback — these
   * mint balance out of nothing and must never be reachable on a hosted deploy.
   */
  allowDevShortcuts: bool(process.env.ALLOW_DEV_SHORTCUTS, false),

  /** Max JSON body accepted from the browser. */
  jsonBodyLimit: process.env.JSON_BODY_LIMIT ?? "64kb",

  /**
   * HMAC key for the per-merchant pseudonymous payer subject.
   *
   * Must be stable for the life of the deployment: it is what makes a repeat
   * payer recognisable to a merchant, so rotating it silently turns every
   * returning customer into a new one. Kept separate from the merchants' own
   * client secrets for exactly that reason — a secret rotation must not
   * reshuffle identities.
   */
  subjectSecret: process.env.CHECKOUT_SUBJECT_SECRET ?? "",
};

/** Is the configured core API a loopback address? */
export function coreIsLoopback(): boolean {
  try {
    const h = new URL(CONFIG.coreApiUrl).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Dev shortcuts require BOTH the opt-in and a loopback core. Asking for them
 * against a remote core is a configuration mistake worth failing loudly on
 * rather than quietly ignoring.
 */
export function devShortcutsEnabled(): boolean {
  return CONFIG.allowDevShortcuts && coreIsLoopback();
}

export function assertConfigSane(): void {
  if (!CONFIG.subjectSecret) {
    throw new Error(
      "CHECKOUT_SUBJECT_SECRET is not set. It keys the pseudonymous payer id merchants use to " +
        "recognise a returning customer, so it cannot be generated per start — refusing to run " +
        "rather than handing every merchant a different answer after each restart.",
    );
  }
  if (CONFIG.allowDevShortcuts && !coreIsLoopback()) {
    throw new Error(
      `ALLOW_DEV_SHORTCUTS=1 but CORE_API_URL is ${CONFIG.coreApiUrl}, which is not loopback. ` +
        "Simulated KYC approval and simulated deposits are local-only; refusing to start.",
    );
  }
}
