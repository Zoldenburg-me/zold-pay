/**
 * One local HTTP server that plays both Shopify (OAuth, Admin GraphQL) and
 * Zold's merchant-link service routes and public pay projection, for the
 * Shopify adapter tests. Shapes follow the contract in docs/shopify.md and
 * Shopify's documented answers; nothing here has been checked against either
 * real service.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const ACCESS_TOKEN = "shpat_stub_offline_token_value";
export const SERVICE_TOKEN = `zsc_${"S".repeat(43)}`;

export interface StubView {
  id: string;
  code: string;
  handle: string;
  state: string;
  amountEur: number;
  currency: "EUR";
  test?: boolean;
  createdAt: string;
  paidAt?: string;
  order: { gid: string; name?: string };
  shop: string;
  payments: { method: string; amountEur?: number; amountUsdc?: number; txHash?: string; at: string }[];
  pageUrl: string;
  publicPath: string;
}

type Fail = { status: number; body?: unknown } | undefined;

export interface Stub {
  base: string;
  /** Zold's public origin the stub's pay page URLs are on (CORE_PUBLIC_URL). */
  publicOrigin: string;
  /** The organisation name the link preview answers with. */
  orgName: string;
  /** Orders Shopify considers paid (the order status query). */
  paidOrders: Set<string>;
  close: () => void;
  /** Calls as they arrived: Shopify GraphQL ops and Zold service paths. */
  shopifyCalls: { shop: string; op: string; vars: any }[];
  coreCalls: { method: string; path: string; body: any; authorization?: string }[];
  exchanges: string[];
  links: Map<string, { linkId: string; shop: string; secret: string; active: boolean }>;
  requests: Map<string, StubView>;
  /** Next answers to force, one each. */
  fail: {
    exchange?: Fail;
    preview?: Fail;
    open: Fail[];
    read: Fail[];
    cancel: Fail[];
    publicRead: Fail[];
    linkRead: Fail[];
    markPaid: ("userError" | "http500" | "alreadyPaid")[];
    metafield: ("userError")[];
    subscribe: string[];
  };
  /** A link code Zold would mint on /business for this shop. */
  mintLinkCode: (shop: string, linkId?: string) => string;
  setState: (id: string, state: string, payment?: boolean) => void;
  /** Answer the next open with this view instead (e.g. another order's). */
  openOverride: Partial<StubView>[];
  /** Held open answers: resolve to let them through. */
  holdOpen: { promise?: Promise<void> };
}

export async function startStub(): Promise<Stub> {
  const pending = new Map<string, { linkId: string; shop: string; previewed: boolean }>();
  let seq = 0;
  const stub: Stub = {
    base: "",
    publicOrigin: "https://zold.example",
    orgName: "Keycard Demo GmbH",
    paidOrders: new Set(),
    close: () => {},
    shopifyCalls: [],
    coreCalls: [],
    exchanges: [],
    links: new Map(),
    requests: new Map(),
    fail: { open: [], read: [], cancel: [], publicRead: [], linkRead: [], markPaid: [], metafield: [], subscribe: [] },
    mintLinkCode: (shop, linkId = `link-${++seq}`) => {
      const code = `zlc_${randomBytes(32).toString("base64url")}`;
      pending.set(code, { linkId, shop, previewed: false });
      return code;
    },
    setState: (id, state, payment = false) => {
      const v = stub.requests.get(id)!;
      stub.requests.set(id, {
        ...v,
        state,
        ...(state === "PAID" ? { paidAt: "2026-10-11T10:00:00.000Z" } : {}),
        ...(payment
          ? { payments: [{ method: "crypto", amountEur: v.amountEur, amountUsdc: 146.8, txHash: `0x${"ab".repeat(32)}`, at: "2026-10-11T10:00:00.000Z" }] }
          : {}),
      });
    },
    openOverride: [],
    holdOpen: {},
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void route(req.method ?? "GET", req.url ?? "", body, req.headers as Record<string, string>).then(([status, payload]) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
  });

  const failWith = (f: Fail): [number, unknown] => [f!.status, f!.body ?? { error: "stub failure" }];

  async function route(method: string, url: string, raw: string, headers: Record<string, string>): Promise<[number, unknown]> {
    const path = url.split("?")[0];
    const json = raw ? JSON.parse(raw) : {};
    if (path.startsWith("/api/")) {
      stub.coreCalls.push({ method, path, body: json, authorization: headers.authorization });
      return coreRoute(method, path, json, headers);
    }
    const [, shop, ...rest] = path.split("/");
    const p = rest.join("/");
    if (p === "admin/oauth/access_token") {
      if (json.client_id !== "app-key" || json.client_secret !== "app-secret" || json.code !== "good-code") return [400, { error: "invalid_request" }];
      stub.exchanges.push(shop);
      return [200, { access_token: ACCESS_TOKEN, scope: "read_orders,write_orders" }];
    }
    if (/^admin\/api\/\d{4}-\d{2}\/graphql\.json$/.test(p)) {
      if (headers["x-shopify-access-token"] !== ACCESS_TOKEN) return [401, { errors: "Invalid API key or access token" }];
      const op = /(?:mutation|query) \w+\(.*?\)\s*\{\s*(\w+)/s.exec(json.query)?.[1] ?? "?";
      stub.shopifyCalls.push({ shop, op, vars: json.variables });
      return graphql(shop, op, json.variables);
    }
    return [404, { error: "stub: not found" }];
  }

  function graphql(shop: string, op: string, vars: any): [number, unknown] {
    if (op === "webhookSubscriptionCreate") {
      if (stub.fail.subscribe.includes(vars.topic)) {
        return [200, { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: "Invalid topic" }] } } }];
      }
      const dup = stub.shopifyCalls.filter((c) => c.op === op && c.shop === shop && c.vars.topic === vars.topic).length > 1;
      if (dup) return [200, { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: "Address for this topic has already been taken" }] } } }];
      return [200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${vars.topic}` }, userErrors: [] } } }];
    }
    if (op === "webhookSubscriptionDelete") return [200, { data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: vars.id, userErrors: [] } } }];
    if (op === "order") {
      return [200, { data: { order: { id: vars.id, displayFinancialStatus: stub.paidOrders.has(vars.id) ? "PAID" : "PENDING" } } }];
    }
    if (op === "orderMarkAsPaid") {
      const f = stub.fail.markPaid.shift();
      if (f === "alreadyPaid") {
        stub.paidOrders.add(vars.input.id);
        return [200, { data: { orderMarkAsPaid: { order: null, userErrors: [{ message: "Order has already been paid" }] } } }];
      }
      if (f === "http500") return [500, { errors: "Internal error" }];
      if (f === "userError") return [200, { data: { orderMarkAsPaid: { order: null, userErrors: [{ message: "Order cannot be marked as paid" }] } } }];
      stub.paidOrders.add(vars.input.id);
      return [200, { data: { orderMarkAsPaid: { order: { id: vars.input.id, displayFinancialStatus: "PAID" }, userErrors: [] } } }];
    }
    if (op === "metafieldsSet") {
      if (stub.fail.metafield.shift()) return [200, { data: { metafieldsSet: { metafields: [], userErrors: [{ message: "Value is invalid" }] } } }];
      return [200, { data: { metafieldsSet: { metafields: [{ id: "gid://shopify/Metafield/1" }], userErrors: [] } } }];
    }
    return [200, { errors: [{ message: `stub: unknown op ${op}` }] }];
  }

  async function coreRoute(method: string, path: string, body: any, headers: Record<string, string>): Promise<[number, unknown]> {
    const pub = /^\/api\/pay\/([^/]+)\/([^/]+)$/.exec(path);
    if (pub) {
      const f = stub.fail.publicRead.shift();
      if (f) return failWith(f);
      const v = [...stub.requests.values()].find((r) => r.handle === pub[1] && r.code === pub[2]);
      if (!v) return [404, { error: "no such request" }];
      return [200, {
        code: v.code, handle: v.handle, state: v.state, amountEur: v.amountEur, currency: "EUR",
        returnUrl: "https://shop.example/return", cancelUrl: "https://shop.example/cancel",
        test: v.test ?? false, expiresAt: "2026-10-12T09:00:00.000Z", outstandingEur: v.amountEur, displayName: "Keycard",
        qrUrl: "https://zold.example/qr.png", payeeIban: "DE89370400440532013000", somethingNew: { secret: true },
        methods: {
          crypto: {
            chainId: 8453, address: `0x${"11".repeat(20)}`, amountUsdc: 146.8, rate: 1.138, allowanceBps: 50,
            validUntil: "2026-10-11T09:10:00.000Z", uri: "ethereum:0x11@8453", qrUrl: "https://zold.example/qr.png",
            token: { symbol: "USDC", chainName: "Base", decimals: 6, address: `0x${"22".repeat(20)}`, extra: "x" },
          },
          bank: { iban: "DE89370400440532013000", name: "Keycard Demo GmbH" },
        },
        payments: v.payments.map((p) => ({ method: p.method, amountUsdc: p.amountUsdc, txHash: p.txHash, at: p.at, payerAddress: "0xbuyer" })),
      }];
    }
    if (headers.authorization !== `Bearer ${SERVICE_TOKEN}`) return [401, { error: "bad credential" }];
    if (method === "POST" && path === "/api/service/merchant/links/preview") {
      const p = pending.get(body.code);
      if (stub.fail.preview) {
        const f = stub.fail.preview;
        stub.fail.preview = undefined;
        return failWith(f);
      }
      if (!p || p.shop !== body.shop) return [404, { error: "unknown code", code: "LINK_CODE_INVALID" }];
      p.previewed = true;
      return [200, { shop: p.shop, orgName: stub.orgName, payeeHandle: "keycard", payeeDisplayName: "Keycard", expiresAt: "2026-10-11T09:15:00.000Z" }];
    }
    if (method === "POST" && path === "/api/service/merchant/links/exchange") {
      const p = pending.get(body.code);
      pending.delete(body.code);
      if (p && !p.previewed) return [409, { error: "not confirmed", code: "LINK_NOT_CONFIRMED" }];
      if (stub.fail.exchange) {
        const f = stub.fail.exchange;
        stub.fail.exchange = undefined;
        return failWith(f);
      }
      if (!p || p.shop !== body.shop) return [404, { error: "unknown code", code: "LINK_CODE_INVALID" }];
      const existing = stub.links.get(p.linkId);
      const secret = existing?.secret ?? randomBytes(32).toString("hex");
      stub.links.set(p.linkId, { linkId: p.linkId, shop: p.shop, secret, active: true });
      return [200, { linkId: p.linkId, shop: p.shop, orgName: "Keycard Demo GmbH", payeeHandle: "keycard", linkSecret: secret }];
    }
    const m = /^\/api\/service\/merchant\/links\/([^/]+)(\/payment-requests(?:\/([^/]+)(\/cancel)?)?)?$/.exec(path);
    if (!m) return [404, { error: "not found", code: "NOT_FOUND" }];
    const link = stub.links.get(m[1]);
    if (!link) return [404, { error: "not found", code: "NOT_FOUND" }];
    if (!m[2]) {
      const f = stub.fail.linkRead.shift();
      if (f) return failWith(f);
      return [200, { linkId: link.linkId, shop: link.shop, active: link.active, ...(link.active ? {} : { revokedAt: "2026-10-11T09:00:00.000Z" }), payeeHandle: "keycard" }];
    }
    if (!m[3] && method === "POST") {
      if (stub.holdOpen.promise) await stub.holdOpen.promise;
      const f = stub.fail.open.shift();
      if (f) return failWith(f);
      if (!link.active) return [403, { error: "revoked", code: "LINK_REVOKED" }];
      const found = [...stub.requests.values()].find((r) => r.shop === link.shop && r.order.gid === body.order?.gid);
      if (found) return [200, found];
      const id = `pr-${++seq}`;
      const code = `ABCDE${String(seq).padStart(5, "0")}XYZWV`;
      const display = `${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10)}`;
      const v: StubView = {
        id, code: display, handle: "keycard", state: "OPEN", amountEur: body.amountEur, currency: "EUR",
        ...(body.test ? { test: true } : {}), createdAt: "2026-10-11T09:00:00.000Z",
        order: { gid: body.order.gid, ...(body.order.name ? { name: body.order.name } : {}) }, shop: link.shop, payments: [],
        pageUrl: `${stub.publicOrigin}/pay/keycard/${display}`, publicPath: `/api/pay/keycard/${display}`,
      };
      stub.requests.set(id, v);
      const over = stub.openOverride.shift();
      return [201, over ? { ...v, ...over } : v];
    }
    const v = m[3] ? stub.requests.get(m[3]) : undefined;
    if (!v || v.shop !== link.shop) return [404, { error: "not found", code: "NOT_FOUND" }];
    if (m[4]) {
      const f = stub.fail.cancel.shift();
      if (f) return failWith(f);
      if (v.state !== "OPEN") return [409, { error: "not cancellable", code: "NOT_CANCELLABLE", request: v }];
      stub.setState(v.id, "CANCELLED");
      return [200, stub.requests.get(v.id)];
    }
    const f = stub.fail.read.shift();
    if (f) return failWith(f);
    return [200, v];
  }

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return stub;
}
