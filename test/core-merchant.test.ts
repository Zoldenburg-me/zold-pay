import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";

const cm = await import("../server/src/core-merchant.js");
const { CoreResponseError } = await import("../server/src/checkout.js");
const h = await import("../server/src/shopify-hmac.js");

const coreErr = (status: number, body?: unknown) => Object.assign(new Error(`core API returned ${status}`), { status, body });
const view = (over: Record<string, unknown> = {}) => ({
  id: "pr1", code: "ABCDE-FGHIJ-KLMNO", handle: "keycard", state: "OPEN", amountEur: 12.5, currency: "EUR",
  createdAt: "2026-10-11T09:00:00.000Z", order: { gid: "gid://shopify/Order/1", name: "#1" }, shop: "a.myshopify.com",
  payments: [], pageUrl: "https://zold.example/pay/keycard/ABCDE-FGHIJ-KLMNO", publicPath: "/api/pay/keycard/ABCDE-FGHIJ-KLMNO",
  ...over,
});
const strict = { corePublicUrl: "https://zold.example" };

describe("refusal or outage", () => {
  it("only a 400, 403, 404 or 409 carrying a code is a refusal", () => {
    for (const s of [400, 403, 404, 409]) assert.equal(cm.isCoreRefusal(coreErr(s, { code: "X_Y" })), true, String(s));
    for (const e of [coreErr(404), coreErr(409, { code: "not a code" }), coreErr(401, { code: "X" }), coreErr(429, { code: "X" }), coreErr(503, { code: "X" }), coreErr(500, { code: "X" }), new Error("x")]) {
      assert.equal(cm.isCoreRefusal(e), false);
    }
  });

  it("401, 429, 503, a timeout and an unreachable Zold are outages; a 500 and our own errors are not", () => {
    for (const e of [coreErr(401), coreErr(429), coreErr(503), Object.assign(new Error("t"), { name: "TimeoutError" }), new TypeError("fetch failed")]) {
      assert.equal(cm.isCoreOutage(e), true);
    }
    for (const e of [coreErr(500), new TypeError("x is not a function"), "string", undefined]) assert.equal(cm.isCoreOutage(e), false);
  });

  it("describes a failure without Zold's own text", () => {
    assert.equal(cm.describeCoreFailure(coreErr(409, { error: "secret detail", code: "ORDER_TAKEN" })), "HTTP 409 ORDER_TAKEN");
    assert.equal(cm.describeCoreFailure(coreErr(500, { error: "secret detail" })), "HTTP 500");
    assert.match(cm.describeCoreFailure(new CoreResponseError("unexpected response from the Zold API (x)")), /unexpected/);
    assert.equal(cm.describeCoreFailure(Object.assign(new Error("t"), { name: "AbortError" })), "Zold API timed out");
    assert.equal(cm.describeCoreFailure(new TypeError("fetch failed")), "Zold API unreachable");
    assert.match(cm.describeCoreFailure(new Error("disk full")), /local error: disk full/);
    assert.match(cm.describeCoreFailure("odd"), /local error/);
  });
});

describe("parsing Zold's answers", () => {
  it("keeps the service view's fields and drops anything malformed inside payments", () => {
    const v = cm.parseServiceView(view({ test: true, paidAt: "2026-10-11T10:00:00.000Z", extra: "x", payments: [
      { method: "crypto", amountEur: 12.5, amountUsdc: 14.2, txHash: "0xab", at: "2026-10-11T10:00:00.000Z" },
      { method: 7, amountEur: "12", txHash: "not-a-hash" },
    ] }), strict);
    assert.equal((v as any).extra, undefined);
    assert.equal(v.test, true);
    assert.deepEqual(v.payments, [{ method: "crypto", amountEur: 12.5, amountUsdc: 14.2, txHash: "0xab", at: "2026-10-11T10:00:00.000Z" }, { method: "unknown" }]);
  });

  for (const [name, over] of [
    ["no id", { id: "../x" }], ["no code", { code: 5 }], ["no handle", { handle: "" }], ["a lower-case state", { state: "paid" }],
    ["no amount", { amountEur: "12" }], ["no order", { order: { gid: "gid://shopify/Product/1" } }], ["a shop that is not myshopify", { shop: "evil.com" }],
    ["no payments", { payments: {} }], ["a public path elsewhere", { publicPath: "/api/admin/x" }], ["an http page URL", { pageUrl: "http://zold.example/pay" }],
    ["a page URL with credentials", { pageUrl: "https://u:p@zold.example/pay" }], ["a page URL that is not one", { pageUrl: "nope" }],
    ["a page URL on another origin", { pageUrl: "https://evil.example/pay/keycard/ABCDE-FGHIJ-KLMNO" }],
    ["a page URL on another port", { pageUrl: "https://zold.example:8443/pay/keycard/ABCDE-FGHIJ-KLMNO" }],
    ["a page URL on a lookalike host", { pageUrl: "https://zold.example.evil.example/pay/keycard/ABCDE" }],
    ["a page URL outside /pay/", { pageUrl: "https://zold.example/admin/keycard" }],
    ["a page URL with an encoded segment", { pageUrl: "https://zold.example/pay/%2e%2e/admin" }],
    ["a handle of dots", { handle: ".." }], ["a handle with %", { handle: "a%2Fb" }],
    ["a public path through dots", { publicPath: "/api/pay/../ABCDE-FGHIJ" }],
    ["a public path with a single dot", { publicPath: "/api/pay/./ABCDE-FGHIJ" }],
    ["a public path with %", { publicPath: "/api/pay/a%2Fb/ABCDE-FGHIJ" }],
  ] as const) {
    it(`refuses a view with ${name}`, () => {
      assert.throws(() => cm.parseServiceView(view(over), strict), CoreResponseError);
    });
  }

  it("binds the page URL to Zold's public origin, whatever that is", () => {
    const local = view({ pageUrl: "http://localhost:3000/pay/k/ABCDE" });
    assert.throws(() => cm.parseServiceView(local, strict), CoreResponseError);
    assert.doesNotThrow(() => cm.parseServiceView(local, { corePublicUrl: "http://localhost:3000" }));
    assert.equal(cm.pageUrlOnCore("http://zold.example/pay/k/ABCDE", "https://zold.example"), false, "http is another origin");
    assert.equal(cm.pageUrlOnCore("https://zold.example/pay/k/ABCDE", "not a url"), false);
    assert.equal(cm.pageUrlOnCore(42, "https://zold.example"), false);
  });

  it("reads a link preview for the shop asked about, with the payee's display name when there is one", () => {
    const good = { shop: "a.myshopify.com", orgName: "Org", payeeHandle: "h", payeeDisplayName: "H GmbH", expiresAt: "2026-10-11T09:15:00.000Z", extra: 1 };
    assert.deepEqual(cm.parseLinkPreview(good, "a.myshopify.com"), {
      shop: "a.myshopify.com", orgName: "Org", payeeHandle: "h", payeeDisplayName: "H GmbH", expiresAt: "2026-10-11T09:15:00.000Z",
    });
    assert.deepEqual(cm.parseLinkPreview({ ...good, payeeDisplayName: "", expiresAt: 5 }, "a.myshopify.com"), { shop: "a.myshopify.com", orgName: "Org", payeeHandle: "h" });
    for (const bad of [{ ...good, shop: "b.myshopify.com" }, { ...good, orgName: "" }, { ...good, payeeHandle: 7 }, null]) {
      assert.throws(() => cm.parseLinkPreview(bad, "a.myshopify.com"), CoreResponseError);
    }
  });

  it("refuses a link exchange for another shop or without a proper secret", () => {
    const good = { linkId: "l1", shop: "a.myshopify.com", orgName: "Org", payeeHandle: "h", linkSecret: "a".repeat(64) };
    assert.equal(cm.parseLinkExchange(good, "a.myshopify.com").linkId, "l1");
    for (const bad of [{ ...good, shop: "b.myshopify.com" }, { ...good, linkSecret: "A".repeat(64) }, { ...good, linkId: "" }, { ...good, orgName: "" }, null, []]) {
      assert.throws(() => cm.parseLinkExchange(bad, "a.myshopify.com"), CoreResponseError);
    }
  });

  it("refuses a link view for another link or without its flag", () => {
    assert.deepEqual(cm.parseLinkView({ linkId: "l1", shop: "a.myshopify.com", active: true }, "l1"), { linkId: "l1", shop: "a.myshopify.com", active: true });
    for (const bad of [{ linkId: "l2", shop: "a.myshopify.com", active: true }, { linkId: "l1", shop: "x", active: true }, { linkId: "l1", shop: "a.myshopify.com", active: "yes" }]) {
      assert.throws(() => cm.parseLinkView(bad, "l1"), CoreResponseError);
    }
  });

  it("will not read a public path that is not Zold's pay projection", async () => {
    const core = cm.createMerchantCore({ token: "t", corePublicUrl: "https://zold.example" });
    for (const p of ["/api/admin/users", "/api/pay/../ABCDE-FGHIJ", "/api/pay/a%2F/ABCDE-FGHIJ"]) {
      await assert.rejects(core.readPublic(p), CoreResponseError, p);
    }
  });
});

describe("Shopify helpers", () => {
  it("normalises and checks shop domains", () => {
    assert.equal(h.normaliseShop("  Shop.MyShopify.com "), "shop.myshopify.com");
    assert.equal(h.normaliseShop(undefined), "");
    assert.equal(h.isValidShopDomain("shop.myshopify.com"), true);
    for (const bad of ["shop.myshopify.com.evil.com", "-x.myshopify.com", "x.myshopify.com/", 42, `${"a".repeat(250)}.myshopify.com`]) {
      assert.equal(h.isValidShopDomain(bad), false, String(bad));
    }
  });

  it("cleans an order name of control characters, and drops one that is empty or too long", () => {
    assert.equal(h.cleanOrderName("#1001"), "#1001");
    assert.equal(h.cleanOrderName(" #10\r\n01\u0007\u009b\u2029 "), "#1001");
    for (const bad of ["", "\n\t", "#".repeat(41), 1001, undefined]) assert.equal(h.cleanOrderName(bad), undefined);
  });

  it("reads an order id in either form and nothing else", () => {
    assert.equal(h.orderGidOf("123"), "gid://shopify/Order/123");
    assert.equal(h.orderGidOf("gid://shopify/Order/123"), "gid://shopify/Order/123");
    for (const bad of ["gid://shopify/Product/1", "12a", "", undefined, "1".repeat(21)]) assert.equal(h.orderGidOf(bad), undefined);
  });

  it("verifies the OAuth query HMAC, including Shopify's escaping and array values", () => {
    const q = { shop: "a.myshopify.com", code: "c&d%e", "we=ird": "x", ids: ["1", "2"] };
    const signed = { ...q, hmac: h.signQuery(q, "s") };
    assert.equal(h.verifyQueryHmac(signed, "s"), true);
    assert.equal(h.verifyQueryHmac(signed, "other"), false);
    assert.equal(h.verifyQueryHmac(q, "s"), false);
    assert.equal(h.verifyQueryHmac(signed, ""), false);
  });

  it("verifies a body HMAC only with all three inputs", () => {
    const raw = Buffer.from("{}");
    assert.equal(h.verifyBodyHmac(raw, h.signBody(raw, "s"), "s"), true);
    assert.equal(h.verifyBodyHmac(undefined, "x", "s"), false);
    assert.equal(h.verifyBodyHmac(raw, undefined, "s"), false);
    assert.equal(h.verifyBodyHmac(raw, h.signBody(raw, "s"), ""), false);
  });

  it("compares hex in constant time and refuses anything that is not hex", () => {
    assert.equal(h.sameHex("ab", "ab"), true);
    assert.equal(h.sameHex("ab", "abc"), false);
    assert.equal(h.sameHex("zz", "zz"), false);
  });
});
