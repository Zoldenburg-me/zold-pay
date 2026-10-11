/**
 * What every part of the Shopify adapter shares: settings, the two clients
 * (Shopify's Admin API, Zold's merchant-link service routes), and the sealed
 * secrets of a store's connection.
 */
import type { MerchantCore } from "./core-merchant.js";
import type { ShopifyAdmin } from "./shopify-admin.js";
import { openSecret, sealSecret } from "./secrets.js";
import { store, type ShopifyConnection, type ShopifyDisabledReason } from "./store.js";

export interface ShopifyContext {
  apiSecret: string;
  manualGateway: string;
  /** This service's public origin: the OAuth redirect and webhook URLs are built on it. */
  publicOrigin: string;
  /** Zold's public origin: the merchant goes back to its /business after an install. */
  corePublicUrl: string;
  /** AES-256-GCM key for access tokens and link secrets at rest. */
  tokenKey: Buffer;
  admin: ShopifyAdmin;
  core: MerchantCore;
  log: (...args: unknown[]) => void;
  now: () => number;
}

/** The largest request Zold opens (services/api payment-requests.ts MAX_REQUEST_EUR). */
export const CORE_MAX_REQUEST_EUR = 1_000_000;

export const WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_CANCELLED", "APP_UNINSTALLED"] as const;

export const sealAccessToken = (ctx: ShopifyContext, connectionId: string, token: string) =>
  sealSecret(ctx.tokenKey, "shopify-access-token", connectionId, token);
export const sealLinkSecret = (ctx: ShopifyContext, connectionId: string, secret: string) =>
  sealSecret(ctx.tokenKey, "shopify-link-secret", connectionId, secret);
/** The store's access token. Throws when there is none (the app was uninstalled). */
export function accessTokenOf(ctx: ShopifyContext, c: ShopifyConnection): string {
  if (!c.accessTokenEnc) throw new Error("the store has no access token (the app was uninstalled)");
  return openSecret(ctx.tokenKey, "shopify-access-token", c.id, c.accessTokenEnc);
}
export const linkSecretOf = (ctx: ShopifyContext, c: ShopifyConnection) =>
  openSecret(ctx.tokenKey, "shopify-link-secret", c.id, c.linkSecretEnc);

/** A local failure's message, or a fixed phrase for anything else. Never a token: none is ever in a message here. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : "unknown error").slice(0, 300);

/**
 * Stop a connection opening payment requests. Requests already open stay open
 * (money that arrives still lands in the organisation's account). For a
 * revoked link the settle loop may still mark their orders paid, and the
 * store's webhook subscriptions are removed, best effort. After an uninstall
 * Shopify has removed them and the token no longer works, so the token is
 * deleted and the store's orders count as closed here.
 */
export async function disableConnection(ctx: ShopifyContext, c: ShopifyConnection, reason: ShopifyDisabledReason): Promise<void> {
  const fresh = store.findShopifyConnectionByShop(c.shop);
  if (!fresh || fresh.id !== c.id) return;
  if (fresh.disabledReason !== reason) {
    store.updateShopifyConnection(fresh.id, {
      disabledAt: new Date(ctx.now()).toISOString(),
      disabledReason: reason,
      ...(reason === "app_uninstalled" ? { accessTokenEnc: undefined, webhookSubscriptionIds: [] } : {}),
    });
    if (reason === "app_uninstalled") store.closeShopifyOrdersOf(fresh.shop, ctx.now());
    ctx.log(`SHOPIFY_DISABLED ${fresh.shop}: ${reason}`);
  }
  if (reason !== "link_revoked" || !fresh.webhookSubscriptionIds.length || !fresh.accessTokenEnc) return;
  const left: string[] = [];
  for (const id of fresh.webhookSubscriptionIds) {
    try {
      await ctx.admin.webhookSubscriptionDelete(fresh.shop, accessTokenOf(ctx, fresh), id);
    } catch (err) {
      left.push(id);
      ctx.log(`shopify: could not remove a webhook subscription at ${fresh.shop}: ${errorText(err)}`);
    }
  }
  const now = store.findShopifyConnectionByShop(c.shop);
  if (now?.id === c.id) store.updateShopifyConnection(c.id, { webhookSubscriptionIds: left });
}
