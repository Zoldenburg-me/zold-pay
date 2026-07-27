/**
 * Merchant + payment-intent store.
 *
 * This service is the authorization server for "Pay with Zold", so it owns the
 * merchant registry and the intents it issues codes against. It still owns no
 * users, keys or balances — those stay in the core Zold API.
 *
 * Deliberately a JSON file, matching the core app's store: the data is small,
 * a demo has to be inspectable, and a database is not the interesting part of
 * this problem. Writes are atomic (temp file + rename) so a crash mid-write
 * cannot truncate the file.
 *
 * NOT production storage. `clientSecret` sits here in plaintext; a real
 * deployment keeps merchant credentials hashed, in a real database.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

export interface Merchant {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
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
  /** Payer's legal name, captured at attach so the merchant can evidence a
   *  first-party top-up. PII: disclosed to one merchant, for one payment. */
  payerName?: string;
  /** One-time authorization code, burned at token exchange. */
  code?: string;
  /** Bearer the merchant polls status with, issued at token exchange. */
  statusToken?: string;
  createdAt: string;
  updatedAt: string;
}

interface Db {
  merchants: Merchant[];
  paymentIntents: PaymentIntent[];
}

const DB_PATH = process.env.CHECKOUT_DB_PATH ?? path.join(ROOT, "data/checkout.json");

let db: Db = { merchants: [], paymentIntents: [] };

export function initStore(): void {
  if (!existsSync(DB_PATH)) return;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(DB_PATH, "utf8"));
  } catch (e: any) {
    throw new Error(`could not read ${DB_PATH}: ${e?.message ?? e}`);
  }
  let migrated = false;
  const merchants: Merchant[] = (raw.merchants ?? []).map((m: any) => {
    // Pre-allowlist shape: a single ibanTarget. Carry it forward as the one
    // allowed settlement account rather than dropping it, which would leave
    // every existing merchant unable to be paid.
    if (!Array.isArray(m.settlementIbans)) {
      migrated = true;
      const { ibanTarget, ...rest } = m;
      return { ...rest, settlementIbans: ibanTarget ? [ibanTarget] : [] };
    }
    return m;
  });
  const paymentIntents: PaymentIntent[] = (raw.paymentIntents ?? []).map((i: any) => {
    if (i.destinationIban) return i;
    migrated = true;
    // Intents from before per-transaction destinations were pinned to the
    // merchant's only account.
    const m = merchants.find((x) => x.id === i.merchantId);
    return { ...i, destinationIban: m?.settlementIbans[0] ?? "" };
  });
  db = { merchants, paymentIntents };
  if (migrated) persist();
}

function persist(): void {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH);
}

export const store = {
  findMerchant: (id: string) => db.merchants.find((m) => m.id === id),
  findMerchantByClientId: (clientId: string) => db.merchants.find((m) => m.clientId === clientId),
  addMerchant(m: Merchant) {
    db.merchants.push(m);
    persist();
    return m;
  },

  findPaymentIntent: (id: string) => db.paymentIntents.find((i) => i.id === id),
  findPaymentIntentByCode(code: string) {
    // An empty/undefined code must never match an intent whose code was burned.
    if (!code) return undefined;
    return db.paymentIntents.find((i) => i.code === code);
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
    // `code: undefined` must actually delete the key, or a later exchange with
    // an empty code could match this intent again.
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (i as any)[k];
    }
    persist();
    return i;
  },
};
