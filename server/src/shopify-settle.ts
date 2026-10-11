/**
 * Settle Shopify orders: once Zold says an order's payment request is PAID,
 * press "Mark as paid" on the order and leave the payment's facts on a
 * `zold.payment` metafield. Runs next to settle.ts, in the same style.
 *
 * Every order whose request is open, or paid and not yet marked, is read
 * through Zold's service view (contract 7) with backoff while it stays OPEN.
 * Zold's webhook ({paymentRequestId, linkId}) only makes one due now; it is
 * never believed about a state.
 *
 * Only Zold's PAID, for the amount the request was opened for, marks an order
 * paid (otherwise SHOPIFY_AMOUNT_MISMATCH). CANCELLED and EXPIRED close the row. A
 * refused "Mark as paid" is retried with a persisted backoff and logged as
 * SHOPIFY_MARK_FAILED; a refused metafield is logged as SHOPIFY_METAFIELD_FAILED
 * and does not undo the mark. A 401, 429 or 503 from Zold, or Zold
 * unreachable, ends the tick (SHOPIFY_SETTLE_STALLED, then SHOPIFY_SETTLE_RECOVERED).
 */
import { toCents } from "./checkout.js";
import { describeCoreFailure, isCoreOutage, type ServiceView } from "./core-merchant.js";
import { accessTokenOf, errorText, type ShopifyContext } from "./shopify-context.js";
import { SHOPIFY_CLOSED_STATES, store, type ShopifyOrder } from "./store.js";

export interface ShopifySettlerOptions {
  /** Wait after a read of a request that is still open; doubles each time. Also the first mark-paid retry wait. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Most orders read per tick. */
  batch: number;
}

export type OrderOutcome = "marked" | "mark_failed" | "closed" | "pending" | "mismatch" | "not_read";

const STALL_REPORT_EVERY = 10;
const MARK_FAILED_REPORT_EVERY = 10;

const keyOf = (o: { shop: string; orderGid: string }) => `${o.shop}|${o.orderGid}`;
const label = (o: ShopifyOrder) => `${o.orderName ?? o.orderGid} at ${o.shop}`;

export function createShopifySettler(ctx: ShopifyContext, opts: ShopifySettlerOptions) {
  const log = ctx.log;
  const backoff = new Map<string, { dueAt: number; delayMs: number }>();
  const nudged = new Set<string>();
  const mismatchReported = new Set<string>();
  let running = false;
  let rerun = false;
  let stalledTicks = 0;
  let stalledSince = 0;

  const forget = (key: string) => {
    backoff.delete(key);
    nudged.delete(key);
    mismatchReported.delete(key);
  };

  const later = (key: string, now: number) => {
    if (nudged.delete(key)) {
      backoff.set(key, { dueAt: 0, delayMs: opts.baseDelayMs });
      return;
    }
    const delayMs = Math.min(backoff.get(key)?.delayMs ?? opts.baseDelayMs, opts.maxDelayMs);
    backoff.set(key, { dueAt: now + delayMs, delayMs: Math.min(delayMs * 2, opts.maxDelayMs) });
  };

  const markRetryDelay = (attempts: number) => Math.min(opts.baseDelayMs * 2 ** Math.max(0, attempts - 1), opts.maxDelayMs);

  /** When a row is next due: a refused mark waits on its persisted time, everything else on the read backoff. */
  const dueAt = (o: ShopifyOrder) => {
    const read = backoff.get(keyOf(o))?.dueAt ?? 0;
    const mark = o.nextAttemptAt ? Date.parse(o.nextAttemptAt) : 0;
    return Math.max(read, Number.isFinite(mark) ? mark : 0);
  };

  /** Press "Mark as paid", then the metafield. Reads the row fresh: the caller waited on the network. */
  async function markPaid(row: ShopifyOrder, view: ServiceView, now: number): Promise<OrderOutcome> {
    const c = store.findShopifyConnectionByShop(row.shop);
    const attempts = row.markPaidAttempts + 1;
    const fail = (why: string): OrderOutcome => {
      store.updateShopifyOrder(row.shop, row.orderGid, {
        markPaidAttempts: attempts,
        lastError: why,
        nextAttemptAt: new Date(now + markRetryDelay(attempts)).toISOString(),
      });
      if (attempts === 1 || attempts % MARK_FAILED_REPORT_EVERY === 0) {
        log(`SHOPIFY_MARK_FAILED order ${label(row)} is paid at Zold but not marked paid (attempt ${attempts}): ${why}`);
      }
      return "mark_failed";
    };
    if (!c || c.disabledReason === "app_uninstalled") return fail("the store is not connected");
    let token: string;
    let alreadyPaid: boolean;
    try {
      token = accessTokenOf(ctx, c);
      ({ alreadyPaid } = await ctx.admin.orderMarkAsPaid(row.shop, token, row.orderGid));
    } catch (err) {
      return fail(errorText(err));
    }
    store.updateShopifyOrder(row.shop, row.orderGid, {
      markedPaidAt: new Date(now).toISOString(),
      markPaidAttempts: attempts,
      lastError: undefined,
      nextAttemptAt: undefined,
    });
    log(alreadyPaid ? `shopify: order ${label(row)} was already marked paid in Shopify` : `shopify: marked order ${label(row)} paid`);
    try {
      await ctx.admin.orderSetPaymentMetafield(row.shop, token, row.orderGid, {
        code: view.code,
        amountEur: view.amountEur,
        payments: view.payments,
        ...(view.paidAt ? { paidAt: view.paidAt } : {}),
      });
    } catch (err) {
      // The order is paid in Shopify; the facts are a convenience. Not retried.
      log(`SHOPIFY_METAFIELD_FAILED order ${label(row)} marked paid, zold.payment not written: ${errorText(err)}`);
    }
    return "marked";
  }

  /** Read one order's request and act on it. Throws only on an outage (the tick stops). */
  async function settleOne(row: ShopifyOrder, now: number): Promise<OrderOutcome> {
    const key = keyOf(row);
    nudged.delete(key);
    let view: ServiceView;
    try {
      view = await ctx.core.readPaymentRequest(row.linkId, row.paymentRequestId);
    } catch (err) {
      if (isCoreOutage(err)) throw err;
      log(`shopify settle: order ${label(row)} not read: ${describeCoreFailure(err)}`);
      later(key, now);
      return "not_read";
    }
    if (view.id !== row.paymentRequestId || view.order.gid !== row.orderGid || view.shop !== row.shop) {
      if (!mismatchReported.has(key)) log(`SHOPIFY_SETTLE_MISMATCH order ${label(row)}: Zold answered with another request or order`);
      mismatchReported.add(key);
      later(key, now);
      return "mismatch";
    }
    const fresh = store.findShopifyOrder(row.shop, row.orderGid);
    if (!fresh || fresh.markedPaidAt) return "closed";
    if (fresh.state !== view.state) store.updateShopifyOrder(row.shop, row.orderGid, { state: view.state });
    if (view.state === "PAID") {
      if (toCents(view.amountEur) !== toCents(fresh.amountEur)) {
        // Never mark an order paid for a request of another amount.
        if (!mismatchReported.has(key)) log(`SHOPIFY_AMOUNT_MISMATCH order ${label(row)}: Zold's request is not for the order's amount; not marked paid`);
        mismatchReported.add(key);
        later(key, now);
        return "mismatch";
      }
      const outcome = await markPaid(store.findShopifyOrder(row.shop, row.orderGid)!, view, now);
      if (outcome === "marked") forget(key);
      return outcome;
    }
    if (SHOPIFY_CLOSED_STATES.has(view.state)) {
      forget(key);
      return "closed";
    }
    later(key, now);
    return "pending";
  }

  async function pass(now: number): Promise<{ checked: number; stopped?: string }> {
    const awaiting = store.shopifyOrdersAwaitingSettlement();
    const live = new Set(awaiting.map(keyOf));
    for (const key of backoff.keys()) if (!live.has(key)) forget(key);
    const due = awaiting
      .map((o) => ({ o, at: dueAt(o) }))
      .filter((d) => d.at <= now)
      .sort((a, b) => a.at - b.at)
      .slice(0, opts.batch);
    let checked = 0;
    for (const { o } of due) {
      checked++;
      try {
        await settleOne(o, now);
      } catch (err) {
        if (isCoreOutage(err)) return { checked, stopped: describeCoreFailure(err) };
        // Zold answered; only our write failed. Due again next tick.
        log(`SHOPIFY_STORE_WRITE_FAILED order ${label(o)}: ${errorText(err)}`);
        backoff.delete(keyOf(o));
      }
    }
    return { checked };
  }

  const reportStall = (stopped: string | undefined, now: number) => {
    if (!stopped) {
      if (stalledTicks > 0) log(`SHOPIFY_SETTLE_RECOVERED after ${stalledTicks} stopped ticks`);
      stalledTicks = 0;
      return;
    }
    if (stalledTicks === 0) stalledSince = now;
    stalledTicks++;
    if (stalledTicks === 1 || stalledTicks % STALL_REPORT_EVERY === 0) {
      log(`SHOPIFY_SETTLE_STALLED ${stopped}; ${stalledTicks} ticks stopped since ${new Date(stalledSince).toISOString()}`);
    }
  };

  /** Read what is due. Never two at once: one asked for while one runs makes it go round again. */
  async function tick(now?: number): Promise<{ checked: number; stopped: boolean }> {
    if (running) {
      rerun = true;
      return { checked: 0, stopped: false };
    }
    running = true;
    try {
      let checked = 0;
      let stopped: string | undefined;
      do {
        rerun = false;
        const result = await pass(now ?? ctx.now());
        checked += result.checked;
        stopped = result.stopped;
      } while (rerun && !stopped);
      reportStall(stopped, now ?? ctx.now());
      return { checked, stopped: !!stopped };
    } finally {
      running = false;
    }
  }

  /** Zold's hint about one request: make its order due now. True when there is one still awaiting settlement. */
  function nudge(linkId: string, paymentRequestId: string): boolean {
    const o = store.findShopifyOrderByRequest(linkId, paymentRequestId);
    if (!o || o.markedPaidAt || SHOPIFY_CLOSED_STATES.has(o.state)) return false;
    const key = keyOf(o);
    backoff.set(key, { dueAt: 0, delayMs: opts.baseDelayMs });
    nudged.add(key);
    return true;
  }

  return { tick, nudge, waiting: () => backoff.size };
}

export type ShopifySettler = ReturnType<typeof createShopifySettler>;
