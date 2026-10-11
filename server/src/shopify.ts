/**
 * The Shopify adapter (custom-app mode): connect a store through a Zold
 * merchant link, open a Zold payment request for each Zold order, show the
 * buyer the payment, and mark the order paid once Zold says it is.
 *
 * Zold keeps the money engine (payment requests, deposit attribution, the pay
 * page). This service holds everything Shopify-facing: OAuth, Shopify's
 * webhooks, the Admin API and the store's access token. See docs/shopify.md.
 *
 * Shopify's payments-app mode (a payment method inside checkout) is not here:
 * it needs Shopify's Payments Apps approval, which nobody has.
 */
import express from "express";
import { describeCoreFailure } from "./core-merchant.js";
import { disableConnection, type ShopifyContext } from "./shopify-context.js";
import { createShopifyInstallRouter } from "./shopify-install.js";
import { createShopifyOrdersRouter } from "./shopify-orders.js";
import { createShopifySettler, type ShopifySettlerOptions } from "./shopify-settle.js";
import { createShopifyWebhookRouter } from "./shopify-webhooks.js";
import { store } from "./store.js";

export function createShopifyService(ctx: ShopifyContext, settle: ShopifySettlerOptions) {
  const settler = createShopifySettler(ctx, settle);
  const router = express.Router();
  // The webhook route parses its own raw body; this router is mounted before any JSON parser.
  router.use(createShopifyWebhookRouter(ctx));
  router.use(createShopifyInstallRouter(ctx));
  router.use(createShopifyOrdersRouter(ctx));

  /**
   * Zold's `{linkId}` hint: read the link, and if it was revoked, stop opening
   * requests for its store and remove the store's webhook subscriptions. A
   * failed read is logged; the next orders/create meets LINK_REVOKED anyway.
   */
  async function onLinkHint(linkId: string): Promise<void> {
    const connections = store.findShopifyConnectionsByLink(linkId);
    if (!connections.length) return;
    let active: boolean;
    try {
      active = (await ctx.core.readLink(linkId)).active;
    } catch (err) {
      ctx.log(`SHOPIFY_LINK_READ_FAILED link ${linkId}: ${describeCoreFailure(err)}`);
      return;
    }
    if (active) return;
    for (const c of connections) await disableConnection(ctx, c, "link_revoked");
  }

  return { router, settler, onLinkHint };
}
