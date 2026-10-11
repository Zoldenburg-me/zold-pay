/**
 * POST /shopify/webhooks: orders/create, orders/cancelled and app/uninstalled.
 *
 * Mounted with express.raw before any JSON parser: X-Shopify-Hmac-Sha256 is
 * over the raw bytes. Every store's webhooks are signed with the one app
 * secret, and X-Shopify-Shop-Domain, which picks the connection, is not covered
 * by the signature. So a delivery id is bound to the first shop it arrived
 * under: the same id under another shop is refused, and a redelivery of one
 * already handled is acknowledged without being processed again. Shopify
 * retries for 48 hours, so ids are kept 72, in memory; after a restart the
 * order-level idempotency (shop + order gid, here and at Zold) is what holds.
 *
 * An order we do not want is acknowledged with a 2xx and ignored: Shopify drops
 * a subscription that keeps failing. Zold unreachable or answering 5xx is not
 * "no request": the delivery answers 503, is not marked handled, and Shopify's
 * retry processes it again.
 */
import express from "express";
import { describeCoreFailure, isCoreRefusal, coreCode, type ServiceView } from "./core-merchant.js";
import { CORE_MAX_REQUEST_EUR, disableConnection, type ShopifyContext } from "./shopify-context.js";
import { cleanOrderName, normaliseShop, orderGidOf, sha256Hex, verifyBodyHmac } from "./shopify-hmac.js";
import { store, type ShopifyConnection, type ShopifyOrder } from "./store.js";

const DELIVERY_TTL_MS = 72 * 3_600_000;
const MAX_DELIVERIES = 50_000;
const MAX_DELIVERY_ID = 200;
/** A cancel that arrived before its order: the order is not opened if it follows within this. */
const TOMBSTONE_TTL_MS = 72 * 3_600_000;
const MAX_TOMBSTONES = 50_000;
/** An order with many line items is large; anything past this is not an order. */
const BODY_LIMIT = "1mb";
const MAX_DESCRIPTION = 140;

type Answer = { status: number; body: Record<string, unknown> };
const ok = (body: Record<string, unknown> = {}): Answer => ({ status: 200, body: { ok: true, ...body } });
/** Zold could not be asked: Shopify should deliver this again. */
const retryLater: Answer = { status: 503, body: { error: "Zold is not reachable; deliver again" } };

export function createShopifyWebhookRouter(ctx: ShopifyContext): express.Router {
  const deliveries = new Map<string, { shop: string; at: number; handled: boolean }>();
  /** Requests being opened right now, by shop and order: a concurrent delivery waits for the first. */
  const opening = new Map<string, Promise<Answer>>();
  /** Orders cancelled before we opened anything for them, by shop and order, until when. */
  const tombstones = new Map<string, number>();

  const tombstoned = (key: string, at: number) => (tombstones.get(key) ?? 0) > at;
  const bury = (key: string, at: number) => {
    for (const [k, until] of tombstones) {
      if (until > at && tombstones.size < MAX_TOMBSTONES) break;
      tombstones.delete(k);
    }
    tombstones.set(key, at + TOMBSTONE_TTL_MS);
  };

  const prune = (at: number) => {
    for (const [id, d] of deliveries) {
      if (deliveries.size <= MAX_DELIVERIES && at - d.at < DELIVERY_TTL_MS) break;
      deliveries.delete(id);
    }
  };

  const router = express.Router();
  router.post("/shopify/webhooks", express.raw({ type: () => true, limit: BODY_LIMIT }), async (req, res, next) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifyBodyHmac(raw, req.header("x-shopify-hmac-sha256"), ctx.apiSecret)) {
        return res.status(401).json({ error: "signature did not verify" });
      }
      const shop = normaliseShop(req.header("x-shopify-shop-domain"));
      const c = shop ? store.findShopifyConnectionByShop(shop) : undefined;
      if (!c) return res.status(404).json({ error: "this store is not connected" });
      const deliveryId = (req.header("x-shopify-webhook-id") ?? "").trim();
      if (!deliveryId || deliveryId.length > MAX_DELIVERY_ID) return res.status(400).json({ error: "X-Shopify-Webhook-Id is required" });
      const at = ctx.now();
      prune(at);
      const seen = deliveries.get(deliveryId);
      if (seen && seen.shop !== c.shop) return res.status(401).json({ error: "this delivery was signed for another store" });
      if (seen?.handled) return res.status(200).json({ ok: true, duplicate: true });
      if (!seen) deliveries.set(deliveryId, { shop: c.shop, at, handled: false });
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "not JSON" });
      }
      const answer = await handle(c, String(req.header("x-shopify-topic") ?? ""), body, req.header("x-shopify-triggered-at"));
      // Handled once answered without a server error; a failed one runs again on Shopify's retry.
      const d = deliveries.get(deliveryId);
      if (d && answer.status < 500) d.handled = true;
      res.status(answer.status).json(answer.body);
    } catch (err) {
      next(err);
    }
  });

  async function handle(c: ShopifyConnection, topic: string, body: unknown, triggeredAt: string | undefined): Promise<Answer> {
    if (topic === "app/uninstalled") {
      // A late or replayed uninstall from before the current install must not undo it.
      const triggered = Date.parse(triggeredAt ?? "");
      if (Number.isFinite(triggered) && triggered < Date.parse(c.installedAt)) return ok({ ignored: "uninstall before this install" });
      await disableConnection(ctx, c, "app_uninstalled");
      return ok({ disabled: true });
    }
    if (topic !== "orders/create" && topic !== "orders/cancelled") return ok({ ignored: "topic" });
    const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, any>) : {};
    const orderGid = orderGidOf(o.admin_graphql_api_id) ?? orderGidOf(o.id);
    if (!orderGid) return { status: 400, body: { error: "the order has no id" } };
    const key = `${c.shop}|${orderGid}`;
    if (topic === "orders/cancelled") return cancel(c, orderGid, key);
    const running = opening.get(key);
    if (running) return running;
    const p = create(c, orderGid, o).finally(() => opening.delete(key));
    opening.set(key, p);
    return p;
  }

  async function cancel(c: ShopifyConnection, orderGid: string, key: string): Promise<Answer> {
    const row = store.findShopifyOrder(c.shop, orderGid);
    if (!row) {
      // Shopify does not promise order: an orders/create arriving after this opens nothing.
      bury(key, ctx.now());
      return ok({ cancelled: false });
    }
    try {
      // Not cancellable (paid, or already CANCELLED or EXPIRED) comes back with
      // the view: a closed one is done, a paid one is the settle loop's.
      const { view } = await ctx.core.cancelPaymentRequest(row.linkId, row.paymentRequestId);
      store.updateShopifyOrder(row.shop, row.orderGid, { state: view.state }, ctx.now());
      return ok({ cancelled: view.state === "CANCELLED", state: view.state });
    } catch (err) {
      if (!isCoreRefusal(err)) {
        ctx.log(`shopify: cancel for ${orderName(row)} at ${c.shop} not sent: ${describeCoreFailure(err)}`);
        return retryLater;
      }
      ctx.log(`SHOPIFY_CANCEL_REFUSED ${orderName(row)} at ${c.shop}: ${describeCoreFailure(err)}`);
      return ok({ cancelled: false, reason: coreCode(err) });
    }
  }

  /** Only a pending EUR order paid by the store's Zold method, for a sane amount, opens a request. */
  async function create(c: ShopifyConnection, orderGid: string, o: Record<string, any>): Promise<Answer> {
    if (store.findShopifyOrder(c.shop, orderGid)) return ok({ existing: true });
    if (tombstoned(`${c.shop}|${orderGid}`, ctx.now())) return ok({ ignored: "cancelled" });
    if (c.disabledAt) return ok({ ignored: "connection disabled" });
    const gateways: string[] = Array.isArray(o.payment_gateway_names) ? o.payment_gateway_names.map((g: unknown) => String(g).toLowerCase()) : [];
    if (!gateways.some((g) => g.includes(ctx.manualGateway))) return ok({ ignored: "not a Zold order" });
    if (o.financial_status !== "pending") return ok({ ignored: "not pending" });
    if (String(o.currency ?? "").toUpperCase() !== "EUR") {
      ctx.log(`shopify: order ${orderGid} at ${c.shop} is not in EUR; Zold settles EUR only, nothing opened`);
      return ok({ ignored: "currency" });
    }
    // Shopify sends the total as a decimal string; Zold takes whole cents only.
    const amount = Number(o.total_price);
    const cents = Math.round(amount * 100);
    if (!(cents > 0) || cents > CORE_MAX_REQUEST_EUR * 100) return ok({ ignored: "amount" });

    const name = cleanOrderName(o.name);
    // Nothing about the buyer goes to Zold. Not order_status_url either: it is a
    // bearer link to the buyer's order page (name, address).
    let view: ServiceView;
    try {
      view = await ctx.core.openPaymentRequest(c.linkId, {
        amountEur: cents / 100,
        description: `Order ${name ?? ""} at ${c.shop}`.replace(/\s+/g, " ").slice(0, MAX_DESCRIPTION),
        ...(o.test === true ? { test: true } : {}),
        order: { gid: orderGid, ...(name ? { name } : {}) },
      });
    } catch (err) {
      return refused(c, orderGid, err);
    }
    if (view.order.gid !== orderGid || view.shop !== c.shop) {
      ctx.log(`SHOPIFY_SETTLE_MISMATCH Zold answered order ${orderGid} at ${c.shop} with another order's request`);
      return retryLater;
    }
    const at = new Date(ctx.now()).toISOString();
    const row: ShopifyOrder = {
      shop: c.shop,
      orderGid,
      linkId: c.linkId,
      paymentRequestId: view.id,
      handle: view.handle,
      code: view.code,
      publicPath: view.publicPath,
      pageUrl: view.pageUrl,
      amountEur: cents / 100,
      ...(name ? { orderName: name } : {}),
      // Only its hash: the token is the buyer's proof on the thank-you page.
      ...(typeof o.checkout_token === "string" && o.checkout_token ? { checkoutTokenHash: sha256Hex(o.checkout_token) } : {}),
      state: view.state,
      markPaidAttempts: 0,
      createdAt: at,
      updatedAt: at,
    };
    store.addShopifyOrder(row);
    // Cancelled while Zold was opening it: cancel it there too.
    if (tombstoned(`${c.shop}|${orderGid}`, ctx.now())) return cancel(c, orderGid, `${c.shop}|${orderGid}`);
    return ok({ opened: true });
  }

  async function refused(c: ShopifyConnection, orderGid: string, err: unknown): Promise<Answer> {
    if (!isCoreRefusal(err)) {
      ctx.log(`shopify: order ${orderGid} at ${c.shop} not opened yet: ${describeCoreFailure(err)}`);
      return retryLater;
    }
    const code = coreCode(err);
    if (code === "LINK_REVOKED") {
      await disableConnection(ctx, c, "link_revoked");
      return ok({ ignored: "link revoked" });
    }
    if (code === "NO_PAYMENT_PAGE") {
      // The payee recorded on the link can no longer be paid. Not retried: the
      // order stays unpaid in Shopify until the merchant links the store again.
      ctx.log(`SHOPIFY_LINK_STALE order ${orderGid} at ${c.shop}: link ${c.linkId} has no payee that can be paid`);
      return ok({ ignored: code });
    }
    ctx.log(`SHOPIFY_ORDER_REFUSED order ${orderGid} at ${c.shop}: ${describeCoreFailure(err)}`);
    return ok({ ignored: code });
  }

  return router;
}

const orderName = (o: ShopifyOrder) => o.orderName ?? o.orderGid;
