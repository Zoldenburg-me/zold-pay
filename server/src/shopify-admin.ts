/**
 * Calls TO Shopify: the OAuth code exchange and the Admin GraphQL API
 * (webhook subscriptions, "Mark as paid", the `zold.payment` metafield).
 * Ported from Zold's services/api/src/shopify/admin.ts, custom-app mode only:
 * the Payments Apps API is not ported (it needs Shopify's approval, which
 * nobody has).
 *
 * Errors carry Shopify's status and, for GraphQL user errors, Shopify's own
 * message, never a request or response body: those can hold the access token
 * (headers) or the OAuth code.
 */
import { isValidShopDomain } from "./shopify-hmac.js";

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export interface ShopifyAdminOptions {
  apiKey: string;
  apiSecret: string;
  scopes: string;
  apiVersion: string;
  /** Test seam: <base>/<shop>/… instead of https://<shop>. */
  shopBaseUrl?: string;
  timeoutMs?: number;
}

export interface OrderPaymentFacts {
  code: string;
  amountEur: number;
  payments: { method: string; amountEur?: number; amountUsdc?: number; txHash?: string; at?: string }[];
  paidAt?: string;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_ERROR_TEXT = 200;

const userErrorText = (errs: { message?: unknown }[]) =>
  errs.map((e) => String(e?.message ?? "")).join("; ").slice(0, MAX_ERROR_TEXT);

export function createShopifyAdmin(opts: ShopifyAdminOptions) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const shopBase = (shop: string): string => {
    if (!isValidShopDomain(shop)) throw new ShopifyApiError("not a myshopify.com domain", 400);
    return opts.shopBaseUrl ? `${opts.shopBaseUrl}/${shop}` : `https://${shop}`;
  };

  /** The signal stays armed while the body is read, so a trickling answer is bounded too. */
  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    });
    const data: any = await res.json().catch(() => undefined);
    return { res, data };
  };

  /** Where the merchant approves the install. `state` is our nonce, checked on the callback. */
  function authorizeUrl(shop: string, redirectUri: string, state: string): string {
    const q = new URLSearchParams({ client_id: opts.apiKey, scope: opts.scopes, redirect_uri: redirectUri, state });
    return `${shopBase(shop)}/admin/oauth/authorize?${q}`;
  }

  async function exchangeCode(shop: string, code: string): Promise<{ accessToken: string; scope: string }> {
    const { res, data } = await post(`${shopBase(shop)}/admin/oauth/access_token`, {}, {
      client_id: opts.apiKey,
      client_secret: opts.apiSecret,
      code,
    });
    if (!res.ok || typeof data?.access_token !== "string" || !data.access_token) {
      throw new ShopifyApiError(`Shopify refused the code exchange (HTTP ${res.status})`, res.ok ? 502 : res.status);
    }
    return { accessToken: data.access_token, scope: typeof data.scope === "string" ? data.scope : "" };
  }

  async function adminGraphql(shop: string, accessToken: string, query: string, variables: Record<string, unknown>): Promise<any> {
    const { res, data } = await post(
      `${shopBase(shop)}/admin/api/${opts.apiVersion}/graphql.json`,
      { "x-shopify-access-token": accessToken },
      { query, variables },
    );
    if (!res.ok) throw new ShopifyApiError(`Shopify Admin API HTTP ${res.status}`, res.status);
    if (Array.isArray(data?.errors) && data.errors.length) {
      throw new ShopifyApiError(`Shopify Admin API errors: ${userErrorText(data.errors)}`);
    }
    return data?.data;
  }

  const refuseOnUserErrors = (payload: any, op: string) => {
    const errs = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
    if (errs.length) throw new ShopifyApiError(`${op}: ${userErrorText(errs)}`, 409);
  };

  /**
   * Subscribe the store to a topic at our URL. "Address for this topic has
   * already been taken" is success: a reinstall must not fail on its own
   * leftovers, and then there is no new id.
   */
  async function webhookSubscriptionCreate(shop: string, token: string, topic: string, callbackUrl: string): Promise<{ id?: string }> {
    const data = await adminGraphql(shop, token, `
      mutation Subscribe($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          webhookSubscription { id } userErrors { field message }
        }
      }`, { topic, sub: { callbackUrl, format: "JSON" } });
    const payload = data?.webhookSubscriptionCreate;
    const errs: { message?: unknown }[] = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
    if (errs.length && !errs.some((e) => /already been taken/i.test(String(e?.message ?? "")))) {
      throw new ShopifyApiError(`webhookSubscriptionCreate: ${userErrorText(errs)}`, 409);
    }
    const id = payload?.webhookSubscription?.id;
    return typeof id === "string" && id ? { id } : {};
  }

  async function webhookSubscriptionDelete(shop: string, token: string, id: string): Promise<void> {
    const data = await adminGraphql(shop, token, `
      mutation Unsubscribe($id: ID!) {
        webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } }
      }`, { id });
    refuseOnUserErrors(data?.webhookSubscriptionDelete, "webhookSubscriptionDelete");
  }

  /** The order's financial status as the Shopify admin shows it (PENDING, PAID, ...). */
  async function orderFinancialStatus(shop: string, token: string, orderGid: string): Promise<string | undefined> {
    const data = await adminGraphql(shop, token, `
      query OrderStatus($id: ID!) {
        order(id: $id) { id displayFinancialStatus }
      }`, { id: orderGid });
    const status = data?.order?.displayFinancialStatus;
    return typeof status === "string" ? status : undefined;
  }

  /**
   * The merchant's "Mark as paid", pressed by us once Zold says the request is
   * paid. Valid for an order whose payment is pending, which is what a manual
   * payment method leaves it in. Refused because the order is already PAID
   * (the merchant pressed it by hand) is success: the order is paid.
   */
  async function orderMarkAsPaid(shop: string, token: string, orderGid: string): Promise<{ alreadyPaid: boolean }> {
    const data = await adminGraphql(shop, token, `
      mutation MarkPaid($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) { order { id displayFinancialStatus } userErrors { field message } }
      }`, { input: { id: orderGid } });
    try {
      refuseOnUserErrors(data?.orderMarkAsPaid, "orderMarkAsPaid");
      return { alreadyPaid: false };
    } catch (err) {
      if ((await orderFinancialStatus(shop, token, orderGid)) === "PAID") return { alreadyPaid: true };
      throw err;
    }
  }

  /** The payment's facts on the order, where the merchant looks: a `zold.payment` JSON metafield. */
  async function orderSetPaymentMetafield(shop: string, token: string, orderGid: string, facts: OrderPaymentFacts): Promise<void> {
    const data = await adminGraphql(shop, token, `
      mutation Note($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
      }`, { metafields: [{ ownerId: orderGid, namespace: "zold", key: "payment", type: "json", value: JSON.stringify(facts) }] });
    refuseOnUserErrors(data?.metafieldsSet, "metafieldsSet");
  }

  return { authorizeUrl, exchangeCode, webhookSubscriptionCreate, webhookSubscriptionDelete, orderMarkAsPaid, orderSetPaymentMetafield };
}

export type ShopifyAdmin = ReturnType<typeof createShopifyAdmin>;
