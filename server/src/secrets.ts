/**
 * Secret handling for merchant credentials, one-time tokens and the Shopify
 * secrets this service has to use again.
 *
 * Everything this service issues (client secrets, authorization codes, status
 * tokens) is 24+ random bytes chosen by us, so a plain SHA-256 is enough to
 * store: there is nothing to brute-force offline, and the stored value cannot
 * be replayed. Only the hash is persisted; the plaintext exists once, in the
 * response that issues it.
 *
 * A store's Shopify access token and its pay-link secret cannot be hashed: we
 * send the one to Shopify and sign with the other. They are sealed with
 * AES-256-GCM under SHOPIFY_TOKEN_KEY, with `purpose|rowId` as associated data,
 * so a sealed value copied into another row, or into the other field, does not open.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

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

/** What a sealed value is for; part of its associated data. */
export type SealPurpose = "shopify-access-token" | "shopify-link-secret";

const SEAL_VERSION = "v1";
const SEAL_KEY_BYTES = 32;
const SEAL_IV_BYTES = 12;
const SEAL_TAG_BYTES = 16;

const aad = (purpose: SealPurpose, rowId: string): Buffer => {
  if (!rowId) throw new Error("a sealed value needs the id of the row it belongs to");
  return Buffer.from(`${purpose}|${rowId}`, "utf8");
};

const checkKey = (key: Buffer): Buffer => {
  if (key.length !== SEAL_KEY_BYTES) throw new Error(`the sealing key must be ${SEAL_KEY_BYTES} bytes`);
  return key;
};

/** `v1.<iv>.<ciphertext>.<tag>`, each base64url. A fresh IV every time. */
export function sealSecret(key: Buffer, purpose: SealPurpose, rowId: string, plaintext: string): string {
  const iv = randomBytes(SEAL_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", checkKey(key), iv);
  cipher.setAAD(aad(purpose, rowId));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [SEAL_VERSION, iv, ct, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** The plaintext, or an error that says only that it did not open (never the value, never why). */
export function openSecret(key: Buffer, purpose: SealPurpose, rowId: string, sealed: string): string {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  try {
    if (parts.length !== 4 || parts[0] !== SEAL_VERSION) throw new Error("shape");
    const [iv, ct, tag] = parts.slice(1).map((p) => Buffer.from(p, "base64url"));
    if (iv.length !== SEAL_IV_BYTES || tag.length !== SEAL_TAG_BYTES) throw new Error("shape");
    const decipher = createDecipheriv("aes-256-gcm", checkKey(key), iv);
    decipher.setAAD(aad(purpose, rowId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(`a sealed ${purpose} did not open (wrong key, wrong row, or damaged)`);
  }
}
