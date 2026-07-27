/**
 * FP4 device key (browser side).
 *
 * The key that authorizes payments lives here — generated in this browser,
 * never sent anywhere. The server learns only the address. RemitVault refuses
 * any debit not signed by this key over the payment's exact terms, so the
 * server (which holds every other key in the system) cannot move a balance on
 * its own.
 *
 * The key is encrypted at rest with a secret only the passkey can produce:
 * WebAuthn's PRF extension derives 32 bytes from the authenticator for a
 * fixed salt, HKDF turns that into an AES-GCM key, and only the ciphertext
 * touches localStorage. Face ID / fingerprint / screen lock is therefore a
 * real gate — without the authenticator the stored blob is inert, and every
 * payment needs a fresh ceremony to unwrap.
 *
 * Not every authenticator supports PRF. When it isn't available we fall back
 * to storing the key unprotected and label it that way (`protection: "none"`)
 * rather than pretending — an unwrapped key is still enough to stop the
 * server spending, which is the FP4 property; it just doesn't survive someone
 * with access to this browser profile.
 *
 * Crypto is vendored @noble/secp256k1 + @noble/hashes (audited, no build
 * step; see /vendor). Signing is RFC6979 deterministic with low-s enforced,
 * matching the contract's EIP-2 check.
 */
import { keccak_256 } from "./vendor/hashes/sha3.js";
import * as secp from "./vendor/secp256k1.js";

const KEY_SLOT = "zold-device-key";
/** The slot this used to live in, before the Zoll -> Zold rename. The device
 *  key is bound on-chain via authorizerOf and only the CURRENT authorizer can
 *  rotate it, so losing this slot would leave an account permanently unable to
 *  spend. Read the old name once and carry it forward. */
const LEGACY_KEY_SLOT = "zoll-device-key";
/**
 * Fixed PRF input: same salt must yield the same wrapping key every time.
 *
 * DO NOT rename this string. It is not a label — it is an input to the key
 * derivation, so changing it derives a different AES key and every device key
 * already wrapped on a user's authenticator becomes undecryptable. It keeps the
 * old spelling through the Zoll -> Zold rename for exactly that reason; a new
 * spelling would need a versioned migration that unwraps with the old salt
 * first, not a search-and-replace.
 */
const PRF_SALT = new TextEncoder().encode("zoll/device-key/v1");

const bytesToHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h) => {
  const s = h.replace(/^0x/, "");
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.substr(i * 2, 2), 16));
};
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64urlToBytes = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

/* ---------- payout destination commitment ---------- */

/**
 * Recompute the destination commitment the server folded into the terms, from
 * the recipient the user actually entered. Signing only proceeds when this
 * matches the server's — so a server that swapped the IBAN/VPA/phone in the
 * signed terms is caught here, before the passkey ever unlocks the key.
 * Covers the recipient NAME as well as the account identifier: on the cash rail
 * the name is what the anchor is told and what the collector presents with ID,
 * so leaving it out left the field that decides who gets the money unsigned.
 *
 * Must stay byte-identical to destinationCommitment() in chain.ts.
 */
export function destinationCommitment(rail, target) {
  const name = (target.name ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  let preimage;
  if (rail === "sepa") {
    preimage = `sepa|iban=${(target.iban ?? "").replace(/\s/g, "").toUpperCase()}`;
  } else if (rail === "upi") {
    preimage = `upi|vpa=${(target.vpa ?? "").trim().toLowerCase()}`;
  } else {
    preimage = `cash|phone=${(target.phone ?? "").trim()}`;
  }
  return bytesToHex(keccak_256(new TextEncoder().encode(`${preimage}|name=${name}`)));
}

/* ---------- EIP-712 ---------- */

/** One abi.encode word (32 bytes) for the atomic types EIP-712 needs here. */
function word(type, value) {
  if (type === "bytes32") return hexToBytes(value);
  if (type === "address") return concat(new Uint8Array(12), hexToBytes(value));
  if (type === "uint256") return hexToBytes("0x" + BigInt(value).toString(16).padStart(64, "0"));
  if (type === "string") return keccak_256(new TextEncoder().encode(value)); // dynamic: hash
  throw new Error(`unsupported EIP-712 type ${type}`);
}

function structHash(typeName, fields, values) {
  const typeString = `${typeName}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
  return keccak_256(concat(
    keccak_256(new TextEncoder().encode(typeString)),
    ...fields.map((f) => word(f.type, values[f.name])),
  ));
}

/** EIP-712 digest for the flat typed data the API hands back. */
export function eip712Digest(typedData) {
  const domainSep = structHash("EIP712Domain", [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ], typedData.domain);
  const messageHash = structHash(
    typedData.primaryType,
    typedData.types[typedData.primaryType],
    typedData.message,
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domainSep, messageHash));
}

/* ---------- passkey-derived wrapping key ---------- */

/**
 * Ask the authenticator to evaluate the PRF for our salt. Returns 32 bytes
 * that only this passkey can produce, or null when the extension isn't
 * supported (older authenticators, or an embedded browser view that never
 * resolves the ceremony at all).
 */
async function prfSecret(credentialId, { timeoutMs = 15000 } = {}) {
  if (!window.PublicKeyCredential || !credentialId) return null;
  try {
    const assertion = await Promise.race([
      navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ type: "public-key", id: b64urlToBytes(credentialId) }],
          userVerification: "required",
          timeout: timeoutMs,
          extensions: { prf: { eval: { first: PRF_SALT } } },
        },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("passkey timeout")), timeoutMs)),
    ]);
    const first = assertion?.getClientExtensionResults?.().prf?.results?.first;
    return first ? new Uint8Array(first) : null;
  } catch {
    return null;
  }
}

/** HKDF the PRF output into an AES-GCM key. */
async function wrappingKey(secret) {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: PRF_SALT, info: new TextEncoder().encode("aes-gcm") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function wrapKey(privHex, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await wrappingKey(secret),
    new TextEncoder().encode(privHex),
  );
  return { v: 1, protection: "prf", iv: b64(iv), ct: b64(ct) };
}

export async function unwrapKey(blob, secret) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(blob.iv) },
    await wrappingKey(secret),
    unb64(blob.ct),
  );
  return new TextDecoder().decode(plain);
}

/* ---------- key lifecycle ---------- */

const readSlot = () => {
  let raw = localStorage.getItem(KEY_SLOT);
  if (!raw) {
    const legacy = localStorage.getItem(LEGACY_KEY_SLOT);
    if (legacy) {
      localStorage.setItem(KEY_SLOT, legacy);
      localStorage.removeItem(LEGACY_KEY_SLOT);
      raw = legacy;
    }
  }
  if (!raw) return null;
  if (raw.startsWith("0x")) return { v: 1, protection: "none", key: raw }; // pre-PRF format
  try { return JSON.parse(raw); } catch { return null; }
};
const writeSlot = (blob) => localStorage.setItem(KEY_SLOT, JSON.stringify(blob));

function freshPrivateKey() {
  let priv;
  do { priv = crypto.getRandomValues(new Uint8Array(32)); } while (!secp.utils.isValidPrivateKey(priv));
  return bytesToHex(priv);
}

const addressOf = (privHex) =>
  bytesToHex(keccak_256(secp.getPublicKey(hexToBytes(privHex), false).slice(1)).slice(12));

/** Is a device key already present in this browser, and how is it held? */
export function keyStatus() {
  const blob = readSlot();
  return { present: !!blob, protection: blob?.protection ?? null };
}

/**
 * Create the device key, wrapping it with the passkey when the authenticator
 * supports PRF. Returns the address plus how the key ended up protected, so
 * the caller can tell the user the truth.
 */
export async function createKey(credentialId) {
  const privHex = freshPrivateKey();
  const secret = await prfSecret(credentialId);
  if (secret) {
    writeSlot({ ...(await wrapKey(privHex, secret)), address: addressOf(privHex) });
    return { address: addressOf(privHex), protection: "prf" };
  }
  writeSlot({ v: 1, protection: "none", key: privHex, address: addressOf(privHex) });
  return { address: addressOf(privHex), protection: "none" };
}

/** The device address, without needing to unwrap (cached alongside the blob). */
export async function deviceAddress(credentialId) {
  const blob = readSlot();
  if (!blob) return (await createKey(credentialId)).address;
  if (blob.address) return blob.address;
  return addressOf(blob.key); // legacy plaintext blob with no cached address
}

/**
 * Unlock the private key for one signature. With PRF this triggers the
 * authenticator — the passkey is the gate, not a formality.
 */
async function unlock(credentialId) {
  const blob = readSlot();
  if (!blob) throw new Error("no device key in this browser");
  if (blob.protection !== "prf") return blob.key;
  const secret = await prfSecret(credentialId);
  if (!secret) throw new Error("your passkey is needed to approve this payment — the device key stays locked without it");
  try {
    return await unwrapKey(blob, secret);
  } catch {
    throw new Error("could not unlock the device key with this passkey");
  }
}

/** Sign the payment terms; returns r||s||v, the shape ecrecover expects. */
export async function signTypedData(typedData, credentialId) {
  const privHex = await unlock(credentialId);
  const [sig, recovery] = await secp.sign(eip712Digest(typedData), hexToBytes(privHex), {
    der: false,
    recovered: true,
  });
  return bytesToHex(concat(sig, Uint8Array.of(27 + recovery)));
}

// Hand the API to the classic script, which loaded before this module.
if (window.__deviceLibReady) {
  window.__deviceLibReady({ createKey, deviceAddress, signTypedData, keyStatus, destinationCommitment });
}
