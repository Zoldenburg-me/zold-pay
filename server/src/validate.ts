/**
 * Input validation for checkout intents, at the boundary where merchants and
 * browsers hand us untrusted values. Everything downstream (the store, the
 * redirect back to the merchant, the SEPA remittance) can then rely on the
 * shapes enforced here.
 */

export interface IntentInput {
  amountEur: number;
  reference: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  destinationIban?: string;
}

export type ParsedIntent = { ok: true; value: IntentInput } | { ok: false; error: string };

export interface ParseOptions {
  maxAmountEur: number;
  /** Permit http:// redirect URIs on loopback hosts (local demo only). */
  allowInsecureLoopback: boolean;
}

const MAX_REFERENCE = 140; // the SEPA remittance field
const MAX_STATE = 512;
const MAX_REDIRECT_URI = 2048;
const MAX_IBAN_INPUT = 64;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/; // base64url of a SHA-256 digest
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const fail = (error: string): ParsedIntent => ({ ok: false, error });

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A plain identifier. Used wherever a caller-supplied value becomes a path
 * segment on the core API: `..` survives encodeURIComponent, and fetch then
 * normalises it away, which would walk off the intended route.
 */
export const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

function parseAmount(v: unknown, max: number): number | undefined {
  if (typeof v !== "number" && !(typeof v === "string" && v.trim() !== "")) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) return undefined;
  return Math.round(n * 100) / 100 === n ? n : undefined; // at most 2 decimals
}

function redirectProblem(v: unknown, allowInsecureLoopback: boolean): string | undefined {
  if (typeof v !== "string" || v === "" || v.length > MAX_REDIRECT_URI) return "redirect_uri is required and must be a URL";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "redirect_uri is not a valid URL";
  }
  const secure = u.protocol === "https:";
  const loopbackHttp = allowInsecureLoopback && u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  if (!secure && !loopbackHttp) return "redirect_uri must use https";
  if (u.username || u.password) return "redirect_uri must not contain credentials";
  if (u.hash) return "redirect_uri must not contain a fragment";
  return undefined;
}

/** Parse the snake_case parameters of /authorize or POST /intents. Never throws. */
export function parseIntentInput(raw: Record<string, unknown>, opts: ParseOptions): ParsedIntent {
  const amountEur = parseAmount(raw.amount, opts.maxAmountEur);
  if (amountEur === undefined) {
    return fail(`amount must be a positive number up to ${opts.maxAmountEur} EUR with at most 2 decimals`);
  }

  const reference = raw.reference ?? "";
  if (typeof reference !== "string" || reference.length > MAX_REFERENCE) {
    return fail(`reference must be a string of ${MAX_REFERENCE} characters or fewer`);
  }
  const state = raw.state ?? "";
  if (typeof state !== "string" || state.length > MAX_STATE) {
    return fail(`state must be a string of ${MAX_STATE} characters or fewer`);
  }

  const challenge = raw.code_challenge;
  if (typeof challenge !== "string" || !CHALLENGE_RE.test(challenge)) {
    return fail("code_challenge must be a 43-character base64url S256 challenge");
  }
  const method = raw.code_challenge_method;
  if (method !== undefined && method !== "S256") return fail("only code_challenge_method S256 is supported");

  const problem = redirectProblem(raw.redirect_uri, opts.allowInsecureLoopback);
  if (problem) return fail(problem);

  const dest = raw.destination_iban;
  if (dest !== undefined && dest !== null && dest !== "") {
    if (typeof dest !== "string" || dest.length > MAX_IBAN_INPUT) return fail("destination_iban is invalid");
  }

  return {
    ok: true,
    value: {
      amountEur,
      reference,
      redirectUri: raw.redirect_uri as string,
      state,
      codeChallenge: challenge,
      ...(typeof dest === "string" && dest !== "" ? { destinationIban: dest } : {}),
    },
  };
}
