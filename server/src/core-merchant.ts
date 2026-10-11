/**
 * Typed client for Zold's merchant-link service routes (contract 4-8), called
 * with this service's `zsc_` credential (ZOLD_SERVICE_TOKEN), plus Zold's public
 * projection of a payment request.
 *
 * Every answer is checked before anything trusts it: Zold is trusted to be
 * right, not to be well-formed. Decisions are made on Zold's stable `code`,
 * never on its `error` text. Only a 400, 403, 404 or 409 carrying a code is a
 * refusal (`isCoreRefusal`); a 401, 429 or 503 (credential, rate limit, none
 * issued) is an outage, and so are a 5xx, a timeout and an unreachable Zold:
 * "ask again later", never "no".
 */
import { CoreResponseError } from "./checkout.js";
import { core, type CoreError } from "./core.js";
import { isValidShopDomain } from "./shopify-hmac.js";
import { isId } from "./validate.js";

export interface LinkExchange {
  linkId: string;
  shop: string;
  orgName: string;
  payeeHandle: string;
  /** 32 random bytes in hex: the key the store's email pay link is signed with. */
  linkSecret: string;
}

/** What the merchant confirms before a store is linked (contract: preview). */
export interface LinkPreview {
  shop: string;
  orgName: string;
  payeeHandle: string;
  payeeDisplayName?: string;
  expiresAt?: string;
}

export interface LinkView {
  linkId: string;
  shop: string;
  active: boolean;
  revokedAt?: string;
}

export interface RequestPayment {
  method: string;
  amountEur?: number;
  amountUsdc?: number;
  txHash?: string;
  at?: string;
}

/** The fields of Zold's service view this service uses. */
export interface ServiceView {
  id: string;
  code: string;
  handle: string;
  state: string;
  amountEur: number;
  test?: boolean;
  paidAt?: string;
  order: { gid: string; name?: string };
  shop: string;
  payments: RequestPayment[];
  pageUrl: string;
  publicPath: string;
}

export interface OpenRequestBody {
  amountEur: number;
  description?: string;
  test?: boolean;
  order: { gid: string; name?: string };
}

export interface MerchantCoreOptions {
  token: string;
  /** Zold's public origin (CORE_PUBLIC_URL): a pay page URL from Zold must be on it. */
  corePublicUrl: string;
}

export interface ViewOptions {
  corePublicUrl: string;
}

const STATE_SHAPE = /^[A-Z][A-Z_]{0,31}$/;
const CODE_SHAPE = /^[A-Za-z0-9-]{5,40}$/;
const PUBLIC_PATH = /^\/api\/pay\/([A-Za-z0-9._~-]{1,128})\/[A-Za-z0-9-]{5,40}$/;
/** A path segment: no `%` (no encoded slash or dot), and never only dots. */
const SEGMENT = /^[A-Za-z0-9._~-]{1,128}$/;
const safeSegment = (v: unknown): v is string => typeof v === "string" && SEGMENT.test(v) && !/^\.+$/.test(v);
const isPublicPath = (v: unknown): v is string => {
  const m = typeof v === "string" ? PUBLIC_PATH.exec(v) : null;
  return Boolean(m && safeSegment(m[1]));
};
const LINK_SECRET = /^[0-9a-f]{64}$/;
const ORDER_GID = /^gid:\/\/shopify\/Order\/\d{1,20}$/;

const bad = (why: string) => new CoreResponseError(`unexpected response from the Zold API (${why})`);
const asObject = (raw: unknown, what: string): Record<string, any> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad(`not ${what}`);
  return raw as Record<string, any>;
};
const shortText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const optional = <T>(cond: boolean, value: T) => (cond ? value : undefined);

export function isCoreError(err: unknown): err is CoreError {
  return err instanceof Error && typeof (err as Partial<CoreError>).status === "number";
}

const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409]);
/** Answers that say nothing about the request: our credential, Zold's rate limit, no credential issued. */
const OUTAGE_STATUSES: ReadonlySet<number> = new Set([401, 429, 503]);

/** Zold said no to this request: a 400, 403, 404 or 409 with a stable code. */
export function isCoreRefusal(err: unknown): err is CoreError {
  return isCoreError(err) && REFUSAL_STATUSES.has(err.status) && coreCode(err) !== undefined;
}

/** No read or write to Zold can work right now (credential, rate limit, Zold down or unreachable). */
export function isCoreOutage(err: unknown): boolean {
  if (isCoreError(err)) return OUTAGE_STATUSES.has(err.status);
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  return err instanceof TypeError && err.message === "fetch failed";
}

/** Zold's stable `code` on a refusal, when it has the expected shape. Never its `error` text. */
export function coreCode(err: unknown): string | undefined {
  const code = isCoreError(err) ? (err.body as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(code) ? code : undefined;
}

/** For log lines: a status or a kind of failure, never Zold's own text. */
export function describeCoreFailure(err: unknown): string {
  if (isCoreError(err)) return `HTTP ${err.status}${coreCode(err) ? ` ${coreCode(err)}` : ""}`;
  if (err instanceof CoreResponseError) return err.message;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "Zold API timed out";
  if (err instanceof TypeError && err.message === "fetch failed") return "Zold API unreachable";
  return `local error: ${(err as Error)?.message ?? String(err)}`;
}

export function parseLinkExchange(raw: unknown, shop: string): LinkExchange {
  const b = asObject(raw, "a link");
  if (!isId(b.linkId)) throw bad("no link id");
  if (b.shop !== shop) throw bad("a different shop");
  if (typeof b.linkSecret !== "string" || !LINK_SECRET.test(b.linkSecret)) throw bad("no link secret");
  if (!shortText(b.orgName, 200) || !shortText(b.payeeHandle, 128)) throw bad("no organisation or payee");
  return { linkId: b.linkId, shop, orgName: b.orgName, payeeHandle: b.payeeHandle, linkSecret: b.linkSecret };
}

export function parseLinkPreview(raw: unknown, shop: string): LinkPreview {
  const b = asObject(raw, "a link preview");
  if (b.shop !== shop) throw bad("a different shop");
  if (!shortText(b.orgName, 200) || !shortText(b.payeeHandle, 128)) throw bad("no organisation or payee");
  return {
    shop,
    orgName: b.orgName,
    payeeHandle: b.payeeHandle,
    ...(shortText(b.payeeDisplayName, 200) ? { payeeDisplayName: b.payeeDisplayName } : {}),
    ...(shortText(b.expiresAt, 40) ? { expiresAt: b.expiresAt } : {}),
  };
}

export function parseLinkView(raw: unknown, linkId: string): LinkView {
  const b = asObject(raw, "a link");
  if (b.linkId !== linkId) throw bad("a different link");
  if (!isValidShopDomain(b.shop)) throw bad("no shop");
  if (typeof b.active !== "boolean") throw bad("no active flag");
  return { linkId, shop: b.shop, active: b.active, ...(typeof b.revokedAt === "string" ? { revokedAt: b.revokedAt } : {}) };
}

export function parseServiceView(raw: unknown, opts: ViewOptions): ServiceView {
  const b = asObject(raw, "a payment request");
  if (!isId(b.id)) throw bad("no request id");
  if (typeof b.code !== "string" || !CODE_SHAPE.test(b.code)) throw bad("no code");
  if (!safeSegment(b.handle)) throw bad("no handle");
  if (typeof b.state !== "string" || !STATE_SHAPE.test(b.state)) throw bad("no state");
  if (typeof b.amountEur !== "number" || !Number.isFinite(b.amountEur)) throw bad("no amount");
  const order = asObject(b.order, "an order");
  if (typeof order.gid !== "string" || !ORDER_GID.test(order.gid)) throw bad("no order");
  if (!isValidShopDomain(b.shop)) throw bad("no shop");
  if (!Array.isArray(b.payments)) throw bad("no payments");
  if (!isPublicPath(b.publicPath)) throw bad("no public path");
  if (!pageUrlOnCore(b.pageUrl, opts.corePublicUrl)) throw bad("no page URL");
  return {
    id: b.id,
    code: b.code,
    handle: b.handle,
    state: b.state,
    amountEur: b.amountEur,
    ...(b.test === true ? { test: true } : {}),
    ...(typeof b.paidAt === "string" ? { paidAt: b.paidAt } : {}),
    order: { gid: order.gid, ...(shortText(order.name, 40) ? { name: order.name } : {}) },
    shop: b.shop,
    payments: b.payments.map(parsePayment),
    pageUrl: b.pageUrl,
    publicPath: b.publicPath,
  };
}

function parsePayment(raw: unknown): RequestPayment {
  const p = asObject(raw, "a payment");
  const num = (v: unknown) => optional(typeof v === "number" && Number.isFinite(v), v as number);
  const out: RequestPayment = { method: typeof p.method === "string" ? p.method.slice(0, 32) : "unknown" };
  const amountEur = num(p.amountEur);
  const amountUsdc = num(p.amountUsdc);
  if (amountEur !== undefined) out.amountEur = amountEur;
  if (amountUsdc !== undefined) out.amountUsdc = amountUsdc;
  if (typeof p.txHash === "string" && /^0x[0-9a-fA-F]{1,128}$/.test(p.txHash)) out.txHash = p.txHash;
  if (typeof p.at === "string" && p.at.length <= 40) out.at = p.at;
  return out;
}

/**
 * A page we may redirect a buyer to: Zold's own pay page, on Zold's public
 * origin (CORE_PUBLIC_URL, https in production) under /pay/. A pay page URL
 * anywhere else is refused, so a wrong answer cannot send buyers off-site.
 */
export function pageUrlOnCore(raw: unknown, corePublicUrl: string): raw is string {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    return u.origin === new URL(corePublicUrl).origin && u.pathname.startsWith("/pay/") && !u.pathname.includes("%");
  } catch {
    return false;
  }
}

export function createMerchantCore(opts: MerchantCoreOptions) {
  const auth = { authorization: `Bearer ${opts.token}` };
  const linkPath = (linkId: string) => `/api/service/merchant/links/${encodeURIComponent(linkId)}`;
  const view = (raw: unknown) => parseServiceView(raw, opts);

  return {
    /** Who is asking to link this shop, for the merchant to confirm. Does not spend the code. */
    async previewLink(code: string, shop: string): Promise<LinkPreview> {
      return parseLinkPreview(
        await core("/api/service/merchant/links/preview", { method: "POST", body: { code, shop }, headers: auth }),
        shop,
      );
    },
    /** Contract 4. One-time: the code is spent by this call whatever the answer. Refused unless previewed first. */
    async exchangeLink(code: string, shop: string): Promise<LinkExchange> {
      return parseLinkExchange(
        await core("/api/service/merchant/links/exchange", { method: "POST", body: { code, shop }, headers: auth }),
        shop,
      );
    },
    /** Contract 5. */
    async readLink(linkId: string): Promise<LinkView> {
      return parseLinkView(await core(linkPath(linkId), { headers: auth }), linkId);
    },
    /** Contract 6. Idempotent at Zold on (shop, order gid). */
    async openPaymentRequest(linkId: string, body: OpenRequestBody): Promise<ServiceView> {
      return view(await core(`${linkPath(linkId)}/payment-requests`, { method: "POST", body, headers: auth }));
    },
    /** Contract 7. */
    async readPaymentRequest(linkId: string, id: string): Promise<ServiceView> {
      return view(await core(`${linkPath(linkId)}/payment-requests/${encodeURIComponent(id)}`, { headers: auth }));
    },
    /**
     * Contract 8. A request that cannot be cancelled (paid, or already closed)
     * answers 409 NOT_CANCELLABLE with its view, which is returned with
     * `cancelled: false`; any other failure rejects.
     */
    async cancelPaymentRequest(linkId: string, id: string): Promise<{ view: ServiceView; cancelled: boolean }> {
      try {
        const v = view(
          await core(`${linkPath(linkId)}/payment-requests/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {}, headers: auth }),
        );
        return { view: v, cancelled: true };
      } catch (err) {
        if (!isCoreError(err) || err.status !== 409 || coreCode(err) !== "NOT_CANCELLABLE") throw err;
        return { view: view((err.body as { request?: unknown } | undefined)?.request), cancelled: false };
      }
    },
    /** Zold's public projection of a request (what the pay page renders). No credential. */
    async readPublic(publicPath: string): Promise<Record<string, unknown>> {
      if (!isPublicPath(publicPath)) throw bad("no public path");
      return asObject(await core(publicPath), "a payment request");
    },
  };
}

export type MerchantCore = ReturnType<typeof createMerchantCore>;
