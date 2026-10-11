/**
 * Connecting a store: GET /shopify/install, GET /shopify/callback and
 * POST /shopify/confirm.
 *
 * The merchant starts on Zold's /business, which mints a one-time `zlc_` link
 * code (an organisation's consent, bound to the shop) and sends them here.
 *
 *  1. install: keep the code in memory under an OAuth state nonce, bind it to
 *     this browser with an HttpOnly cookie, and send the merchant to Shopify.
 *  2. callback: check Shopify's query HMAC, the state, the shop and the cookie;
 *     exchange Shopify's code for the store's access token; ask Zold who the
 *     link is for (preview, which does not spend the code); hold the sealed
 *     token in memory and show the store's admin a page naming the shop, the
 *     organisation and the payee.
 *  3. confirm: only when the admin presses "Link this store" (same browser, by
 *     the cookie) is the link code exchanged, the connection stored, the
 *     webhooks subscribed, and the admin sent back to Zold.
 *
 * Without step 3 a member of any Zold organisation could mint a link for a shop
 * that is not theirs and have its admin connect it by a single click. A Shopify
 * token whose link was not confirmed or not accepted is never written to disk.
 * Nothing here logs a request URL: the install URL's query carries the link code.
 */
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { coreCode, describeCoreFailure, isCoreRefusal, type LinkExchange, type LinkPreview } from "./core-merchant.js";
import {
  WEBHOOK_TOPICS,
  errorText,
  sealAccessToken,
  sealLinkSecret,
  type ShopifyContext,
} from "./shopify-context.js";
import { isValidShopDomain, normaliseShop, sameHex, sha256Hex, verifyQueryHmac } from "./shopify-hmac.js";
import { openSecret, sealSecret } from "./secrets.js";
import { store, type ShopifyConnection } from "./store.js";

/** How long a started install may take to come back from Shopify, and a confirmation page stays usable. */
export const INSTALL_TTL_MS = 15 * 60_000;
/** Entries kept at once in each map; the oldest is dropped past this, so unauthenticated starts cannot grow memory. */
const MAX_PENDING = 5_000;
const LINK_CODE = /^zlc_[A-Za-z0-9_-]{43}$/;
const PENDING_ID = /^[A-Za-z0-9_-]{32}$/;
/** Binds an install to the browser that started it. `__Host-`: Secure, Path=/, no Domain. */
export const INSTALL_COOKIE = "__Host-zold-shopify-install";

type PendingInstall = { shop: string; link: string; binding: string; expiresAt: number };
type PendingConfirm = {
  shop: string;
  link: string;
  binding: string;
  /** The Shopify access token, sealed under this entry's id. In memory only. */
  tokenEnc: string;
  scope: string;
  preview: LinkPreview;
  expiresAt: number;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function cookieValue(req: express.Request, name: string): string {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/** Prune expired entries (oldest first) and keep the map under its cap. */
function prune<T extends { expiresAt: number }>(map: Map<string, T>, at: number) {
  for (const [k, v] of map) {
    if (v.expiresAt > at && map.size < MAX_PENDING) break;
    map.delete(k);
  }
}

export function createShopifyInstallRouter(ctx: ShopifyContext): express.Router {
  const installs = new Map<string, PendingInstall>();
  const confirms = new Map<string, PendingConfirm>();
  const router = express.Router();
  const coreOrigin = new URL(ctx.corePublicUrl).origin;

  /** Back to Zold's dashboard, the way Zold's own install reports: `error=` (and a `code`) on failure. */
  const back = (res: express.Response, params: Record<string, string>) =>
    res.redirect(`${ctx.corePublicUrl}/business?${new URLSearchParams({ view: "shopify", ...params })}`);

  /** Does this request carry the cookie the install was bound to? */
  const sameBrowser = (req: express.Request, binding: string) => {
    const cookie = cookieValue(req, INSTALL_COOKIE);
    return sameHex(cookie ? sha256Hex(cookie) : "", binding);
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
    prune(installs, at);
    const state = randomBytes(24).toString("base64url");
    const cookie = randomBytes(32).toString("base64url");
    installs.set(state, { shop, link, binding: sha256Hex(cookie), expiresAt: at + INSTALL_TTL_MS });
    res.cookie(INSTALL_COOKIE, cookie, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: INSTALL_TTL_MS,
    });
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
    const install = installs.get(state);
    if (!install || install.expiresAt < ctx.now() || install.shop !== shop || !isValidShopDomain(shop)) {
      return back(res, { error: "this install was not started from Zold, or it has expired; start again from the dashboard" });
    }
    if (!sameBrowser(req, install.binding)) {
      return back(res, { error: "this install was started in another browser; start again from the dashboard", shop });
    }
    installs.delete(state);

    let token: { accessToken: string; scope: string };
    try {
      token = await ctx.admin.exchangeCode(shop, typeof q.code === "string" ? q.code : "");
    } catch (err) {
      ctx.log(`shopify: code exchange for ${shop} failed: ${errorText(err)}`);
      return back(res, { error: "Shopify refused the install; try connecting again", shop });
    }

    let preview: LinkPreview;
    try {
      preview = await ctx.core.previewLink(install.link, shop);
    } catch (err) {
      ctx.log(`shopify: link preview for ${shop} failed: ${describeCoreFailure(err)}`);
      return back(res, coreFailure(err, shop));
    }

    const at = ctx.now();
    prune(confirms, at);
    const pendingId = randomBytes(24).toString("base64url");
    confirms.set(pendingId, {
      shop,
      link: install.link,
      binding: install.binding,
      tokenEnc: sealSecret(ctx.tokenKey, "shopify-access-token", `pending:${pendingId}`, token.accessToken),
      scope: token.scope,
      preview,
      expiresAt: at + INSTALL_TTL_MS,
    });
    confirmPage(res, pendingId, preview);
  }

  /** Zold's refusal (with its code) or outage, as the dashboard shows it. */
  function coreFailure(err: unknown, shop: string): Record<string, string> {
    const code = isCoreRefusal(err) ? coreCode(err) : undefined;
    return {
      error: code
        ? "Zold did not accept this connection; start again from the dashboard"
        : "Zold could not be reached to confirm this connection; start again from the dashboard",
      shop,
      ...(code ? { code } : {}),
    };
  }

  /** The store admin's last word. Every value escaped; no script; forms only to here and back to Zold. */
  function confirmPage(res: express.Response, pendingId: string, p: LinkPreview) {
    const nonce = randomBytes(16).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self' ${coreOrigin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    const payee = p.payeeDisplayName ? `${p.payeeDisplayName} (${p.payeeHandle})` : p.payeeHandle;
    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Link this store to Zold?</title>
<style nonce="${nonce}">
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;background:#fff;color:#111}
main{max-width:520px;margin:0 auto}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}
dt{color:#555}dd{margin:0;font-weight:600;overflow-wrap:anywhere}form{display:flex;gap:12px;margin-top:24px}
button{font:inherit;padding:10px 16px;border-radius:6px;border:1px solid #111;cursor:pointer}
button[value=link]{background:#111;color:#fff}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}dt{color:#aaa}button{border-color:#eee}button[value=link]{background:#eee;color:#111}}
</style></head>
<body><main>
<h1>Link this store to Zold?</h1>
<p>Orders paid with the Zold payment method will be paid into the account below. Only link the store if you recognise the organisation.</p>
<dl>
<dt>Store</dt><dd>${escapeHtml(p.shop)}</dd>
<dt>Organisation</dt><dd>${escapeHtml(p.orgName)}</dd>
<dt>Paid to</dt><dd>${escapeHtml(payee)}</dd>
</dl>
<form method="post" action="/shopify/confirm">
<input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
<button type="submit" name="action" value="link">Link this store</button>
<button type="submit" name="action" value="cancel">Cancel</button>
</form>
</main></body></html>`);
  }

  router.post("/shopify/confirm", express.urlencoded({ extended: false, limit: "2kb" }), async (req, res, next) => {
    try {
      await confirm(req, res);
    } catch (err) {
      next(err);
    }
  });

  async function confirm(req: express.Request, res: express.Response) {
    res.setHeader("cache-control", "no-store");
    const pendingId = typeof req.body?.pending === "string" ? req.body.pending : "";
    const entry = PENDING_ID.test(pendingId) ? confirms.get(pendingId) : undefined;
    if (!entry || entry.expiresAt < ctx.now() || !sameBrowser(req, entry.binding)) {
      return back(res, { error: "this confirmation has expired or was opened in another browser; start again from the dashboard" });
    }
    // One answer per page, whatever it is.
    confirms.delete(pendingId);
    res.clearCookie(INSTALL_COOKIE, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    if (req.body?.action !== "link") return back(res, { error: "the store was not linked", shop: entry.shop });

    let link: LinkExchange;
    try {
      link = await ctx.core.exchangeLink(entry.link, entry.shop);
    } catch (err) {
      // The link code is spent by Zold on the first call whatever the answer,
      // so there is nothing to retry: the merchant starts again. The Shopify
      // token is dropped here, unstored.
      ctx.log(`shopify: link exchange for ${entry.shop} failed: ${describeCoreFailure(err)}`);
      return back(res, coreFailure(err, entry.shop));
    }
    const accessToken = openSecret(ctx.tokenKey, "shopify-access-token", `pending:${pendingId}`, entry.tokenEnc);
    const connection = saveConnection(entry.shop, link, { accessToken, scope: entry.scope });
    const subscribeFailed = await subscribe(connection, accessToken);
    back(res, subscribeFailed ? { shop: entry.shop, error: "connected, but Shopify refused the order webhooks; connect again" } : { shop: entry.shop });
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
