/**
 * Connecting a store: GET /shopify/install and GET /shopify/callback.
 *
 * The merchant starts on Zold's /business, which mints a one-time `zlc_` link
 * code (the organisation's consent, bound to the shop) and sends them here.
 * We keep the code in memory under an OAuth state nonce, send them to Shopify
 * to approve the app, and on the callback: check Shopify's query HMAC, the
 * state and the shop; exchange Shopify's code for the store's access token;
 * exchange the link code with Zold (contract 4) for the link id and its pay-link
 * secret; seal both secrets and store the connection; subscribe the webhooks;
 * and send the merchant back to Zold's /business.
 *
 * A Shopify token whose link exchange failed is never stored: without Zold's
 * consent this service has no business holding it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { coreCode, describeCoreFailure, isCoreRefusal, type LinkExchange } from "./core-merchant.js";
import {
  WEBHOOK_TOPICS,
  errorText,
  sealAccessToken,
  sealLinkSecret,
  type ShopifyContext,
} from "./shopify-context.js";
import { isValidShopDomain, normaliseShop, verifyQueryHmac } from "./shopify-hmac.js";
import { store, type ShopifyConnection } from "./store.js";

/** How long a started install may take to come back from Shopify. */
export const INSTALL_TTL_MS = 15 * 60_000;
/** Started installs kept at once; the oldest is dropped past this, so unauthenticated starts cannot grow memory. */
const MAX_PENDING_INSTALLS = 5_000;
const LINK_CODE = /^zlc_[A-Za-z0-9_-]{43}$/;

type PendingInstall = { shop: string; link: string; expiresAt: number };

export function createShopifyInstallRouter(ctx: ShopifyContext): express.Router {
  const pending = new Map<string, PendingInstall>();
  const router = express.Router();

  /** Back to Zold's dashboard, the way Zold's own install reports: `error=` (and a `code`) on failure. */
  const back = (res: express.Response, params: Record<string, string>) =>
    res.redirect(`${ctx.corePublicUrl}/business?${new URLSearchParams({ view: "shopify", ...params })}`);

  const prune = (at: number) => {
    for (const [k, v] of pending) {
      if (v.expiresAt > at && pending.size < MAX_PENDING_INSTALLS) break;
      pending.delete(k);
    }
  };

  router.get("/shopify/install", (req, res) => {
    res.setHeader("cache-control", "no-store");
    const shop = normaliseShop(req.query.shop);
    const link = typeof req.query.link === "string" ? req.query.link : "";
    if (!isValidShopDomain(shop)) return back(res, { error: "shop must be the store's myshopify.com domain" });
    if (!LINK_CODE.test(link)) {
      return back(res, { error: "this connect link is not valid; start again from the dashboard", shop });
    }
    const at = ctx.now();
    prune(at);
    const state = randomBytes(24).toString("base64url");
    pending.set(state, { shop, link, expiresAt: at + INSTALL_TTL_MS });
    res.redirect(ctx.admin.authorizeUrl(shop, `${ctx.publicOrigin}/shopify/callback`, state));
  });

  router.get("/shopify/callback", async (req, res, next) => {
    try {
      await callback(req, res);
    } catch (err) {
      next(err);
    }
  });

  async function callback(req: express.Request, res: express.Response) {
    res.setHeader("cache-control", "no-store");
    const q = req.query as Record<string, unknown>;
    if (!verifyQueryHmac(q, ctx.apiSecret)) return back(res, { error: "the install callback did not verify; try connecting again" });
    const shop = normaliseShop(q.shop);
    const state = typeof q.state === "string" ? q.state : "";
    const install = pending.get(state);
    if (!install || install.expiresAt < ctx.now() || install.shop !== shop || !isValidShopDomain(shop)) {
      return back(res, { error: "this install was not started from Zold, or it has expired; start again from the dashboard" });
    }
    pending.delete(state);

    let token: { accessToken: string; scope: string };
    try {
      token = await ctx.admin.exchangeCode(shop, typeof q.code === "string" ? q.code : "");
    } catch (err) {
      ctx.log(`shopify: code exchange for ${shop} failed: ${errorText(err)}`);
      return back(res, { error: "Shopify refused the install; try connecting again", shop });
    }

    let link: LinkExchange;
    try {
      link = await ctx.core.exchangeLink(install.link, shop);
    } catch (err) {
      // The link code is spent by Zold on the first call whatever the answer,
      // so there is nothing to retry: the merchant starts again. The Shopify
      // token is dropped here, unstored.
      ctx.log(`shopify: link exchange for ${shop} failed: ${describeCoreFailure(err)}`);
      const code = isCoreRefusal(err) ? coreCode(err) : undefined;
      return back(res, {
        error: code
          ? "Zold did not accept this connection; start again from the dashboard"
          : "Zold could not be reached to confirm this connection; start again from the dashboard",
        shop,
        ...(code ? { code } : {}),
      });
    }

    const connection = saveConnection(shop, link, token);
    const subscribeFailed = await subscribe(connection, token.accessToken);
    back(res, subscribeFailed ? { shop, error: "connected, but Shopify refused the order webhooks; connect again" } : { shop });
  }

  /**
   * Seal and write in one step with no await in between: the row id is part of
   * the sealed values' associated data, so it is fixed before sealing.
   */
  function saveConnection(shop: string, link: LinkExchange, token: { accessToken: string; scope: string }): ShopifyConnection {
    const existing = store.findShopifyConnectionByShop(shop);
    const id = existing?.id ?? randomUUID();
    const at = new Date(ctx.now()).toISOString();
    return store.saveShopifyConnection({
      id,
      shop,
      linkId: link.linkId,
      accessTokenEnc: sealAccessToken(ctx, id, token.accessToken),
      linkSecretEnc: sealLinkSecret(ctx, id, link.linkSecret),
      scope: token.scope,
      installedAt: at,
      updatedAt: at,
      webhookSubscriptionIds: existing?.webhookSubscriptionIds ?? [],
    });
  }

  /**
   * ORDERS_CREATE, ORDERS_CANCELLED and APP_UNINSTALLED at our one webhook URL.
   * "Already taken" returns no id; the id stored last time is still the live
   * one, so it is kept. True when any subscription was refused.
   */
  async function subscribe(c: ShopifyConnection, accessToken: string): Promise<boolean> {
    const ids = new Set(c.webhookSubscriptionIds);
    let failed = false;
    for (const topic of WEBHOOK_TOPICS) {
      try {
        const created = await ctx.admin.webhookSubscriptionCreate(c.shop, accessToken, topic, `${ctx.publicOrigin}/shopify/webhooks`);
        if (created.id) ids.add(created.id);
      } catch (err) {
        failed = true;
        ctx.log(`SHOPIFY_SUBSCRIBE_FAILED ${c.shop} ${topic}: ${errorText(err)}`);
      }
    }
    const fresh = store.findShopifyConnectionByShop(c.shop);
    if (fresh?.id === c.id) store.updateShopifyConnection(c.id, { webhookSubscriptionIds: [...ids] });
    return failed;
  }

  return router;
}
