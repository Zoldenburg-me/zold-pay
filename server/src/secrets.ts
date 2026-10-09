/**
 * Secret handling for merchant credentials and one-time tokens.
 *
 * Everything this service issues (client secrets, authorization codes, status
 * tokens) is 24+ random bytes chosen by us, so a plain SHA-256 is enough to
 * store: there is nothing to brute-force offline, and the stored value cannot
 * be replayed. Only the hash is persisted; the plaintext exists once, in the
 * response that issues it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time comparison that leaks neither content nor length. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Does `provided` hash to `storedHash`? False for anything that is not a non-empty string. */
export function secretMatchesHash(provided: unknown, storedHash: string | undefined): boolean {
  if (typeof provided !== "string" || provided === "" || !storedHash) return false;
  return safeEqual(hashSecret(provided), storedHash);
}

export const newToken = (bytes = 24): string => randomBytes(bytes).toString("base64url");
