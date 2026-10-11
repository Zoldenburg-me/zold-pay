import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { SERVICE_TOKEN, startStub } from "./shopify-stub.js";

// The real server with Shopify on: the webhook must be mounted before the JSON
// parser (its HMAC is over the raw body), Zold's two new hint bodies must reach
// the adapter, and /bff/health must say nothing about Shopify.
const stub = await startStub();
const WHKEY = randomBytes(32);
process.env.CHECKOUT_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "pay-shopify-wiring-")), "checkout.json");
process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";
process.env.CHECKOUT_PUBLIC_ORIGIN = "http://localhost:3100";
process.env.CORE_API_URL = stub.base;
process.env.ZOLD_SERVICE_TOKEN = SERVICE_TOKEN;
process.env.ZOLD_WEBHOOK_SECRET = `whsec_${WHKEY.toString("base64")}`;
process.env.SHOPIFY_API_KEY = "app-key";
process.env.SHOPIFY_API_SECRET = "app-secret";
process.env.SHOPIFY_TOKEN_KEY = randomBytes(32).toString("base64");
process.env.SHOPIFY_SHOP_BASE_URL = stub.base;
process.env.CORE_PUBLIC_URL = "https://zold.example";
process.env.RATE_LIMIT_GENERAL = "1000";
process.env.RATE_LIMIT_CREDENTIAL = "1000";

const { app } = await import("../server/src/server.js");
const { store } = await import("../server/src/store.js");
const { signBody, signQuery } = await import("../server/src/shopify-hmac.js");

const SHOP = "wired.myshopify.com";
let base = "";
let server: ReturnType<typeof app.listen>;
before(async () => {
  await new Promise<void>((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  try {
    server?.close();
  } finally {
    stub.close();
  }
});

const until = async (fn: () => boolean, ms = 5_000) => {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return fn();
};

const zoldHint = (body: unknown) => {
  const raw = JSON.stringify(body);
  const id = `msg_${randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v1,${createHmac("sha256", WHKEY).update(`${id}.${ts}.${raw}`).digest("base64")}`;
  return fetch(`${base}/bff/zold/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig },
    body: raw,
  });
};

describe("Shopify wiring", () => {
  it("/bff/health and /bff/config say nothing about Shopify", async () => {
    for (const p of ["/bff/health", "/bff/config"]) {
      const text = await (await fetch(`${base}${p}`)).text();
      assert.equal(/shopify|app-key|app-secret|myshopify/i.test(text), false, `${p}: ${text}`);
    }
    const health = (await (await fetch(`${base}/bff/health`)).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(health).sort(), ["core", "ok"]);
  });

  it("connects a store, opens an order through the raw-body webhook, and settles it on Zold's hint", async () => {
    const link = stub.mintLinkCode(SHOP, "link-w");
    const install = await fetch(`${base}/shopify/install?${new URLSearchParams({ shop: SHOP, link })}`, { redirect: "manual" });
    assert.equal(install.status, 302);
    const cookie = (install.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^__Host-zold-shopify-install=/);
    const state = new URL(install.headers.get("location")!).searchParams.get("state")!;
    const q: Record<string, string> = { code: "good-code", shop: SHOP, state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const cb = await fetch(`${base}/shopify/callback?${new URLSearchParams({ ...q, hmac: signQuery(q, "app-secret") })}`, { redirect: "manual", headers: { cookie } });
    assert.equal(cb.status, 200);
    const pending = /name="pending" value="([^"]+)"/.exec(await cb.text())![1];
    const form = { method: "POST", redirect: "manual" as const, body: new URLSearchParams({ pending, action: "link" }).toString() };
    // A form posted from another site is refused before it is read.
    const foreign = await fetch(`${base}/shopify/confirm`, {
      ...form, headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);
    const confirmed = await fetch(`${base}/shopify/confirm`, {
      ...form, headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:3100" },
    });
    assert.equal(confirmed.headers.get("location"), `https://zold.example/business?view=shopify&shop=${SHOP}`);
    assert.ok(store.findShopifyConnectionByShop(SHOP));

    const o = {
      id: 77, admin_graphql_api_id: "gid://shopify/Order/77", name: "#77", currency: "EUR", total_price: "40.00",
      financial_status: "pending", payment_gateway_names: ["Zold"], checkout_token: "tok",
    };
    // Whitespace a JSON parser would drop: the HMAC is over these exact bytes.
    const raw = JSON.stringify(o, null, 1);
    const r = await fetch(`${base}/shopify/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-hmac-sha256": signBody(raw, "app-secret"), "x-shopify-shop-domain": SHOP, "x-shopify-topic": "orders/create", "x-shopify-webhook-id": randomUUID() },
      body: raw,
    });
    assert.equal(r.status, 200, await r.text());
    const row = store.findShopifyOrder(SHOP, o.admin_graphql_api_id)!;
    assert.ok(row);

    stub.setState(row.paymentRequestId, "PAID", true);
    assert.equal((await zoldHint({ paymentRequestId: row.paymentRequestId, linkId: "link-w" })).status, 204);
    assert.ok(await until(() => Boolean(store.findShopifyOrder(SHOP, o.admin_graphql_api_id)?.markedPaidAt)), "not marked paid");
    assert.equal(stub.shopifyCalls.filter((c) => c.op === "orderMarkAsPaid").length, 1);
  });

  it("Zold's {linkId} hint for a revoked link disables the store", async () => {
    stub.links.get("link-w")!.active = false;
    assert.equal((await zoldHint({ linkId: "link-w" })).status, 204);
    assert.ok(await until(() => store.findShopifyConnectionByShop(SHOP)?.disabledReason === "link_revoked"));
  });

  it("the transfer hint still works next to them", async () => {
    assert.equal((await zoldHint({ transferId: "t-unknown" })).status, 204);
  });
});
