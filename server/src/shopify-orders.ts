/**
 * The buyer's routes for an order.
 *
 * Order ids are per-store sequences, so (shop, order id) names an order to
 * anyone who can count. Each route therefore also takes something only the
 * buyer holds:
 *  - the thank-you page extension sends `t`, the order's checkout token, which
 *    orders/create delivered to us (we keep only its SHA-256);
 *  - the order-confirmation email's link carries `b`, the order id signed with
 *    the store's link secret, which lives in the store's email template (Liquid
 *    `hmac_sha256`).
 * Without the proof, the answer is the same whether the order exists or not.
 */
import express from "express";
import { describeCoreFailure, isCoreError, isCoreOutage } from "./core-merchant.js";
import { linkSecretOf, type ShopifyContext } from "./shopify-context.js";
import { isValidShopDomain, normaliseShop, numericOrderId, orderGidOf, orderLinkProof, sameHex, sha256Hex } from "./shopify-hmac.js";
import { store } from "./store.js";

const NOT_YET = { error: "no payment request for this order yet", pending: true };
const BAD_LINK =
  "This link does not open a payment. Use the link in your order confirmation email, or the payment block on the store's thank-you page.";
/** Signed with when the shop has no connection, so a refusal costs the same either way. */
const NO_SECRET = "0".repeat(64);
const MAX_PROOF = 128;

const noStore = (res: express.Response) => {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-robots-tag", "noindex, nofollow");
};

/** The order a URL names, always with its shop: the same number is a different order at every store. */
function orderRef(shopRaw: unknown, orderRaw: unknown) {
  const shop = normaliseShop(shopRaw);
  const gid = orderGidOf(orderRaw);
  if (!isValidShopDomain(shop) || !gid) return undefined;
  return { shop, gid, orderId: numericOrderId(gid), order: store.findShopifyOrder(shop, gid) };
}

export function createShopifyOrdersRouter(ctx: ShopifyContext): express.Router {
  const router = express.Router();

  /**
   * What the thank-you page extension polls. It runs in Shopify's checkout
   * sandbox, so the answer is CORS-open. With the order's checkout token: Zold's
   * public projection of the request (no IBAN, no name), without the payment
   * code, the return and cancel URLs or any transaction hash, plus the pay
   * page's URL and the order name.
   */
  router.get("/shopify/orders/:shop/:orderId", async (req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    noStore(res);
    try {
      const order = orderRef(req.params.shop, req.params.orderId)?.order;
      const t = typeof req.query.t === "string" && req.query.t.length <= MAX_PROOF ? req.query.t : "";
      const proven = Boolean(order?.checkoutTokenHash && t && sameHex(sha256Hex(t), order.checkoutTokenHash));
      if (!order || !proven) return res.status(404).json(NOT_YET);
      let projection: Record<string, unknown>;
      try {
        projection = await ctx.core.readPublic(order.publicPath);
      } catch (err) {
        // Zold's public route says no (gone, say): to the buyer that is "not yet".
        if (isCoreError(err) && err.status < 500 && !isCoreOutage(err)) return res.status(404).json(NOT_YET);
        ctx.log(`shopify: order lookup for ${order.orderGid} at ${order.shop} failed: ${describeCoreFailure(err)}`);
        return res.status(502).json({ error: "the payment could not be loaded; try again" });
      }
      const { code: _code, returnUrl: _ret, cancelUrl: _cancel, payments, ...rest } = projection;
      res.json({
        ...rest,
        // The state, not the payer's transaction: a hash ties the buyer's wallet to the order.
        payments: Array.isArray(payments)
          ? payments.map((p) => {
              if (!p || typeof p !== "object") return {};
              const { txHash: _tx, ...kept } = p as Record<string, unknown>;
              return kept;
            })
          : [],
        pageUrl: order.pageUrl,
        ...(order.orderName ? { orderName: order.orderName } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The confirmation email's link. `b` must be the numeric order id signed with
   * the store's link secret; checked in constant time, and computed even when
   * there is no store, so a refusal is the same 403 and costs the same either way.
   */
  router.get("/shopify/orders/:shop/:orderId/pay", (req, res, next) => {
    noStore(res);
    try {
      const ref = orderRef(req.params.shop, req.params.orderId);
      const c = ref ? store.findShopifyConnectionByShop(ref.shop) : undefined;
      const b = typeof req.query.b === "string" && req.query.b.length <= MAX_PROOF ? req.query.b.toLowerCase() : "";
      const expected = orderLinkProof(c ? linkSecretOf(ctx, c) : NO_SECRET, ref?.orderId ?? "");
      const valid = sameHex(b, expected) && Boolean(c);
      if (!ref || !valid) return res.status(403).type("text/plain").send(BAD_LINK);
      if (!ref.order) return res.status(404).type("text/plain").send("The payment for this order is not ready yet. Try again in a minute.");
      res.redirect(ref.order.pageUrl);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
