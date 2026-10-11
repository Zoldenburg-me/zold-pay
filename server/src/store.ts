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

/** Why a store's connection stopped opening payment requests. */
export type ShopifyDisabledReason = "app_uninstalled" | "link_revoked";

/**
 * One Shopify store connected through a Zold merchant link (one row per shop).
 * The access token and the pay-link secret are sealed (secrets.ts), bound to
 * this row's id; neither is ever logged or sent to a browser.
 */
export interface ShopifyConnection {
  id: string;
  /** myshopify.com domain, lower-case. */
  shop: string;
  /** The Zold merchant link this store opens payment requests under. */
  linkId: string;
  /** Absent after the store uninstalled the app: Shopify revoked it, so it is not kept. */
  accessTokenEnc?: string;
  linkSecretEnc: string;
  scope: string;
  installedAt: string;
  updatedAt: string;
  /** Admin API ids of our webhook subscriptions, so a revoked link can remove them. */
  webhookSubscriptionIds: string[];
  disabledAt?: string;
  disabledReason?: ShopifyDisabledReason;
}

/**
 * A Shopify order with a Zold payment request, keyed by (shop, orderGid): order
 * ids are per-store sequences, so the gid alone names a different order at
 * every store.
 */
export interface ShopifyOrder {
  shop: string;
  orderGid: string;
  linkId: string;
  paymentRequestId: string;
  handle: string;
  /** The request's payment code (display form). A credential: never logged. */
  code: string;
  /** Zold's public projection of the request, `/api/pay/<handle>/<code>`. */
  publicPath: string;
  pageUrl: string;
  /** The amount the request was opened for; "Mark as paid" is refused if Zold's view differs. */
  amountEur: number;
  /** Shopify's order name, control characters removed. */
  orderName?: string;
  /** SHA-256 of the order's checkout token, the thank-you page's proof. Kept 24 hours past `closedAt`. */
  checkoutTokenHash?: string;
  /** When the order was marked paid or closed here (request closed, store uninstalled). */
  closedAt?: string;
  /** Zold's effective state of the request when last read (OPEN, PAID, CANCELLED, EXPIRED...). */
  state: string;
  /** When Shopify accepted "Mark as paid" for the order. */
  markedPaidAt?: string;
  markPaidAttempts: number;
  lastError?: string;
  /** After a refused "Mark as paid": not tried again before this. */
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Zold states after which nothing more can happen to an unpaid order's request. */
export const SHOPIFY_CLOSED_STATES: ReadonlySet<string> = new Set(["CANCELLED", "EXPIRED"]);

/** How long a settled or closed Shopify order is kept, counted from its last change. */
export const SHOPIFY_ORDER_RETENTION_MS = 90 * 24 * 60 * 60_000;

/**
 * How long the buyer's proof outlives the order's close: the thank-you page
 * must still show "payment received" after the order is marked paid.
 */
export const SHOPIFY_BUYER_PROOF_TTL_MS = 24 * 60 * 60_000;

/** Does this order still carry a buyer proof that may be used at `now`? */
export function shopifyBuyerProofLive(o: ShopifyOrder, now: number): boolean {
  if (!o.checkoutTokenHash) return false;
  return !o.closedAt || !(now - Date.parse(o.closedAt) > SHOPIFY_BUYER_PROOF_TTL_MS);
}

/**
 * Nothing more will happen to this order here: marked paid, its request closed
 * at Zold, or its store uninstalled the app (no token to mark it with).
 */
function shopifyOrderClosed(o: ShopifyOrder, connections: readonly ShopifyConnection[]): boolean {
  if (o.markedPaidAt || SHOPIFY_CLOSED_STATES.has(o.state)) return true;
  return connections.find((c) => c.shop === o.shop)?.disabledReason === "app_uninstalled";
}

interface Db {
  merchants: Merchant[];
  paymentIntents: PaymentIntent[];
  shopifyConnections: ShopifyConnection[];
  shopifyOrders: ShopifyOrder[];
}

const DEFAULT_DB_PATH = process.env.CHECKOUT_DB_PATH ?? path.join(ROOT, "data/checkout.json");

let dbPath = DEFAULT_DB_PATH;
const emptyDb = (): Db => ({ merchants: [], paymentIntents: [], shopifyConnections: [], shopifyOrders: [] });
let db: Db = emptyDb();

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

  // Files written before the Shopify adapter have neither list.
  const shopifyConnections: ShopifyConnection[] = Array.isArray(raw.shopifyConnections) ? raw.shopifyConnections : [];
  const shopifyOrders: ShopifyOrder[] = Array.isArray(raw.shopifyOrders) ? raw.shopifyOrders : [];
  if (!Array.isArray(raw.shopifyConnections) || !Array.isArray(raw.shopifyOrders)) changed = true;

  return { db: { merchants, paymentIntents, shopifyConnections, shopifyOrders }, changed };
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
  db = emptyDb();
  if (!existsSync(dbPath)) return;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(dbPath, "utf8"));
  } catch (e: any) {
    throw new Error(`could not read ${dbPath}: ${e?.message ?? e}`);
  }
  const migrated = migrate(raw);
  const purged = purgeStalePayerNames(migrated.db.paymentIntents);
  const loaded: Db = { ...migrated.db, paymentIntents: purged.intents };
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
    // A Shopify order is kept while Zold may still be paid for it and the store
    // can be told; once closed, for 90 days after its last change.
    // A buyer proof is dropped 24 hours after its order closed (without
    // counting as a change to the order).
    let proofsDropped = 0;
    const orders = db.shopifyOrders
      .filter((o) => !(shopifyOrderClosed(o, db.shopifyConnections) && now - Date.parse(o.updatedAt) > SHOPIFY_ORDER_RETENTION_MS))
      .map((o) => {
        if (!o.checkoutTokenHash || shopifyBuyerProofLive(o, now)) return o;
        proofsDropped++;
        return withoutKeys(o, "checkoutTokenHash");
      });
    const ordersChanged = orders.length !== db.shopifyOrders.length || proofsDropped > 0;
    if (kept.length !== db.paymentIntents.length || purged.changed || ordersChanged) {
      commit({ ...db, paymentIntents: purged.intents, shopifyOrders: orders });
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

  // --- Shopify ---------------------------------------------------------------

  findShopifyConnectionByShop: (shop: string) => db.shopifyConnections.find((c) => c.shop === shop),
  findShopifyConnectionsByLink: (linkId: string) => db.shopifyConnections.filter((c) => c.linkId === linkId),
  /** Add the shop's connection, or replace the one row the shop already has. */
  saveShopifyConnection(c: ShopifyConnection) {
    const others = db.shopifyConnections.filter((x) => x.shop !== c.shop);
    commit({ ...db, shopifyConnections: [...others, c] });
    return c;
  },
  updateShopifyConnection(id: string, patch: Partial<ShopifyConnection>) {
    const old = db.shopifyConnections.find((x) => x.id === id);
    if (!old) throw new Error("shopify connection not found");
    const updated = patched(old, patch);
    commit({ ...db, shopifyConnections: db.shopifyConnections.map((x) => (x.id === id ? updated : x)) });
    return updated;
  },

  /** Always by shop and order: an order gid alone is not unique across stores. */
  findShopifyOrder: (shop: string, orderGid: string) =>
    db.shopifyOrders.find((o) => o.shop === shop && o.orderGid === orderGid),
  findShopifyOrderByRequest: (linkId: string, paymentRequestId: string) =>
    db.shopifyOrders.find((o) => o.linkId === linkId && o.paymentRequestId === paymentRequestId),
  /** The existing row for (shop, orderGid) if there is one; otherwise adds this one. */
  addShopifyOrder(o: ShopifyOrder) {
    const existing = store.findShopifyOrder(o.shop, o.orderGid);
    if (existing) return existing;
    commit({ ...db, shopifyOrders: [...db.shopifyOrders, o] });
    return o;
  },
  /** `at` is the caller's clock, used as `closedAt` when this change closes the order. */
  updateShopifyOrder(shop: string, orderGid: string, patch: Partial<ShopifyOrder>, at: number = Date.now()) {
    const old = store.findShopifyOrder(shop, orderGid);
    if (!old) throw new Error("shopify order not found");
    let updated = patched(old, patch);
    // The moment it closes starts the buyer proof's last 24 hours (see sweep).
    if (!updated.closedAt && (updated.markedPaidAt || SHOPIFY_CLOSED_STATES.has(updated.state))) {
      updated = { ...updated, closedAt: new Date(at).toISOString() };
    }
    commit({ ...db, shopifyOrders: db.shopifyOrders.map((x) => (x === old ? updated : x)) });
    return updated;
  },
  /**
   * A store uninstalled the app: its orders are closed here. Their buyers'
   * proofs have 24 hours left and their 90 days start now.
   */
  closeShopifyOrdersOf(shop: string, now: number = Date.now()) {
    const at = new Date(now).toISOString();
    const next = db.shopifyOrders.map((o) => (o.shop === shop ? { ...o, closedAt: o.closedAt ?? at, updatedAt: at } : o));
    commit({ ...db, shopifyOrders: next });
  },
  /** Orders whose request can still be paid, or was paid and the store has not been told. */
  shopifyOrdersAwaitingSettlement: () => db.shopifyOrders.filter((o) => !shopifyOrderClosed(o, db.shopifyConnections)),
};

/** A new record with `patch` applied; `undefined` deletes the key. */
function patched<T extends { updatedAt: string }>(old: T, patch: Partial<T>): T {
  const cleared = Object.entries(patch).filter(([, v]) => v === undefined).map(([k]) => k);
  return { ...withoutKeys({ ...old, ...patch }, ...cleared), updatedAt: new Date().toISOString() };
}
