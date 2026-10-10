/**
 * Checkout service configuration.
 *
 * This service holds no keys of its own beyond merchant credential hashes.
 * Everything it knows about users comes from the core Zold API; the decisions
 * here are which origin we are served from, which core endpoints the browser may
 * reach through us, and how strictly we refuse to start when misconfigured.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFileStrict } from "./env-file.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Load .env if present (Node's own parser; no dotenv dependency), same as
// the core app. Secrets stay out of the repo — see .env.example. No file means
// the defaults apply; a file that cannot be read, or has a line the loader would
// skip or misread, stops the service with one line naming the file and the
// line (see env-file.ts). CHECKOUT_ENV_FILE points it elsewhere, e.g. in tests.
try {
  loadEnvFileStrict(process.env.CHECKOUT_ENV_FILE || path.join(ROOT, ".env"));
} catch (e) {
  console.error(`checkout: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const bool = (v: string | undefined, dflt = false) =>
  v === undefined || v === "" ? dflt : v === "1" || v.toLowerCase() === "true";

/**
 * A numeric setting must be a positive number. A malformed value is an error,
 * never NaN: `count > NaN` and `amount > NaN` are always false, so a typo would
 * silently switch a rate limit or an amount cap off.
 */
const num = (name: string, v: string | undefined, dflt: number): number => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  // The setting is named, its value is not: config errors end up in logs.
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
};

const proxyHops = (v: string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error("TRUSTED_PROXY_HOPS must be a whole number of 0 or more");
  return n;
};

/**
 * Whole seconds, 10 to 3600. A fraction or a value past setInterval's 24.8-day
 * limit would make the poll fire every millisecond.
 */
const MIN_SETTLE_SECONDS = 10;
const MAX_SETTLE_SECONDS = 3600;
const settleSeconds = (v: string | undefined): number => {
  if (v === undefined || v === "") return 60;
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_SETTLE_SECONDS || n > MAX_SETTLE_SECONDS) {
    throw new Error(`SETTLE_POLL_SECONDS must be a whole number from ${MIN_SETTLE_SECONDS} to ${MAX_SETTLE_SECONDS}`);
  }
  return n;
};

const environment = (): "production" | "development" | "unset" => {
  const e = process.env.NODE_ENV;
  if (e === "production") return "production";
  return e === "development" || e === "test" ? "development" : "unset";
};

export interface Config {
  port: number;
  coreApiUrl: string;
  coreTimeoutMs: number;
  publicOrigin: string;
  /** Where new users create a Zold account (the checkout only serves existing users). */
  appUrl: string;
  forwardClientIp: boolean;
  allowDevShortcuts: boolean;
  jsonBodyLimit: string;
  subjectSecret: string;
  /** NODE_ENV=production: turns on the fail-closed startup checks. */
  production: boolean;
  /** What NODE_ENV said. "unset" is refused when the public origin looks hosted. */
  environment: "production" | "development" | "unset";
  /** Most open (pending) checkouts one merchant may have at a time. */
  maxPendingIntents: number;
  /** Cap for checkouts started through the unauthenticated front channel. Smaller, and counted separately. */
  maxPendingFrontIntents: number;
  /** Reverse-proxy hops in front of this process (Express `trust proxy`); undefined = not declared. */
  trustedProxyHops?: number;
  /** Largest checkout amount accepted, in EUR. */
  maxAmountEur: number;
  rateLimit: { windowMs: number; general: number; credential: number; client: number };
  /**
   * Bearer credential for Zold's checkout-service read (GET
   * /api/service/checkout/transfers/:id), issued and rotated by a Zold operator.
   * Empty: AUTHORIZED checkouts are never settled to PAID or FAILED.
   */
  zoldServiceToken: string;
  /** Standard Webhooks secret (`whsec_...`) for Zold's state-change hint. Empty: no webhook, polling only. */
  zoldWebhookSecret: string;
  /** How often AUTHORIZED checkouts are checked for a final payout state. */
  settlePollMs: number;
  /** SETTLE_DISABLED=1: run in production without ZOLD_SERVICE_TOKEN, knowing nothing settles. */
  settleDisabled: boolean;
}

const publicOrigin = (process.env.CHECKOUT_PUBLIC_ORIGIN ?? "http://localhost:3100").replace(/\/+$/, "");

export const CONFIG: Config = {
  port: num("CHECKOUT_PORT", process.env.CHECKOUT_PORT, 3100),

  /** Base URL of the core Zold API (the `services/api` server of the main repo). */
  coreApiUrl: (process.env.CORE_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),

  /** How long we wait on the core API before giving up on a request. */
  coreTimeoutMs: num("CORE_TIMEOUT_MS", process.env.CORE_TIMEOUT_MS, 30_000),

  /**
   * Public origin this service is served from. It must appear in the core API's
   * WEBAUTHN_ORIGINS, or every passkey ceremony started here is rejected.
   */
  publicOrigin,

  /** The main Zold app, where an account is created. Defaults to /app on this origin. */
  appUrl: (process.env.ZOLD_APP_URL ?? `${publicOrigin}/app`).replace(/\/+$/, ""),

  /**
   * Send X-Forwarded-For to the core API so its per-IP rate limits key on the
   * real client rather than on this process.
   */
  forwardClientIp: bool(process.env.FORWARD_CLIENT_IP, true),

  /**
   * Local-only convenience: seed a demo merchant (`redirectUris: ["*"]`) so the
   * flow is exercisable without a partner. The core no longer has simulated KYC
   * or deposit routes, so this flag does nothing else. Refused outright unless
   * the core API is on loopback, and refused in production.
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
   * client secrets for exactly that reason.
   */
  subjectSecret: process.env.CHECKOUT_SUBJECT_SECRET ?? "",

  production: process.env.NODE_ENV === "production",
  environment: environment(),

  trustedProxyHops: proxyHops(process.env.TRUSTED_PROXY_HOPS),

  maxAmountEur: num("CHECKOUT_MAX_AMOUNT_EUR", process.env.CHECKOUT_MAX_AMOUNT_EUR, 10_000),
  maxPendingIntents: num("CHECKOUT_MAX_PENDING_INTENTS", process.env.CHECKOUT_MAX_PENDING_INTENTS, 1000),
  maxPendingFrontIntents: num("CHECKOUT_MAX_PENDING_FRONT_INTENTS", process.env.CHECKOUT_MAX_PENDING_FRONT_INTENTS, 200),

  rateLimit: {
    windowMs: 60_000,
    // Per client address, per window. The credential bucket applies per route.
    general: num("RATE_LIMIT_GENERAL", process.env.RATE_LIMIT_GENERAL, 300),
    credential: num("RATE_LIMIT_CREDENTIAL", process.env.RATE_LIMIT_CREDENTIAL, 20),
    // Per merchant, across every address: front-channel checkouts started per window.
    client: num("RATE_LIMIT_CLIENT", process.env.RATE_LIMIT_CLIENT, 60),
  },

  zoldServiceToken: (process.env.ZOLD_SERVICE_TOKEN ?? "").trim(),
  zoldWebhookSecret: (process.env.ZOLD_WEBHOOK_SECRET ?? "").trim(),
  settlePollMs: settleSeconds(process.env.SETTLE_POLL_SECONDS) * 1000,
  settleDisabled: bool(process.env.SETTLE_DISABLED, false),
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Is the configured core API a loopback address? */
export function coreIsLoopback(cfg: Config = CONFIG): boolean {
  return isLoopbackUrl(cfg.coreApiUrl);
}

/** Is this service itself served from a loopback address? */
export function originIsLoopback(cfg: Config = CONFIG): boolean {
  return isLoopbackUrl(cfg.publicOrigin);
}

/**
 * The demo merchant has a published secret and accepts any redirect URI, so it
 * must only exist where nobody else can reach it: it needs the opt-in, a loopback
 * core AND a loopback public origin. A loopback core alone says nothing about who
 * can reach this service.
 */
export function devShortcutsEnabled(cfg: Config = CONFIG): boolean {
  return cfg.allowDevShortcuts && coreIsLoopback(cfg) && originIsLoopback(cfg);
}

const MIN_PRODUCTION_SECRET_LENGTH = 32;

/** What Zold issues: `zsc_` and 32 random bytes in base64url. */
const SERVICE_TOKEN = /^zsc_[A-Za-z0-9_-]{43}$/;
/** Standard Webhooks: `whsec_` and a base64 key, which Zold requires to be at least 24 bytes. */
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/]+={0,2}$/;
const MIN_WEBHOOK_KEY_BYTES = 24;

/** Settlement settings. Errors name the setting, never its value. */
function assertSettlementSane(cfg: Config): void {
  if (cfg.zoldServiceToken && !SERVICE_TOKEN.test(cfg.zoldServiceToken)) {
    throw new Error("ZOLD_SERVICE_TOKEN is not a Zold checkout-service token (zsc_ and 43 base64url characters).");
  }
  if (!cfg.zoldWebhookSecret) return;
  if (!cfg.zoldServiceToken) {
    throw new Error(
      "ZOLD_WEBHOOK_SECRET is set but ZOLD_SERVICE_TOKEN is not. The webhook only names a transfer to read, " +
        "and reading it needs the service token.",
    );
  }
  if (
    !WEBHOOK_SECRET.test(cfg.zoldWebhookSecret) ||
    Buffer.from(cfg.zoldWebhookSecret.slice("whsec_".length), "base64").length < MIN_WEBHOOK_KEY_BYTES
  ) {
    throw new Error(`ZOLD_WEBHOOK_SECRET must be whsec_ and a base64 key of at least ${MIN_WEBHOOK_KEY_BYTES} bytes.`);
  }
}

/** Said at startup when nothing will move an AUTHORIZED checkout on; not a refusal, since it was the old behaviour. */
export function settlementWarning(cfg: Config = CONFIG): string | undefined {
  if (cfg.zoldServiceToken) return undefined;
  return "ZOLD_SERVICE_TOKEN is not set: AUTHORIZED checkouts will never move to PAID or FAILED.";
}

/** Refuse to start on a configuration that would be unsafe or silently wrong. */
export function assertConfigSane(cfg: Config = CONFIG): void {
  if (!cfg.subjectSecret) {
    throw new Error(
      "CHECKOUT_SUBJECT_SECRET is not set. It keys the pseudonymous payer id merchants use to " +
        "recognise a returning customer, so it cannot be generated per start — refusing to run " +
        "rather than handing every merchant a different answer after each restart.",
    );
  }
  if (cfg.allowDevShortcuts && !coreIsLoopback(cfg)) {
    throw new Error(
      `ALLOW_DEV_SHORTCUTS=1 but CORE_API_URL is ${cfg.coreApiUrl}, which is not loopback. ` +
        "The demo merchant is local-only; refusing to start.",
    );
  }
  if (cfg.allowDevShortcuts && !originIsLoopback(cfg)) {
    throw new Error(
      `ALLOW_DEV_SHORTCUTS=1 but CHECKOUT_PUBLIC_ORIGIN is ${cfg.publicOrigin}, which is not loopback. ` +
        "The demo merchant's secret is published and its redirect URIs are a wildcard, so it must not be " +
        "reachable from anywhere but this machine; refusing to start.",
    );
  }
  assertSettlementSane(cfg);
  // Whatever NODE_ENV says: a staging box would send the token in the clear too.
  if (cfg.zoldServiceToken && !coreIsLoopback(cfg) && !cfg.coreApiUrl.startsWith("https://")) {
    throw new Error("CORE_API_URL must be https (or loopback) when ZOLD_SERVICE_TOKEN is set: it carries the token.");
  }
  if (!/^https?:\/\//.test(cfg.appUrl) || !URL.canParse(cfg.appUrl)) {
    throw new Error(`ZOLD_APP_URL must be an http(s) URL, got "${cfg.appUrl}".`);
  }
  if (!cfg.production && cfg.environment === "unset") {
    // Production mode is opt-in, so a hosted deployment that forgot NODE_ENV
    // would otherwise skip every check below without a word.
    let host = "";
    try {
      host = new URL(cfg.publicOrigin).hostname;
    } catch {
      /* reported below if production */
    }
    if (host && !LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `CHECKOUT_PUBLIC_ORIGIN is ${cfg.publicOrigin}, which is not localhost, but NODE_ENV is not set. ` +
          "Set NODE_ENV=production for a hosted deployment, or NODE_ENV=development to say this really is a local run.",
      );
    }
  }
  if (!cfg.production) return;

  if (!cfg.zoldServiceToken && !cfg.settleDisabled) {
    throw new Error(
      "ZOLD_SERVICE_TOKEN is not set: AUTHORIZED checkouts would never move to PAID or FAILED, and merchants " +
        "would wait on them for ever. Set it, or SETTLE_DISABLED=1 to run without settlement on purpose.",
    );
  }
  if (cfg.allowDevShortcuts) {
    throw new Error("ALLOW_DEV_SHORTCUTS must not be set in production: it seeds a wildcard-redirect demo merchant.");
  }
  if (cfg.subjectSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    throw new Error(`CHECKOUT_SUBJECT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production.`);
  }
  let origin: URL;
  try {
    origin = new URL(cfg.publicOrigin);
  } catch {
    throw new Error(`CHECKOUT_PUBLIC_ORIGIN is not a valid URL: ${cfg.publicOrigin}`);
  }
  if (origin.protocol !== "https:") throw new Error("CHECKOUT_PUBLIC_ORIGIN must be https in production.");
  if (LOOPBACK_HOSTS.has(origin.hostname)) throw new Error("CHECKOUT_PUBLIC_ORIGIN must not be localhost in production.");
  if (!Number.isInteger(cfg.trustedProxyHops) || (cfg.trustedProxyHops as number) < 0) {
    throw new Error(
      "TRUSTED_PROXY_HOPS must be set to a whole number (0 if nothing sits in front of this service) in production, " +
        "so client addresses used for rate limiting are not spoofable.",
    );
  }
}
