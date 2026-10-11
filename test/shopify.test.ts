import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { ACCESS_TOKEN, SERVICE_TOKEN, startStub } from "./shopify-stub.js";

/**
 * The Shopify adapter over real HTTP, against one stub playing Shopify and
 * Zold's merchant-link service routes. Ports the behaviour Zold's
 * scripts/shopify-orders-test.ts pins for the in-core version: a webhook is
 * acknowledged even when the order is ignored; only our pending EUR orders open
 * a request; a redelivery opens nothing; the lookup is CORS-open and answers
 * only the checkout token's holder; the email link redirects only with the
 * store's signature; "Mark as paid" reaches the store once, with a retry when
 * the store refused; and a shop name in a URL cannot show another store's order.
 */
const stub = await startStub();
const DB = path.join(mkdtempSync(path.join(tmpdir(), "pay-shopify-")), "checkout.json");
process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";
process.env.CORE_API_URL = stub.base;

const { initStore, store } = await import("../server/src/store.js");
const { createShopifyService } = await import("../server/src/shopify.js");
const { createShopifyAdmin } = await import("../server/src/shopify-admin.js");
const { createMerchantCore } = await import("../server/src/core-merchant.js");
const { createErrorHandler } = await import("../server/src/errors.js");
const { signBody, signQuery } = await import("../server/src/shopify-hmac.js");
const { INSTALL_COOKIE } = await import("../server/src/shopify-install.js");

const SECRET = "app-secret";
const SHOP = "keycard-demo.myshopify.com";
const SHOP_B = "other-store.myshopify.com";
const ORIGIN = "https://checkout.example";
const CORE_PUBLIC = "https://zold.example";
const logs: string[] = [];
const allLogs: string[] = [];
let clock = Date.parse("2026-10-11T09:00:00.000Z");

const ctx = {
  apiSecret: SECRET,
  manualGateway: "zold",
  publicOrigin: ORIGIN,
  corePublicUrl: CORE_PUBLIC,
  tokenKey: randomBytes(32),
  admin: createShopifyAdmin({ apiKey: "app-key", apiSecret: SECRET, scopes: "read_orders,write_orders", apiVersion: "2026-07", shopBaseUrl: stub.base }),
  core: createMerchantCore({ token: SERVICE_TOKEN, corePublicUrl: CORE_PUBLIC }),
  log: (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    logs.push(line);
    allLogs.push(line);
  },
  now: () => clock,
};
initStore(DB);
const svc = createShopifyService(ctx, { baseDelayMs: 30_000, maxDelayMs: 3_600_000, batch: 50 });

/** Every body this service answered with, to check no secret ever left. */
const answered: string[] = [];
let base = "";
let server: ReturnType<express.Express["listen"]>;
before(async () => {
  const app = express();
  app.use(svc.router);
  app.use(express.json());
  app.use(createErrorHandler(() => {}));
  await new Promise<void>((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
  stub.close();
});

const call = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${p}`, { redirect: "manual", ...init });
  const text = await res.text();
  answered.push(text, res.headers.get("location") ?? "");
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { text };
  }
  return { status: res.status, body, location: res.headers.get("location") ?? "", headers: res.headers };
};

const webhook = (topic: string, payload: unknown, opts: { shop?: string; secret?: string; id?: string; headers?: Record<string, string> } = {}) => {
  const raw = JSON.stringify(payload);
  return call("/shopify/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": signBody(raw, opts.secret ?? SECRET),
      "x-shopify-shop-domain": opts.shop ?? SHOP,
      "x-shopify-topic": topic,
      "x-shopify-webhook-id": opts.id ?? randomUUID(),
      ...(opts.headers ?? {}),
    },
    body: raw,
  });
};

const oauthQuery = (state: string, shop: string, code = "good-code") => {
  const q: Record<string, string> = { code, shop, state, timestamp: String(Math.floor(clock / 1000)), host: "abc" };
  return new URLSearchParams({ ...q, hmac: signQuery(q, SECRET) }).toString();
};

/** The install route's redirect to Shopify, the state nonce it carries, and the browser-binding cookie. */
const startInstall = async (shop: string, link: string) => {
  const r = await call(`/shopify/install?${new URLSearchParams({ shop, link })}`);
  assert.equal(r.status, 302, JSON.stringify(r.body));
  const setCookie = r.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${INSTALL_COOKIE}=([^;]+)`).exec(setCookie);
  assert.ok(m, `no install cookie: ${setCookie}`);
  return { url: new URL(r.location), state: new URL(r.location).searchParams.get("state")!, cookie: m[1], setCookie };
};
const cookieHeader = (value: string) => ({ cookie: `other=1; ${INSTALL_COOKIE}=${value}` });

const callback = (state: string, shop: string, cookie: string | undefined, code = "good-code") =>
  call(`/shopify/callback?${oauthQuery(state, shop, code)}`, { headers: cookie === undefined ? {} : cookieHeader(cookie) });

const pendingOf = (page: { body: { text?: string } }) => {
  const m = /name="pending" value="([^"]+)"/.exec(page.body.text ?? "");
  assert.ok(m, `no confirmation page: ${page.body.text}`);
  return m[1];
};

const confirmInstall = (pending: string, cookie: string | undefined, action = "link") =>
  call("/shopify/confirm", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie === undefined ? {} : cookieHeader(cookie)) },
    body: new URLSearchParams({ pending, action }).toString(),
  });

/** The whole connect: install, Shopify's callback, the confirmation page, "Link this store". */
const connect = async (shop: string, linkId?: string) => {
  const started = await startInstall(shop, stub.mintLinkCode(shop, linkId));
  const page = await callback(started.state, shop, started.cookie);
  assert.equal(page.status, 200, page.location);
  return confirmInstall(pendingOf(page), started.cookie);
};
const exchangeCalls = () => stub.coreCalls.filter((x) => x.path === "/api/service/merchant/links/exchange").length;

let orderNo = 3100;
const order = (over: Record<string, unknown> = {}) => {
  const id = 5_000_000_000 + ++orderNo;
  return {
    id, admin_graphql_api_id: `gid://shopify/Order/${id}`, name: `#${orderNo}`, currency: "EUR", total_price: "129.00",
    financial_status: "pending", payment_gateway_names: ["Zold — pay with crypto"], test: false,
    order_status_url: `https://${SHOP}/12345/orders/abc/authenticate?key=k`,
    checkout_token: randomBytes(16).toString("hex"),
    customer: { email: "buyer@example.com", first_name: "Bea" },
    ...over,
  };
};
const opens = () => stub.coreCalls.filter((c) => c.method === "POST" && c.path.endsWith("/payment-requests"));
const row = (o: { admin_graphql_api_id: string }, shop = SHOP) => store.findShopifyOrder(shop, o.admin_graphql_api_id);
const marks = (gid: string) => stub.shopifyCalls.filter((c) => c.op === "orderMarkAsPaid" && c.vars.input.id === gid);
const later = (ms: number) => (clock += ms);

beforeEach(() => {
  logs.length = 0;
});

describe("install", () => {
  it("sends the merchant to Shopify's authorize page with our scopes, callback and a fresh state, bound by an HttpOnly cookie", async () => {
    const { url: u, setCookie } = await startInstall(SHOP, stub.mintLinkCode(SHOP));
    assert.equal(u.origin + u.pathname, `${stub.base}/${SHOP}/admin/oauth/authorize`);
    assert.equal(u.searchParams.get("scope"), "read_orders,write_orders");
    assert.equal(u.searchParams.get("client_id"), "app-key");
    assert.equal(u.searchParams.get("redirect_uri"), `${ORIGIN}/shopify/callback`);
    assert.match(u.searchParams.get("state")!, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(u.searchParams.has("link"), false, "the link code went to Shopify");
    for (const attr of [/HttpOnly/i, /Secure/i, /SameSite=Lax/i, /Path=\//i]) assert.match(setCookie, attr);
  });

  it("never echoes the link code: not in a refusal, the redirect to Shopify, the cookie or a log line", async () => {
    const code = stub.mintLinkCode(SHOP);
    const refused = await call(`/shopify/install?${new URLSearchParams({ shop: "evil.example.com", link: code })}`);
    const refusedShape = await call(`/shopify/install?${new URLSearchParams({ shop: SHOP, link: `${code}x` })}`);
    const sent = await call(`/shopify/install?${new URLSearchParams({ shop: SHOP, link: code })}`);
    for (const r of [refused, refusedShape, sent]) {
      assert.equal(r.location.includes(code), false);
      assert.equal(JSON.stringify(r.body).includes(code), false);
      assert.equal((r.headers.get("set-cookie") ?? "").includes(code), false);
    }
    assert.equal(allLogs.some((l) => l.includes(code)), false);
  });

  it("refuses a shop that is not a myshopify.com domain and a link that is not a zlc_ code, back to Zold", async () => {
    for (const q of [{ shop: "evil.example.com", link: stub.mintLinkCode(SHOP) }, { shop: SHOP, link: "zlc_short" }, { shop: SHOP, link: "" }]) {
      const r = await call(`/shopify/install?${new URLSearchParams(q)}`);
      assert.equal(r.status, 302);
      const back = new URL(r.location);
      assert.equal(back.origin + back.pathname, `${CORE_PUBLIC}/business`);
      assert.ok(back.searchParams.get("error"));
    }
  });

  it("a callback with a wrong HMAC, an unknown state or another shop stores nothing and fetches no token", async () => {
    const { state, cookie } = await startInstall(SHOP, stub.mintLinkCode(SHOP));
    const exchanges = stub.exchanges.length;
    const forged = oauthQuery(state, SHOP).replace(/hmac=[0-9a-f]+/, `hmac=${"0".repeat(64)}`);
    for (const q of [forged, oauthQuery("not-a-state", SHOP), oauthQuery(state, SHOP_B)]) {
      const r = await call(`/shopify/callback?${q}`, { headers: cookieHeader(cookie) });
      assert.equal(r.status, 302);
      assert.ok(new URL(r.location).searchParams.get("error"), r.location);
    }
    assert.equal(stub.exchanges.length, exchanges);
    assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
    assert.equal(store.findShopifyConnectionByShop(SHOP_B), undefined);
  });

  it("a callback without the install's cookie, or with another browser's, is refused before any token is fetched", async () => {
    const mine = await startInstall(SHOP, stub.mintLinkCode(SHOP));
    const theirs = await startInstall(SHOP, stub.mintLinkCode(SHOP));
    const exchanges = stub.exchanges.length;
    for (const cookie of [undefined, theirs.cookie, "", "x".repeat(43)]) {
      const r = await callback(mine.state, SHOP, cookie);
      assert.equal(r.status, 302);
      assert.match(new URL(r.location).searchParams.get("error")!, /another browser/);
    }
    assert.equal(stub.exchanges.length, exchanges);
    // The refusals did not spend the state: the right browser still continues.
    assert.equal((await callback(mine.state, SHOP, mine.cookie)).status, 200);
  });

  it("an expired install is refused", async () => {
    const { state, cookie } = await startInstall(SHOP, stub.mintLinkCode(SHOP));
    later(16 * 60_000);
    const r = await callback(state, SHOP, cookie);
    assert.match(new URL(r.location).searchParams.get("error")!, /expired/);
    assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
  });

  it("Shopify refusing the code exchange stores nothing and never asks Zold", async () => {
    const { state, cookie } = await startInstall(SHOP, stub.mintLinkCode(SHOP));
    const before = stub.coreCalls.length;
    const r = await callback(state, SHOP, cookie, "bad-code");
    assert.match(new URL(r.location).searchParams.get("error")!, /Shopify refused/);
    assert.equal(stub.coreCalls.length, before, "Zold was asked about a failed install");
    assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
  });

  it("the callback shows the store's admin who is asking, and links nothing until they confirm", async () => {
    const { state, cookie } = await startInstall(SHOP, stub.mintLinkCode(SHOP));
    const exchanges = exchangeCalls();
    const page = await callback(state, SHOP, cookie);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /form-action 'self' https:\/\/zold\.example/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = page.body.text as string;
    for (const shown of [SHOP, "Keycard Demo GmbH", "Keycard (keycard)", "Link this store", "Cancel"]) assert.ok(html.includes(shown), shown);
    assert.equal(/<script/i.test(html), false);
    assert.equal(html.includes(ACCESS_TOKEN), false);
    assert.equal(exchangeCalls(), exchanges, "the link was exchanged before the admin confirmed");
    assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
    assert.equal(existsSync(DB) && readFileSync(DB, "utf8").includes(ACCESS_TOKEN), false);
  });

  it("escapes every value on the confirmation page", async () => {
    stub.orgName = `<script>alert(1)</script>"&'`;
    try {
      const { state, cookie } = await startInstall(SHOP, stub.mintLinkCode(SHOP));
      const html = (await callback(state, SHOP, cookie)).body.text as string;
      assert.equal(html.includes("<script>alert(1)"), false);
      assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;"), html);
    } finally {
      stub.orgName = "Keycard Demo GmbH";
    }
  });

  for (const [name, fail, code, message] of [
    ["refuses the preview (404 with a code)", { status: 404, body: { error: "no", code: "LINK_CODE_INVALID" } }, "LINK_CODE_INVALID", /did not accept/],
    ["cannot preview (503)", { status: 503, body: { error: "no credential", code: "SERVICE_UNAVAILABLE" } }, null, /could not be reached/],
  ] as const) {
    it(`when Zold ${name}, no page is shown and nothing is stored`, async () => {
      stub.fail.preview = fail;
      const { state, cookie } = await startInstall(SHOP, stub.mintLinkCode(SHOP));
      const r = await callback(state, SHOP, cookie);
      assert.equal(r.status, 302);
      const back = new URL(r.location);
      assert.match(back.searchParams.get("error")!, message);
      assert.equal(back.searchParams.get("code"), code);
      assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
    });
  }

  it("a confirm without the cookie, with another browser's, with a wrong id or after 15 minutes is refused and exchanges nothing", async () => {
    const mine = await startInstall(SHOP, stub.mintLinkCode(SHOP));
    const theirs = await startInstall(SHOP_B, stub.mintLinkCode(SHOP_B));
    const pending = pendingOf(await callback(mine.state, SHOP, mine.cookie));
    const exchanges = exchangeCalls();
    for (const [id, cookie] of [[pending, undefined], [pending, theirs.cookie], ["x".repeat(32), mine.cookie], ["../etc", mine.cookie]] as const) {
      const r = await confirmInstall(id, cookie);
      assert.equal(r.status, 302);
      assert.match(new URL(r.location).searchParams.get("error")!, /expired or was opened in another browser/);
    }
    assert.equal(exchangeCalls(), exchanges);
    later(16 * 60_000);
    const late = await confirmInstall(pending, mine.cookie);
    assert.match(new URL(late.location).searchParams.get("error")!, /expired/);
    assert.equal(exchangeCalls(), exchanges);
    assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
  });

  it("Cancel links nothing, spends no code, and the page cannot be answered twice", async () => {
    const { state, cookie } = await startInstall(SHOP, stub.mintLinkCode(SHOP));
    const pending = pendingOf(await callback(state, SHOP, cookie));
    const exchanges = exchangeCalls();
    const r = await confirmInstall(pending, cookie, "cancel");
    assert.match(new URL(r.location).searchParams.get("error")!, /not linked/);
    assert.match(r.headers.get("set-cookie") ?? "", new RegExp(`${INSTALL_COOKIE}=;`));
    const again = await confirmInstall(pending, cookie, "link");
    assert.match(new URL(again.location).searchParams.get("error")!, /expired/);
    assert.equal(exchangeCalls(), exchanges);
    assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
  });

  for (const [name, fail, code, message] of [
    ["refuses the link (409 with a code)", { status: 409, body: { error: "no", code: "SHOP_LINKED_ELSEWHERE" } }, "SHOP_LINKED_ELSEWHERE", /did not accept/],
    ["answers 500", { status: 500 }, null, /could not be reached/],
    ["answers 503", { status: 503, body: { error: "no credential", code: "SERVICE_UNAVAILABLE" } }, null, /could not be reached/],
  ] as const) {
    it(`when Zold ${name} at confirm, the Shopify token that was already exchanged is not stored`, async () => {
      stub.fail.exchange = fail;
      const exchanges = stub.exchanges.length;
      const r = await connect(SHOP);
      const back = new URL(r.location);
      assert.equal(stub.exchanges.length, exchanges + 1, "the Shopify code was exchanged");
      assert.match(back.searchParams.get("error")!, message);
      assert.equal(back.searchParams.get("code"), code);
      assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
      assert.equal(existsSync(DB) && readFileSync(DB, "utf8").includes(ACCESS_TOKEN), false);
    });
  }

  it("connects on confirm: seals the token and link secret, subscribes three topics at our webhook URL, and returns to Zold", async () => {
    const r = await connect(SHOP, "link-a");
    assert.equal(r.location, `${CORE_PUBLIC}/business?view=shopify&shop=${SHOP}`);
    const c = store.findShopifyConnectionByShop(SHOP)!;
    assert.equal(c.linkId, "link-a");
    assert.equal(c.scope, "read_orders,write_orders");
    assert.deepEqual(c.webhookSubscriptionIds.sort(), [
      "gid://shopify/WebhookSubscription/APP_UNINSTALLED",
      "gid://shopify/WebhookSubscription/ORDERS_CANCELLED",
      "gid://shopify/WebhookSubscription/ORDERS_CREATE",
    ]);
    const subs = stub.shopifyCalls.filter((x) => x.op === "webhookSubscriptionCreate" && x.shop === SHOP);
    assert.ok(subs.every((x) => x.vars.sub.callbackUrl === `${ORIGIN}/shopify/webhooks`));
    const exchange = stub.coreCalls.find((x) => x.path === "/api/service/merchant/links/exchange" && x.body.shop === SHOP)!;
    assert.equal(exchange.authorization, `Bearer ${SERVICE_TOKEN}`);
    const disk = readFileSync(DB, "utf8");
    assert.equal(disk.includes(ACCESS_TOKEN), false, "the access token is on disk in the clear");
    assert.equal(disk.includes(stub.links.get("link-a")!.secret), false, "the link secret is on disk in the clear");
  });

  it("a reconnect whose subscriptions already exist keeps their ids, and one Shopify refuses is reported", async () => {
    const before = store.findShopifyConnectionByShop(SHOP)!;
    stub.fail.subscribe.push("APP_UNINSTALLED");
    const r = await connect(SHOP, "link-a");
    stub.fail.subscribe.length = 0;
    assert.match(new URL(r.location).searchParams.get("error")!, /refused the order webhooks/);
    const c = store.findShopifyConnectionByShop(SHOP)!;
    assert.equal(c.id, before.id);
    assert.deepEqual(c.webhookSubscriptionIds.sort(), before.webhookSubscriptionIds.sort());
    assert.ok(logs.some((l) => l.startsWith("SHOPIFY_SUBSCRIBE_FAILED")));
  });
});

describe("Shopify webhooks", () => {
  it("refuses a bad signature (401), an unknown store (404) and a delivery without an id (400)", async () => {
    assert.equal((await webhook("orders/create", order(), { secret: "wrong" })).status, 401);
    assert.equal((await webhook("orders/create", order(), { shop: "stranger.myshopify.com" })).status, 404);
    const raw = JSON.stringify(order());
    const r = await call("/shopify/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-hmac-sha256": signBody(raw, SECRET), "x-shopify-shop-domain": SHOP, "x-shopify-topic": "orders/create" },
      body: raw,
    });
    assert.equal(r.status, 400);
  });

  it("verifies over the raw bytes: a body re-serialised with other whitespace does not verify", async () => {
    const o = order();
    const raw = JSON.stringify(o, null, 2);
    const r = await call("/shopify/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-hmac-sha256": signBody(JSON.stringify(o), SECRET), "x-shopify-shop-domain": SHOP, "x-shopify-topic": "orders/create", "x-shopify-webhook-id": randomUUID() },
      body: raw,
    });
    assert.equal(r.status, 401);
  });

  const ignored: [string, Record<string, unknown>][] = [
    ["paid another way", { payment_gateway_names: ["shopify_payments"] }],
    ["already paid", { financial_status: "paid" }],
    ["in USD", { currency: "USD" }],
    ["for nothing", { total_price: "0.00" }],
    ["for a total that is not a number", { total_price: "abc" }],
    ["over Zold's ceiling", { total_price: "1000000.01" }],
  ];
  for (const [name, over] of ignored) {
    it(`acknowledges an order ${name} and opens nothing`, async () => {
      const before = opens().length;
      const o = order(over);
      const r = await webhook("orders/create", o);
      assert.equal(r.status, 200);
      assert.ok(r.body.ignored, JSON.stringify(r.body));
      assert.equal(opens().length, before);
      assert.equal(row(o), undefined);
    });
  }

  it("opens a request for a pending EUR Zold order, sized in whole cents, with the shop left to Zold", async () => {
    const o = order({ total_price: "19.999", test: true });
    const r = await webhook("orders/create", o);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sent = opens().at(-1)!;
    assert.equal(sent.path, "/api/service/merchant/links/link-a/payment-requests");
    assert.equal(sent.authorization, `Bearer ${SERVICE_TOKEN}`);
    assert.equal(sent.body.amountEur, 20);
    assert.equal(sent.body.test, true);
    assert.deepEqual(sent.body.order, { gid: o.admin_graphql_api_id, name: o.name });
    assert.equal(sent.body.shop, undefined);
    for (const buyer of ["buyer@example.com", o.order_status_url, "authenticate?key"]) {
      assert.equal(JSON.stringify(sent.body).includes(buyer), false, "the buyer's details went to Zold");
    }
    const saved = row(o)!;
    assert.equal(saved.amountEur, 20);
    assert.equal(saved.state, "OPEN");
    assert.equal(saved.linkId, "link-a");
    assert.ok(saved.checkoutTokenHash && saved.checkoutTokenHash !== o.checkout_token);
    assert.equal(readFileSync(DB, "utf8").includes(o.checkout_token), false, "the checkout token is stored in the clear");
  });

  it("rounds a total to cents the way Zold counts them", async () => {
    await webhook("orders/create", order({ total_price: "10.005" }));
    assert.equal(opens().at(-1)!.body.amountEur, 10.01);
    await webhook("orders/create", order({ total_price: "0.004" }));
    assert.notEqual(opens().at(-1)!.body.amountEur, 0);
  });

  it("strips control characters from the order name before it is sent, stored or logged", async () => {
    const o = order({ name: "#9\n\u0000SHOPIFY_DISABLED fake\u2028" });
    await webhook("orders/create", o);
    assert.equal(opens().at(-1)!.body.order.name, "#9SHOPIFY_DISABLED fake");
    assert.equal(row(o)!.orderName, "#9SHOPIFY_DISABLED fake");
    const long = order({ name: "#".repeat(41) });
    await webhook("orders/create", long);
    assert.equal(row(long)!.orderName, undefined);
  });

  it("a redelivery of the same order opens nothing new; concurrent deliveries open one", async () => {
    const o = order();
    await webhook("orders/create", o);
    const before = opens().length;
    assert.equal((await webhook("orders/create", o)).status, 200);
    assert.equal(opens().length, before);
    const o2 = order();
    let release = () => {};
    stub.holdOpen.promise = new Promise<void>((r) => (release = r));
    const all = Promise.all([1, 2, 3, 4].map(() => webhook("orders/create", o2)));
    await new Promise((r) => setTimeout(r, 100));
    release();
    stub.holdOpen.promise = undefined;
    assert.ok((await all).every((a) => a.status === 200));
    assert.equal(opens().length, before + 1);
  });

  it("a delivery id already handled is acknowledged and not processed again", async () => {
    const o = order();
    const id = randomUUID();
    assert.equal((await webhook("orders/create", o, { id })).status, 200);
    const again = await webhook("orders/cancelled", o, { id });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(row(o)!.state, "OPEN");
  });

  it("a delivery signed for one store and replayed under another store's name is refused", async () => {
    await connect(SHOP_B, "link-b");
    const o = order();
    const id = randomUUID();
    assert.equal((await webhook("orders/create", o, { id })).status, 200);
    const replay = await webhook("orders/create", o, { id, shop: SHOP_B });
    assert.equal(replay.status, 401);
    assert.equal(row(o, SHOP_B), undefined);
  });

  it("the same order id at two stores is two orders: neither cancels nor swallows the other", async () => {
    const o = order();
    await webhook("orders/create", o);
    const a = row(o)!;
    await webhook("orders/create", o, { shop: SHOP_B });
    const b = row(o, SHOP_B)!;
    assert.notEqual(b.paymentRequestId, a.paymentRequestId, "store B's order was deduped against store A's");
    assert.equal(b.linkId, "link-b");
    const cancelled = await webhook("orders/cancelled", o, { shop: SHOP_B });
    assert.equal(cancelled.body.cancelled, true);
    assert.equal(stub.requests.get(b.paymentRequestId)!.state, "CANCELLED");
    assert.equal(stub.requests.get(a.paymentRequestId)!.state, "OPEN", "store B cancelled store A's request");
    // A cancel for an order store C never sent leaves A's alone, and blocks only C's.
    const tomb = order();
    await webhook("orders/cancelled", tomb, { shop: SHOP_B });
    assert.equal((await webhook("orders/create", tomb)).body.opened, true);
  });

  for (const status of [500, 502, 503, 429, 401]) {
    it(`Zold answering ${status} is not "no request": 503 to Shopify, and the retry of that delivery opens it`, async () => {
      const o = order();
      const id = randomUUID();
      stub.fail.open.push({ status, body: { error: "down", code: "SOMETHING" } });
      const first = await webhook("orders/create", o, { id });
      assert.equal(first.status, 503);
      assert.equal(row(o), undefined);
      const retry = await webhook("orders/create", o, { id });
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.ok(row(o));
    });
  }

  it("a 4xx from Zold without a code is not a refusal either", async () => {
    stub.fail.open.push({ status: 404, body: { error: "gateway page" } });
    assert.equal((await webhook("orders/create", order())).status, 503);
  });

  it("Zold refusing with ORDER_TAKEN is acknowledged, logged by code, and stores nothing", async () => {
    const o = order();
    stub.fail.open.push({ status: 409, body: { error: "taken: secret detail", code: "ORDER_TAKEN" } });
    const r = await webhook("orders/create", o);
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, "ORDER_TAKEN");
    assert.equal(row(o), undefined);
    assert.ok(logs.some((l) => l.startsWith("SHOPIFY_ORDER_REFUSED") && l.includes("ORDER_TAKEN") && !l.includes("secret detail")));
  });

  it("Zold refusing with NO_PAYMENT_PAGE logs SHOPIFY_LINK_STALE, is acknowledged and not retried", async () => {
    const o = order();
    const id = randomUUID();
    stub.fail.open.push({ status: 409, body: { error: "no page", code: "NO_PAYMENT_PAGE" } });
    const r = await webhook("orders/create", o, { id });
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, "NO_PAYMENT_PAGE");
    assert.equal(row(o), undefined);
    assert.ok(logs.some((l) => l.startsWith("SHOPIFY_LINK_STALE")));
    const before = opens().length;
    assert.equal((await webhook("orders/create", o, { id })).body.duplicate, true);
    assert.equal(opens().length, before, "a stale link was retried");
  });

    it("Zold answering with another order's request stores nothing and asks Shopify to retry", async () => {
    const o = order();
    stub.openOverride.push({ order: { gid: "gid://shopify/Order/1" } });
    assert.equal((await webhook("orders/create", o)).status, 503);
    assert.equal(row(o), undefined);
  });

  it("acknowledges a topic it does not handle, and refuses a body that is not JSON or names no order", async () => {
    assert.equal((await webhook("products/update", { id: 1 })).body.ignored, "topic");
    assert.equal((await webhook("orders/create", { id: "x" })).status, 400);
    const raw = "not json";
    const r = await call("/shopify/webhooks", {
      method: "POST",
      headers: { "x-shopify-hmac-sha256": signBody(raw, SECRET), "x-shopify-shop-domain": SHOP, "x-shopify-topic": "orders/create", "x-shopify-webhook-id": randomUUID() },
      body: raw,
    });
    assert.equal(r.status, 400);
  });
});

describe("orders/cancelled", () => {
  it("cancels an open request at Zold", async () => {
    const o = order();
    await webhook("orders/create", o);
    const r = await webhook("orders/cancelled", o);
    assert.equal(r.body.cancelled, true);
    assert.equal(row(o)!.state, "CANCELLED");
    assert.equal(store.shopifyOrdersAwaitingSettlement().some((x) => x.orderGid === o.admin_graphql_api_id), false);
  });

  for (const state of ["EXPIRED", "CANCELLED"]) {
    it(`a request already ${state} (409 NOT_CANCELLABLE with its view) is done, not a failure`, async () => {
      const o = order();
      await webhook("orders/create", o);
      stub.setState(row(o)!.paymentRequestId, state);
      const r = await webhook("orders/cancelled", o);
      assert.equal(r.status, 200);
      assert.equal(r.body.state, state);
      assert.equal(row(o)!.state, state);
    });
  }

  it("a paid request is left to the settle loop", async () => {
    const o = order();
    await webhook("orders/create", o);
    stub.setState(row(o)!.paymentRequestId, "PAID", true);
    const r = await webhook("orders/cancelled", o);
    assert.equal(r.body.cancelled, false);
    assert.equal(row(o)!.state, "PAID");
    assert.ok(store.shopifyOrdersAwaitingSettlement().some((x) => x.orderGid === o.admin_graphql_api_id));
  });

  it("an order we never opened is acknowledged, and its orders/create arriving later opens nothing", async () => {
    const o = order();
    assert.deepEqual((await webhook("orders/cancelled", o)).body, { ok: true, cancelled: false });
    const before = opens().length;
    const r = await webhook("orders/create", o);
    assert.equal(r.body.ignored, "cancelled");
    assert.equal(opens().length, before);
    assert.equal(row(o), undefined);
    // The tombstone is per shop, and lasts 72 hours.
    later(73 * 3_600_000);
    assert.equal((await webhook("orders/create", o)).body.opened, true);
  });

  it("a cancel that arrives while the request is being opened cancels it once it is", async () => {
    const o = order();
    let release = () => {};
    stub.holdOpen.promise = new Promise<void>((r) => (release = r));
    const creating = webhook("orders/create", o);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await webhook("orders/cancelled", o)).body.cancelled, false);
    stub.holdOpen.promise = undefined;
    release();
    assert.equal((await creating).body.cancelled, true);
    assert.equal(row(o)!.state, "CANCELLED");
    assert.equal(stub.requests.get(row(o)!.paymentRequestId)!.state, "CANCELLED");
  });

  it("Zold down is retried (503); a refusal with a code is acknowledged", async () => {
    const o = order();
    await webhook("orders/create", o);
    stub.fail.cancel.push({ status: 500 });
    assert.equal((await webhook("orders/cancelled", o)).status, 503);
    stub.fail.cancel.push({ status: 404, body: { error: "x", code: "NOT_FOUND" } });
    const r = await webhook("orders/cancelled", o);
    assert.equal(r.status, 200);
    assert.equal(r.body.reason, "NOT_FOUND");
  });
});

describe("buyer routes", () => {
  let o: ReturnType<typeof order>;
  before(async () => {
    o = order();
    await webhook("orders/create", o);
  });
  const lookup = (shop: string, id: string | number, t?: string) =>
    call(`/shopify/orders/${shop}/${encodeURIComponent(String(id))}${t === undefined ? "" : `?t=${encodeURIComponent(t)}`}`);

  it("answers the checkout token's holder CORS-open with Zold's projection, without code, return/cancel URLs or tx hashes", async () => {
    stub.setState(row(o)!.paymentRequestId, "OPEN", true);
    const r = await lookup(SHOP, o.id, o.checkout_token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.deepEqual(r.body, {
      state: "OPEN", amountEur: 129, outstandingEur: 129, currency: "EUR", test: false, expiresAt: "2026-10-12T09:00:00.000Z",
      methods: {
        crypto: {
          chainId: 8453, address: `0x${"11".repeat(20)}`, amountUsdc: 146.8, rate: 1.138, allowanceBps: 50,
          validUntil: "2026-10-11T09:10:00.000Z", uri: "ethereum:0x11@8453",
          token: { symbol: "USDC", chainName: "Base", decimals: 6, address: `0x${"22".repeat(20)}` },
        },
      },
      payments: [{ method: "crypto", amountUsdc: 146.8, at: "2026-10-11T10:00:00.000Z" }],
      pageUrl: row(o)!.pageUrl,
      orderName: o.name,
    });
    // Built field by field: what Zold adds there does not pass through.
    const text = JSON.stringify(r.body);
    for (const absent of ["somethingNew", "qrUrl", "displayName", "DE89370400440532013000", "bank", "payerAddress", "ab".repeat(32), "code", "returnUrl"]) {
      assert.equal(text.includes(absent), false, absent);
    }
    assert.equal((await lookup(SHOP, o.admin_graphql_api_id, o.checkout_token)).status, 200, "the gid form");
  });

  it("is the same 404 `pending` with a wrong or missing token, for an order that does not exist, and under another shop", async () => {
    const unknown = await lookup(SHOP, 999, o.checkout_token);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.pending, true);
    for (const r of [
      await lookup(SHOP, o.id),
      await lookup(SHOP, o.id, ""),
      await lookup(SHOP, o.id, "0".repeat(32)),
      await lookup(SHOP, o.id, order().checkout_token),
      await lookup(SHOP_B, o.id, o.checkout_token),
      await lookup("not-a-shop", o.id, o.checkout_token),
      await lookup(SHOP, "abc", o.checkout_token),
    ]) {
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, unknown.body);
    }
  });

  it("an order opened without a checkout token cannot be read at all", async () => {
    const x = order({ checkout_token: undefined });
    await webhook("orders/create", x);
    assert.ok(row(x));
    assert.equal((await lookup(SHOP, x.id, "")).status, 404);
    assert.equal((await lookup(SHOP, x.id, "undefined")).status, 404);
  });

  it("Zold's public route failing is a 502 to the buyer; Zold not knowing it is the 404 `pending`", async () => {
    stub.fail.publicRead.push({ status: 500 });
    assert.equal((await lookup(SHOP, o.id, o.checkout_token)).status, 502);
    stub.fail.publicRead.push({ status: 404 });
    const r = await lookup(SHOP, o.id, o.checkout_token);
    assert.equal(r.status, 404);
    assert.equal(r.body.pending, true);
  });

  const proof = (key: string, id: string | number) => createHmac("sha256", key).update(String(id)).digest("hex");
  const key = () => stub.links.get("link-a")!.secret;

  it("the email link redirects to the order's pay page only with the order id signed by the store's key", async () => {
    const r = await call(`/shopify/orders/${SHOP}/${o.id}/pay?b=${proof(key(), o.id)}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, row(o)!.pageUrl);
    const upper = await call(`/shopify/orders/${SHOP}/${o.id}/pay?b=${proof(key(), o.id).toUpperCase()}`);
    assert.equal(upper.status, 302);
  });

  it("the pay-link template as Zold prints it, rendered as Liquid would, opens that order (and only it)", async () => {
    const template = `${ORIGIN}/shopify/orders/${SHOP}/{{ id }}/pay?b={{ id | hmac_sha256: "${key()}" }}`;
    const render = (id: number) =>
      template.replace(/\{\{ id \| hmac_sha256: "([^"]*)" \}\}/g, (_m, k) => proof(k, id)).replace(/\{\{ id \}\}/g, String(id));
    const u = new URL(render(o.id));
    assert.equal((await call(`${u.pathname}${u.search}`)).status, 302);
    const other = new URL(render(o.id + 1));
    assert.equal((await call(`${other.pathname}?b=${u.searchParams.get("b")}`)).status, 403);
  });

  it("without a valid signature it is the same 403 whether the order exists or not, and names nothing", async () => {
    const refusals = [
      await call(`/shopify/orders/${SHOP}/${o.id}/pay`),
      await call(`/shopify/orders/${SHOP}/${o.id}/pay?b=${proof(key(), o.id + 1)}`),
      await call(`/shopify/orders/${SHOP}/${o.id}/pay?b=${proof("not-the-key", o.id)}`),
      await call(`/shopify/orders/${SHOP}/${o.id}/pay?b=zz`),
      await call(`/shopify/orders/${SHOP}/999/pay`),
      await call(`/shopify/orders/unconnected.myshopify.com/${o.id}/pay?b=${proof(key(), o.id)}`),
      await call(`/shopify/orders/not-a-shop/${o.id}/pay?b=${proof(key(), o.id)}`),
      await call(`/shopify/orders/${SHOP_B}/${o.id}/pay?b=${proof(key(), o.id)}`),
    ];
    for (const r of refusals) {
      assert.equal(r.status, 403);
      assert.equal(r.body.text, refusals[0].body.text);
      assert.equal(r.location, "");
      assert.equal(r.body.text.includes(row(o)!.code), false);
    }
  });

  it("a correctly signed link for an order whose webhook has not arrived says to try again", async () => {
    const r = await call(`/shopify/orders/${SHOP}/999/pay?b=${proof(key(), 999)}`);
    assert.equal(r.status, 404);
    assert.match(r.body.text, /not ready yet/);
  });
});

describe("settlement", () => {
  const settle = () => svc.settler.tick(clock);

  it("PAID at Zold: the order is marked paid exactly once and the facts land on zold.payment", async () => {
    const o = order();
    await webhook("orders/create", o);
    const id = row(o)!.paymentRequestId;
    await settle();
    assert.equal(marks(o.admin_graphql_api_id).length, 0, "an open request was marked paid");
    stub.setState(id, "PAID", true);
    assert.equal(svc.settler.nudge("link-a", id), true);
    await settle();
    assert.equal(marks(o.admin_graphql_api_id).length, 1);
    assert.ok(row(o)!.markedPaidAt);
    assert.equal(row(o)!.state, "PAID");
    const mf = stub.shopifyCalls.find((c) => c.op === "metafieldsSet" && c.vars.metafields[0].ownerId === o.admin_graphql_api_id)!.vars.metafields[0];
    assert.deepEqual({ ns: mf.namespace, key: mf.key, type: mf.type }, { ns: "zold", key: "payment", type: "json" });
    const facts = JSON.parse(mf.value);
    assert.equal(facts.amountEur, 129);
    assert.equal(facts.code, row(o)!.code);
    assert.ok(facts.payments[0].txHash.startsWith("0x"));
    assert.equal(row(o)!.checkoutTokenHash, undefined, "the buyer's proof outlived the order");
    assert.equal((await call(`/shopify/orders/${SHOP}/${o.id}?t=${o.checkout_token}`)).status, 404);
    later(7_200_000);
    await settle();
    assert.equal(marks(o.admin_graphql_api_id).length, 1, "marked twice");
    assert.equal(svc.settler.nudge("link-a", id), false);
  });

  it("an order the merchant already marked paid by hand counts as marked, and still gets the metafield", async () => {
    const o = order();
    await webhook("orders/create", o);
    stub.setState(row(o)!.paymentRequestId, "PAID", true);
    stub.fail.markPaid.push("alreadyPaid");
    later(7_200_000);
    await settle();
    assert.ok(row(o)!.markedPaidAt);
    assert.equal(row(o)!.lastError, undefined);
    assert.ok(logs.some((l) => l.includes("already marked paid in Shopify")));
    assert.ok(stub.shopifyCalls.some((c) => c.op === "metafieldsSet" && c.vars.metafields[0].ownerId === o.admin_graphql_api_id));
  });

  it("a userError on an order that is not paid in Shopify stays a failure", async () => {
    const o = order();
    await webhook("orders/create", o);
    stub.setState(row(o)!.paymentRequestId, "PAID", true);
    stub.fail.markPaid.push("userError");
    later(7_200_000);
    await settle();
    assert.equal(row(o)!.markedPaidAt, undefined);
    assert.ok(stub.shopifyCalls.some((c) => c.op === "order" && c.vars.id === o.admin_graphql_api_id), "the order's status was not read");
  });

  it("refuses to mark an order paid when Zold's request is for another amount", async () => {
    const o = order();
    await webhook("orders/create", o);
    const id = row(o)!.paymentRequestId;
    stub.setState(id, "PAID", true);
    stub.requests.set(id, { ...stub.requests.get(id)!, amountEur: 1.29 });
    later(7_200_000);
    await settle();
    later(7_200_000);
    await settle();
    assert.equal(row(o)!.markedPaidAt, undefined);
    assert.equal(marks(o.admin_graphql_api_id).length, 0);
    assert.equal(logs.filter((l) => l.startsWith("SHOPIFY_AMOUNT_MISMATCH")).length, 1);
  });

  it("a refused metafield does not undo the mark", async () => {
    const o = order();
    await webhook("orders/create", o);
    stub.setState(row(o)!.paymentRequestId, "PAID", true);
    stub.fail.metafield.push("userError");
    later(7_200_000);
    await settle();
    assert.ok(row(o)!.markedPaidAt);
    assert.ok(logs.some((l) => l.startsWith("SHOPIFY_METAFIELD_FAILED")));
  });

  it("a refused mark is recorded, logged, and retried with backoff until it is accepted", async () => {
    const o = order();
    await webhook("orders/create", o);
    stub.setState(row(o)!.paymentRequestId, "PAID", true);
    stub.fail.markPaid.push("userError", "http500");
    later(7_200_000);
    await settle();
    let r = row(o)!;
    assert.equal(r.markedPaidAt, undefined);
    assert.equal(r.markPaidAttempts, 1);
    assert.match(r.lastError!, /cannot be marked as paid/);
    assert.equal(Date.parse(r.nextAttemptAt!), clock + 30_000);
    assert.ok(logs.some((l) => l.startsWith("SHOPIFY_MARK_FAILED")));
    await settle();
    assert.equal(marks(o.admin_graphql_api_id).length, 1, "retried before its time");
    later(30_000);
    await settle();
    r = row(o)!;
    assert.equal(r.markPaidAttempts, 2);
    assert.equal(Date.parse(r.nextAttemptAt!), clock + 60_000, "the wait did not double");
    later(60_000);
    await settle();
    r = row(o)!;
    assert.ok(r.markedPaidAt);
    assert.equal(r.lastError, undefined);
    assert.equal(r.nextAttemptAt, undefined);
    assert.equal(marks(o.admin_graphql_api_id).length, 3);
  });

  it("an open request is read again only after its backoff", async () => {
    const o = order();
    await webhook("orders/create", o);
    const reads = () => stub.coreCalls.filter((c) => c.method === "GET" && c.path.endsWith(`/payment-requests/${row(o)!.paymentRequestId}`)).length;
    later(7_200_000);
    await settle();
    const first = reads();
    assert.ok(first >= 1);
    await settle();
    assert.equal(reads(), first);
    later(30_000);
    await settle();
    assert.equal(reads(), first + 1);
  });

  it("CANCELLED or EXPIRED at Zold closes the order without marking it", async () => {
    const o = order();
    await webhook("orders/create", o);
    stub.setState(row(o)!.paymentRequestId, "EXPIRED");
    later(7_200_000);
    await settle();
    assert.equal(row(o)!.state, "EXPIRED");
    assert.equal(row(o)!.checkoutTokenHash, undefined, "the buyer's proof outlived the order");
    assert.equal(marks(o.admin_graphql_api_id).length, 0);
    assert.equal(store.shopifyOrdersAwaitingSettlement().some((x) => x.orderGid === o.admin_graphql_api_id), false);
  });

  it("a 5xx from Zold is not a refusal: the order stays open and is read again", async () => {
    const o = order();
    await webhook("orders/create", o);
    later(7_200_000);
    stub.fail.read.push(...Array(60).fill({ status: 500 }));
    await settle();
    stub.fail.read.length = 0;
    assert.equal(row(o)!.state, "OPEN");
    stub.setState(row(o)!.paymentRequestId, "PAID", true);
    later(7_200_000);
    await settle();
    assert.ok(row(o)!.markedPaidAt);
  });

  for (const status of [503, 401, 429]) {
    it(`a ${status} from Zold stalls the loop (logged), and the next tick recovers`, async () => {
      const o = order();
      await webhook("orders/create", o);
      stub.setState(row(o)!.paymentRequestId, "PAID", true);
      later(7_200_000);
      stub.fail.read.push({ status, body: { error: "x", code: "X" } });
      const r = await settle();
      assert.equal(r.stopped, true);
      assert.ok(logs.some((l) => l.startsWith("SHOPIFY_SETTLE_STALLED") && l.includes(`HTTP ${status}`)), logs.join("\n"));
      assert.equal(row(o)!.markedPaidAt, undefined);
      await settle();
      assert.ok(row(o)!.markedPaidAt);
      assert.ok(logs.some((l) => l.startsWith("SHOPIFY_SETTLE_RECOVERED")));
    });
  }

  it("an answer about another request is logged once and changes nothing", async () => {
    const o = order();
    await webhook("orders/create", o);
    const id = row(o)!.paymentRequestId;
    stub.setState(id, "PAID", true);
    const real = stub.requests.get(id)!;
    stub.requests.set(id, { ...real, order: { gid: "gid://shopify/Order/1" } });
    later(7_200_000);
    await settle();
    later(7_200_000);
    await settle();
    stub.requests.set(id, real);
    assert.equal(row(o)!.markedPaidAt, undefined);
    assert.equal(logs.filter((l) => l.startsWith("SHOPIFY_SETTLE_MISMATCH")).length, 1);
  });

  it("an uninstall closes the store's orders: out of settlement, buyer proofs and the access token dropped", async () => {
    const U = "uninstalled.myshopify.com";
    await connect(U, "link-u");
    const o = order();
    await webhook("orders/create", o, { shop: U });
    stub.setState(row(o, U)!.paymentRequestId, "PAID", true);
    assert.equal((await webhook("app/uninstalled", { id: 1 }, { shop: U })).status, 200);
    const c = store.findShopifyConnectionByShop(U)!;
    assert.equal(c.accessTokenEnc, undefined, "the revoked token is still kept");
    assert.deepEqual(c.webhookSubscriptionIds, []);
    assert.equal(row(o, U)!.checkoutTokenHash, undefined);
    assert.equal(store.shopifyOrdersAwaitingSettlement().some((x) => x.shop === U), false);
    later(7_200_000);
    await settle();
    assert.equal(row(o, U)!.markedPaidAt, undefined);
    assert.equal(marks(o.admin_graphql_api_id).length, 0);
    // Nothing for a disabled store needs its token: a revoked-link hint does not try.
    stub.links.get("link-u")!.active = false;
    await svc.onLinkHint("link-u");
  });
});

describe("disabling a connection", () => {
  it("app/uninstalled disables the connection and later orders open nothing", async () => {
    await connect("leaving.myshopify.com", "link-l");
    const r = await webhook("app/uninstalled", { id: 1 }, { shop: "leaving.myshopify.com" });
    assert.equal(r.status, 200);
    const c = store.findShopifyConnectionByShop("leaving.myshopify.com")!;
    assert.equal(c.disabledReason, "app_uninstalled");
    const before = opens().length;
    const o = order();
    assert.equal((await webhook("orders/create", o, { shop: "leaving.myshopify.com" })).body.ignored, "connection disabled");
    assert.equal(opens().length, before);
  });

  it("an app/uninstalled triggered before the current install is ignored", async () => {
    await connect("reinstalled.myshopify.com", "link-ri");
    const installedAt = store.findShopifyConnectionByShop("reinstalled.myshopify.com")!.installedAt;
    const stale = new Date(Date.parse(installedAt) - 60_000).toISOString();
    const r = await webhook("app/uninstalled", { id: 1 }, { shop: "reinstalled.myshopify.com", headers: { "x-shopify-triggered-at": stale } });
    assert.equal(r.body.ignored, "uninstall before this install");
    assert.equal(store.findShopifyConnectionByShop("reinstalled.myshopify.com")!.disabledAt, undefined);
    const fresh = new Date(Date.parse(installedAt) + 60_000).toISOString();
    await webhook("app/uninstalled", { id: 1 }, { shop: "reinstalled.myshopify.com", headers: { "x-shopify-triggered-at": fresh } });
    assert.equal(store.findShopifyConnectionByShop("reinstalled.myshopify.com")!.disabledReason, "app_uninstalled");
  });

  it("LINK_REVOKED from Zold disables the connection and removes its webhook subscriptions", async () => {
    await connect("revoked.myshopify.com", "link-r");
    stub.links.get("link-r")!.active = false;
    const r = await webhook("orders/create", order(), { shop: "revoked.myshopify.com" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, "link revoked");
    const c = store.findShopifyConnectionByShop("revoked.myshopify.com")!;
    assert.equal(c.disabledReason, "link_revoked");
    assert.deepEqual(c.webhookSubscriptionIds, []);
    assert.equal(stub.shopifyCalls.filter((x) => x.op === "webhookSubscriptionDelete" && x.shop === "revoked.myshopify.com").length, 3);
    assert.ok(logs.some((l) => l.startsWith("SHOPIFY_DISABLED revoked.myshopify.com: link_revoked")));
  });

  it("an order opened under a revoked link keeps its row and original link, and still settles, after the store is linked again", async () => {
    const SHOP_R = "relinked.myshopify.com";
    await connect(SHOP_R, "link-old");
    const o = order();
    await webhook("orders/create", o, { shop: SHOP_R });
    const first = row(o, SHOP_R)!;
    assert.equal(first.linkId, "link-old");
    stub.links.get("link-old")!.active = false;
    await svc.onLinkHint("link-old");
    await connect(SHOP_R, "link-new");
    assert.equal(store.findShopifyConnectionByShop(SHOP_R)!.linkId, "link-new");
    // Shopify's retry of orders/create, under a new delivery id.
    const before = opens().length;
    const again = await webhook("orders/create", o, { shop: SHOP_R });
    assert.equal(again.status, 200);
    assert.equal(again.body.existing, true);
    assert.equal(opens().length, before);
    const rows = () => store.findShopifyOrder(SHOP_R, o.admin_graphql_api_id);
    assert.deepEqual(rows(), first);
    stub.setState(first.paymentRequestId, "PAID", true);
    later(7_200_000);
    await svc.settler.tick(clock);
    const settled = rows()!;
    assert.equal(settled.linkId, "link-old");
    assert.ok(settled.markedPaidAt, "the order of the old link was not settled");
    assert.ok(stub.coreCalls.some((c) => c.path === `/api/service/merchant/links/link-old/payment-requests/${first.paymentRequestId}`));
  });

  it("a reconnect through a new link enables the connection again", async () => {
    await connect("revoked.myshopify.com", "link-r2");
    const c = store.findShopifyConnectionByShop("revoked.myshopify.com")!;
    assert.equal(c.disabledAt, undefined);
    assert.equal(c.linkId, "link-r2");
    assert.equal((await webhook("orders/create", order(), { shop: "revoked.myshopify.com" })).body.opened, true);
  });

  it("Zold's {linkId} hint disables a revoked link's store and leaves an active one alone", async () => {
    await connect("hinted.myshopify.com", "link-h");
    await svc.onLinkHint("link-h");
    assert.equal(store.findShopifyConnectionByShop("hinted.myshopify.com")!.disabledAt, undefined);
    stub.fail.linkRead.push({ status: 500 });
    stub.links.get("link-h")!.active = false;
    await svc.onLinkHint("link-h");
    assert.equal(store.findShopifyConnectionByShop("hinted.myshopify.com")!.disabledAt, undefined, "a failed read disabled it");
    assert.ok(logs.some((l) => l.startsWith("SHOPIFY_LINK_READ_FAILED") && l.includes("HTTP 500")));
    await svc.onLinkHint("link-h");
    assert.equal(store.findShopifyConnectionByShop("hinted.myshopify.com")!.disabledReason, "link_revoked");
    await svc.onLinkHint("link-unknown");
  });
});

describe("secrets", () => {
  it("no access token, link secret, link code, checkout token or service token in any answer or log line", () => {
    const text = answered.join("\n") + allLogs.join("\n");
    const secrets = [ACCESS_TOKEN, SERVICE_TOKEN, ...[...stub.links.values()].map((l) => l.secret)];
    for (const s of secrets) assert.equal(text.includes(s), false, "a secret left the service");
    assert.equal(/zlc_[A-Za-z0-9_-]{43}/.test(answered.filter((a) => !a.includes("/admin/oauth/authorize")).join("\n")), false);
    assert.equal(/zlc_/.test(allLogs.join("\n")), false);
    assert.ok(allLogs.length > 10, "the log check saw nothing");
  });
});
