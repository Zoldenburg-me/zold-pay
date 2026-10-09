/**
 * Device key (browser side).
 *
 * The key that authorizes payments is generated in this browser and never
 * sent anywhere. The server learns only the address. The key signs the
 * payment's exact terms (amount, payee commitment, deadline), so nothing can
 * be swapped after the user approves.
 *
 * assertDeviceAuthorization() in orchestrator.ts verifies the signature in
 * the API process, not in bytecode. The server cannot forge a signature but
 * it is the one checking, so this protects against a stolen session and a
 * swapped payee, not against a compromised server.
 *
 * The key is encrypted at rest with a secret only the passkey can produce:
 * WebAuthn's PRF extension derives 32 bytes from the authenticator for a
 * fixed salt, HKDF turns that into an AES-GCM key, and only the ciphertext
 * touches localStorage. Without the authenticator the stored blob is useless,
 * and every payment needs a fresh ceremony to unwrap.
 *
 * The stored blob records its `protection`, which the app reads back.
 *
 * Crypto is vendored @noble/secp256k1 + @noble/hashes (audited, no build
 * step; see /vendor). Signing is RFC6979 deterministic with low-s enforced,
 * as ecrecover's EIP-2 check requires.
 */
import { keccak_256 } from "./vendor/hashes/sha3.js";
import * as secp from "./vendor/secp256k1.js";

const KEY_SLOT = "zold-device-key";
/** The slot from before the Zoll -> Zold rename. The device key is bound as
 *  the account's authorizer and only the CURRENT authorizer can rotate it, so
 *  dropping this slot would leave an account permanently unable to spend.
 *  Read the old name once and carry it forward. */
const LEGACY_KEY_SLOT = "zoll-device-key";
/**
 * Fixed PRF input: the same salt must yield the same wrapping key every time.
 *
 * Don't rename this string. It is an input to the key derivation, so a change
 * derives a different AES key and every device key already wrapped on a
 * user's authenticator becomes undecryptable. That is why it keeps the old
 * spelling after the Zoll -> Zold rename. A new spelling needs a versioned
 * migration that unwraps with the old salt first.
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
 * matches the server's — so a server that swapped the IBAN or phone in the
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
  // A record that cannot be read is still a record: it may be a wrapped key the
  // account is bound to. Report it as damaged rather than absent, so nothing
  // mints a new key over it.
  try { return JSON.parse(raw); } catch { return { damaged: true, protection: null }; }
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
  return { present: !!blob, protection: blob?.protection ?? null, ...(blob?.damaged ? { damaged: true } : {}) };
}

/**
 * Create the device key, wrapping it with the passkey when the authenticator
 * supports PRF. Returns the address plus how the key ended up protected, so
 * the caller can tell the user the truth.
 *
 * `requirePrf` refuses instead of storing a key the passkey cannot protect:
 * nothing is written, and the error says why.
 *
 * Never writes over a stored key: it may be the account's bound authorizer,
 * and only the current authorizer can rotate it. The one exception is a
 * damaged record when the caller knows the account has no key bound yet
 * (`replaceDamaged`): then it cannot be anyone's usable key.
 */
export async function createKey(credentialId, { requirePrf = false, replaceDamaged = false } = {}) {
  const existing = readSlot();
  if (existing && !(existing.damaged && replaceDamaged)) {
    throw new Error("a spending key is already stored in this browser; it is not replaced");
  }
  const privHex = freshPrivateKey();
  const secret = await prfSecret(credentialId);
  if (secret) {
    writeSlot({ ...(await wrapKey(privHex, secret)), address: addressOf(privHex) });
    return { address: addressOf(privHex), protection: "prf" };
  }
  if (requirePrf) {
    throw new Error("this device's authenticator does not support the PRF extension, so the spending key could not be protected");
  }
  writeSlot({ v: 1, protection: "none", key: privHex, address: addressOf(privHex) });
  return { address: addressOf(privHex), protection: "none" };
}

/** The device address, without needing to unwrap (cached alongside the blob).
 *  With no key yet it makes one, with the same options as createKey. */
export async function deviceAddress(credentialId, options = {}) {
  const blob = readSlot();
  if (!blob) return (await createKey(credentialId, options)).address;
  if (blob.damaged) throw new Error("the spending key stored in this browser is damaged");
  if (blob.address) return blob.address;
  return addressOf(blob.key); // pre-PRF plaintext blob with no cached address
}

/**
 * Unlock the private key for one signature. With PRF this triggers the
 * authenticator — the passkey is the gate, not a formality.
 */
async function unlock(credentialId) {
  const blob = readSlot();
  if (!blob) throw new Error("no device key in this browser");
  if (blob.damaged) throw new Error("the spending key stored in this browser is damaged");
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

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * A user-verified passkey assertion over a challenge the server issued, in the
 * shape the API takes for `executionAssertion` and `moneriumRedeemAssertion`.
 * Undefined when there is nothing to approve (no challenge on this transfer).
 */
export async function passkeyAssertion(req) {
  if (!req?.challenge || !req?.credentialId) return undefined;
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(req.challenge),
      allowCredentials: [{ type: "public-key", id: b64urlToBytes(req.credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  return {
    credentialId: req.credentialId,
    authenticatorData: b64url(cred.response.authenticatorData),
    clientDataJSON: b64url(cred.response.clientDataJSON),
    signature: b64url(cred.response.signature),
  };
}

// Hand the API to the classic script, which loaded before this module.
if (window.__deviceLibReady) {
  window.__deviceLibReady({ createKey, deviceAddress, signTypedData, keyStatus, destinationCommitment, passkeyAssertion });
}
