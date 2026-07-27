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
  /** Where the merchant is paid: the SEPA account the checkout transfer targets. */
  ibanTarget: string;
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
  redirectUri: string;
  state: string;
  codeChallenge: string;
  status: IntentStatus;
  userId?: string;
  transferId?: string;
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
  if (existsSync(DB_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(DB_PATH, "utf8"));
      db = { merchants: raw.merchants ?? [], paymentIntents: raw.paymentIntents ?? [] };
    } catch (e: any) {
      throw new Error(`could not read ${DB_PATH}: ${e?.message ?? e}`);
    }
  }
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
