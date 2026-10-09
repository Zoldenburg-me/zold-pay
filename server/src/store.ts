/**
 * Merchant + payment-intent store.
 *
 * This service is the authorization server for "Pay with Zold", so it owns the
 * merchant registry and the intents it issues codes against. It still owns no
 * users, keys or balances — those stay in the core Zold API.
 *
 * Deliberately a JSON file, matching the core app's store: the data is small
 * and a demo has to be inspectable. Writes are atomic (temp file + rename) so a
 * crash mid-write cannot truncate the file, and the file is owner-readable only.
 *
 * Credentials are stored as hashes (see secrets.ts); the plaintext is shown
 * once, when issued. Older files that still hold plaintext are migrated on load.
 * The payer's legal name is kept only until the merchant's code exchange (or the
 * code's expiry), then dropped.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { hashSecret } from "./secrets.js";

/** How long an authorization code stays exchangeable after the transfer is attached. */
export const CODE_TTL_MS = 10 * 60_000;

export interface Merchant {
  id: string;
  name: string;
  clientId: string;
  /** SHA-256 of the client secret. The secret itself is never stored. */
  clientSecretHash: string;
  /**
   * The SEPA accounts this merchant may be paid into. An allowlist, not a
   * single value: a merchant with per-market or per-entity settlement accounts
   * names one per transaction on the back channel. The first is the default.
   *
   * It stays an allowlist because `client_id` is public and the front-channel
   * authorize needs no secret — a merchant free to name any IBAN in a URL turns
   * a leaked client id into a payment-redirect vector.
   */
  settlementIbans: string[];
  /** Exact redirect URIs, or ["*"] for the local demo merchant only. */
  redirectUris: string[];
  webhookUrl?: string;
  createdAt: string;
}

export type IntentStatus = "PENDING" | "AUTHORIZED" | "PAID" | "FAILED" | "EXPIRED";

export interface PaymentIntent {
  id: string;
  merchantId: string;
  amountEur: number;
  reference: string;
  /**
   * The settlement account this specific payment must land in, resolved from
   * the merchant's allowlist when the intent was created. Pinned per intent so
   * that attach validates against what the merchant asked for at the time,
   * not against whatever the allowlist happens to contain when the user
   * finishes paying.
   */
  destinationIban: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  status: IntentStatus;
  userId?: string;
  transferId?: string;
  /** Per-merchant pseudonymous payer id, captured at attach. */
  payerSub?: string;
  /**
   * Payer's legal name, so the merchant can evidence a first-party top-up.
   * PII: held only until the merchant exchanges the code (or the code expires),
   * returned in that one response, then deleted.
   */
  payerName?: string;
  /** SHA-256 of the one-time authorization code; absent once burned. */
  codeHash?: string;
  codeExpiresAt?: string;
  /** SHA-256 of the bearer the merchant polls status with. */
  statusTokenHash?: string;
  createdAt: string;
  updatedAt: string;
}

interface Db {
  merchants: Merchant[];
  paymentIntents: PaymentIntent[];
}

const DEFAULT_DB_PATH = process.env.CHECKOUT_DB_PATH ?? path.join(ROOT, "data/checkout.json");

let dbPath = DEFAULT_DB_PATH;
let db: Db = { merchants: [], paymentIntents: [] };

const withoutKeys = <T extends object>(o: T, ...keys: string[]): T => {
  const copy = { ...o } as Record<string, unknown>;
  for (const k of keys) delete copy[k];
  return copy as T;
};

/** Upgrade an older on-disk shape. Pure and idempotent; reports whether it changed anything. */
function migrate(raw: any): { db: Db; changed: boolean } {
  let changed = false;

  const merchants: Merchant[] = (raw.merchants ?? []).map((m: any) => {
    let out = m;
    // Pre-allowlist shape: a single ibanTarget, carried forward as the one allowed account.
    if (!Array.isArray(out.settlementIbans)) {
      changed = true;
      out = { ...withoutKeys(out, "ibanTarget"), settlementIbans: out.ibanTarget ? [out.ibanTarget] : [] };
    }
    if (typeof out.clientSecret === "string") {
      changed = true;
      out = { ...withoutKeys(out, "clientSecret"), clientSecretHash: hashSecret(out.clientSecret) };
    }
    return out;
  });

  const paymentIntents: PaymentIntent[] = (raw.paymentIntents ?? []).map((i: any) => {
    let out = i;
    if (!out.destinationIban) {
      changed = true;
      out = { ...out, destinationIban: merchants.find((x) => x.id === out.merchantId)?.settlementIbans[0] ?? "" };
    }
    if (typeof out.code === "string") {
      changed = true;
      const expires = out.codeExpiresAt ?? new Date(Date.parse(out.updatedAt ?? out.createdAt) + CODE_TTL_MS).toISOString();
      out = { ...withoutKeys(out, "code"), codeHash: hashSecret(out.code), codeExpiresAt: expires };
    }
    if (typeof out.statusToken === "string") {
      changed = true;
      out = { ...withoutKeys(out, "statusToken"), statusTokenHash: hashSecret(out.statusToken) };
    }
    return out;
  });

  return { db: { merchants, paymentIntents }, changed };
}

/** Drop payer names whose code is gone or expired. Returns whether anything changed. */
function purgeStalePayerNames(now = Date.now()): boolean {
  let changed = false;
  for (const i of db.paymentIntents) {
    if (i.payerName === undefined) continue;
    const live = i.codeHash && i.codeExpiresAt && Date.parse(i.codeExpiresAt) >= now;
    if (!live) {
      delete i.payerName;
      changed = true;
    }
  }
  return changed;
}

export function initStore(file: string = DEFAULT_DB_PATH): void {
  dbPath = file;
  db = { merchants: [], paymentIntents: [] };
  if (!existsSync(dbPath)) return;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(dbPath, "utf8"));
  } catch (e: any) {
    throw new Error(`could not read ${dbPath}: ${e?.message ?? e}`);
  }
  const migrated = migrate(raw);
  db = migrated.db;
  const purged = purgeStalePayerNames();
  if (migrated.changed || purged) persist();
}

function persist(): void {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const tmp = dbPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  renameSync(tmp, dbPath);
}

/** Abandoned checkouts are dropped after this; settled ones are kept for the merchant to poll. */
const DEAD_INTENT_MAX_AGE_MS = 60 * 60_000;
const DEAD_STATUSES: ReadonlySet<IntentStatus> = new Set(["PENDING", "EXPIRED", "FAILED"]);

export const store = {
  allMerchants: () => [...db.merchants],
  findMerchant: (id: string) => db.merchants.find((m) => m.id === id),
  findMerchantByClientId: (clientId: string) => db.merchants.find((m) => m.clientId === clientId),
  addMerchant(m: Merchant) {
    db.merchants.push(m);
    persist();
    return m;
  },

  findPaymentIntent: (id: string) => db.paymentIntents.find((i) => i.id === id),
  /** The intent a core transfer has already been attached to, if any. */
  findPaymentIntentByTransfer(transferId: string) {
    if (!transferId) return undefined;
    return db.paymentIntents.find((i) => i.transferId === transferId);
  },
  pendingCount: (merchantId: string) =>
    db.paymentIntents.filter((i) => i.merchantId === merchantId && i.status === "PENDING").length,
  /**
   * Housekeeping, safe to call often: drops long-dead checkouts (so unauthenticated
   * intent creation cannot grow the file without bound) and the payer names of
   * codes that expired without being exchanged.
   */
  sweep(now: number = Date.now()) {
    const before = db.paymentIntents.length;
    db.paymentIntents = db.paymentIntents.filter(
      (i) => !(DEAD_STATUSES.has(i.status) && now - Date.parse(i.createdAt) > DEAD_INTENT_MAX_AGE_MS),
    );
    const pruned = db.paymentIntents.length !== before;
    const purged = purgeStalePayerNames(now);
    if (pruned || purged) persist();
  },
  findPaymentIntentByCode(code: string) {
    // An empty/undefined code must never match an intent whose code was burned.
    if (!code) return undefined;
    const hash = hashSecret(code);
    return db.paymentIntents.find((i) => i.codeHash === hash);
  },
  addPaymentIntent(i: PaymentIntent) {
    db.paymentIntents.push(i);
    persist();
    return i;
  },
  updatePaymentIntent(id: string, patch: Partial<PaymentIntent>) {
    const i = db.paymentIntents.find((x) => x.id === id);
    if (!i) throw new Error("intent not found");
    Object.assign(i, patch, { updatedAt: new Date().toISOString() });
    // `undefined` must actually delete the key, or a burned code could match again.
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (i as any)[k];
    }
    persist();
    return i;
  },
};
