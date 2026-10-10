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
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { hashSecret } from "./secrets.js";

/** How long an authorization code stays exchangeable after the transfer is attached. */
export const CODE_TTL_MS = 10 * 60_000;

/** How long a checkout can be started and paid. After this the page refuses to begin a payment. */
export const INTENT_TTL_MS = 15 * 60_000;

/**
 * Extra time to attach a payment that was already made. The passkey ceremonies and
 * a slow payout can run past INTENT_TTL_MS; refusing then would leave a payer
 * debited with nothing to show the merchant.
 */
export const ATTACH_GRACE_MS = 10 * 60_000;

/**
 * A reference unique to one checkout. It rides on the SEPA payment, so a transfer
 * can only ever match the checkout it was made for: an older payment to the same
 * account for the same amount cannot be passed off as this one. Upper-case hex
 * keeps it inside the SEPA remittance character set.
 */
export const newPayRef = () => "ZP" + randomBytes(6).toString("hex").toUpperCase();

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

/**
 * PAYING: one payer has claimed the checkout and may be moving money for it right
 * now. Claimed before any core transfer exists, so a second tab or device cannot
 * start a second payment (see claimIntent).
 */
export type IntentStatus = "PENDING" | "PAYING" | "AUTHORIZED" | "PAID" | "FAILED" | "EXPIRED";

/**
 * Why a settled payment for a checkout could not be attached to it: the checkout
 * was already paid, someone else held the claim, or it had closed before the
 * payment arrived.
 */
export type UnattachedReason = "duplicate" | "claimed_by_another" | "late";

export interface UnattachedPayment {
  transferId: string;
  reason: UnattachedReason;
  /** The transfer's state when it was recorded. PAYOUT_SUBMITTED can still fail later. */
  state: string;
  recordedAt: string;
}

export interface PaymentIntent {
  id: string;
  merchantId: string;
  amountEur: number;
  /** The merchant's own reference for the order (may be empty). */
  reference: string;
  /** Unique to this checkout; see newPayRef. Always part of the payment's reference. */
  payRef: string;
  /**
   * How the checkout was started. The front channel needs only the public client
   * id, so it is capped on its own and cannot crowd out the authenticated one.
   * Absent on older records, which were all back channel.
   */
  channel?: "front" | "back";
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
  /** The payer holding the claim while the checkout is PAYING. */
  claimUserId?: string;
  /** SHA-256 of the claim token held by the paying tab; the token itself is never stored. */
  claimTokenHash?: string;
  claimedAt?: string;
  /**
   * Settled payments made for this checkout that could not be attached to it.
   * The money has left the payer and SEPA cannot be recalled by us, so they are
   * kept for the merchant to see and refund, never dropped.
   */
  unattachedPayments?: UnattachedPayment[];
  /** More arrived than are kept (the list is capped); an operator has the log line. */
  unattachedPaymentsTruncated?: boolean;
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
    // Saved before checkouts carried their own reference. Assigned once and then
    // persisted, so it is the same after every restart.
    if (typeof out.payRef !== "string" || !out.payRef) {
      changed = true;
      out = { ...out, payRef: newPayRef() };
    }
    return out;
  });

  return { db: { merchants, paymentIntents }, changed };
}

/** Drop payer names whose code is gone or expired. Pure: returns new records and whether any changed. */
function purgeStalePayerNames(intents: readonly PaymentIntent[], now = Date.now()): { intents: PaymentIntent[]; changed: boolean } {
  let changed = false;
  const next = intents.map((i) => {
    if (i.payerName === undefined) return i;
    const live = i.codeHash && i.codeExpiresAt && Date.parse(i.codeExpiresAt) >= now;
    if (live) return i;
    changed = true;
    return withoutKeys(i, "payerName");
  });
  return { intents: next, changed };
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
  const purged = purgeStalePayerNames(migrated.db.paymentIntents);
  const loaded: Db = { merchants: migrated.db.merchants, paymentIntents: purged.intents };
  if (migrated.changed || purged.changed) commit(loaded);
  else db = loaded;
}

/**
 * Write `next` to disk: temp file, flushed to the device, then renamed over the
 * old one, so a crash leaves either the old file or the new one, never half of one.
 */
function persist(next: Db): void {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const tmp = dbPath + ".tmp";
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(next, null, 2));
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, dbPath);
}

/**
 * The only way state changes: write the new state first, and only if that
 * worked make it the one the service believes. A failed write therefore leaves
 * memory exactly as it was, instead of ahead of a disk that never saw the change
 * (a code that looks burned but comes back after a restart, a payment recorded
 * that was never saved).
 */
function commit(next: Db): void {
  persist(next);
  db = next;
}

/** Abandoned checkouts are dropped after this; settled ones are kept for the merchant to poll. */
const DEAD_INTENT_MAX_AGE_MS = 60 * 60_000;
const DEAD_STATUSES: ReadonlySet<IntentStatus> = new Set(["PENDING", "EXPIRED", "FAILED"]);
/**
 * A claimed checkout may have a payment in flight that has not been attached yet.
 * Dropping it after an hour would lose the attach target and any duplicate record,
 * so it is kept for a day.
 */
const CLAIMED_INTENT_MAX_AGE_MS = 24 * 60 * 60_000;

/** How long a PAID or FAILED checkout stays readable by its merchant. */
export const SETTLED_INTENT_MAX_AGE_MS = 90 * 24 * 60 * 60_000;

export const store = {
  allMerchants: () => [...db.merchants],
  findMerchant: (id: string) => db.merchants.find((m) => m.id === id),
  findMerchantByClientId: (clientId: string) => db.merchants.find((m) => m.clientId === clientId),
  addMerchant(m: Merchant) {
    commit({ ...db, merchants: [...db.merchants, m] });
    return m;
  },

  findPaymentIntent: (id: string) => db.paymentIntents.find((i) => i.id === id),
  /** The intent a core transfer has already been attached to, if any. */
  findPaymentIntentByTransfer(transferId: string) {
    if (!transferId) return undefined;
    return db.paymentIntents.find((i) => i.transferId === transferId);
  },
  /**
   * Checkouts a merchant can still be paid through (open or being paid), on one channel. Ones past
   * their time limit are not counted even though they stay PENDING until swept:
   * otherwise anyone holding the public client id could fill the cap with checkouts
   * that can no longer be paid and lock the merchant out for an hour.
   */
  pendingCount: (merchantId: string, channel: "front" | "back" = "back", now: number = Date.now()) =>
    db.paymentIntents.filter(
      (i) =>
        i.merchantId === merchantId &&
        (i.status === "PENDING" || i.status === "PAYING") &&
        (i.channel ?? "back") === channel &&
        now - Date.parse(i.createdAt) <= INTENT_TTL_MS,
    ).length,
  /**
   * Housekeeping, safe to call often: drops long-dead checkouts (so unauthenticated
   * intent creation cannot grow the file without bound) and the payer names of
   * codes that expired without being exchanged.
   */
  sweep(now: number = Date.now()) {
    const kept = db.paymentIntents.filter((i) => {
      // A recorded payment is money the merchant must refund: never swept.
      if (i.unattachedPayments?.length) return true;
      // Written as "older than" so a date that cannot be read (NaN) keeps the record.
      const olderThan = (ms: number) => now - Date.parse(i.createdAt) > ms;
      // A checkout that had a payment attached is the merchant's record of it,
      // including one whose payout later FAILED: kept while it can still change,
      // and for SETTLED_INTENT_MAX_AGE_MS once it cannot.
      if (i.transferId) return i.status === "AUTHORIZED" || !olderThan(SETTLED_INTENT_MAX_AGE_MS);
      if (i.status === "PAYING") return !olderThan(CLAIMED_INTENT_MAX_AGE_MS);
      return !(DEAD_STATUSES.has(i.status) && olderThan(DEAD_INTENT_MAX_AGE_MS));
    });
    const purged = purgeStalePayerNames(kept, now);
    if (kept.length !== db.paymentIntents.length || purged.changed) {
      commit({ ...db, paymentIntents: purged.intents });
    }
  },
  /**
   * `sweep` for a timer: a failed write is reported, not thrown, so one bad
   * minute on the disk cannot take the whole service down mid-payment.
   */
  sweepSafely(log: (...args: unknown[]) => void = console.error): boolean {
    try {
      store.sweep();
      return true;
    } catch (e) {
      log("checkout store: sweep failed", e instanceof Error ? e.message : e);
      return false;
    }
  },
  /** Checkouts with a payment attached whose payout is not final yet (see settle.ts). */
  intentsAwaitingSettlement: () => db.paymentIntents.filter((i) => i.status === "AUTHORIZED" && !!i.transferId),
  findPaymentIntentByCode(code: string) {
    // An empty/undefined code must never match an intent whose code was burned.
    if (!code) return undefined;
    const hash = hashSecret(code);
    return db.paymentIntents.find((i) => i.codeHash === hash);
  },
  addPaymentIntent(i: PaymentIntent) {
    commit({ ...db, paymentIntents: [...db.paymentIntents, i] });
    return i;
  },
  /**
   * Returns the updated record. Records are never changed in place, so a copy
   * held earlier does not silently change underneath its holder: re-read by id.
   */
  updatePaymentIntent(id: string, patch: Partial<PaymentIntent>) {
    const old = db.paymentIntents.find((x) => x.id === id);
    if (!old) throw new Error("intent not found");
    // `undefined` must actually delete the key, or a burned code could match again.
    const cleared = Object.entries(patch).filter(([, v]) => v === undefined).map(([k]) => k);
    const updated: PaymentIntent = {
      ...withoutKeys({ ...old, ...patch }, ...cleared),
      updatedAt: new Date().toISOString(),
    };
    commit({ ...db, paymentIntents: db.paymentIntents.map((x) => (x.id === id ? updated : x)) });
    return updated;
  },
};
