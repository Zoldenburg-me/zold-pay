import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/**
 * Runs the checkout page's real inline script against stubbed browser APIs, to
 * test the one thing that costs a user money when it is wrong: what the page
 * does after the payment has been authorized but the merchant has not been told.
 * The WebAuthn ceremonies themselves still need a real browser (BROWSER-CHECKLIST.md).
 */
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const html = readFileSync(path.join(WEB, "checkout.html"), "utf8");
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*importmap)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

type Reply = [number, unknown];
type Call = { method: string; path: string; body: any };
type Router = (method: string, path: string, body: any, calls: Call[]) => Reply;

interface Fake {
  classes: Set<string>;
  textContent: string;
  innerHTML: string;
  dataset: Record<string, string>;
  disabled: boolean;
  onclick?: () => Promise<void>;
  href?: string;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean };
}
const makeEl = (): Fake => {
  const classes = new Set<string>();
  return {
    classes, textContent: "", innerHTML: "", dataset: {}, disabled: false,
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      toggle: (c, on) => void ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
  };
};

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

const USER = {
  id: "u1", sessionToken: "session-1", kycStatus: "approved", passkeySafe: { status: "active" },
  authorizerAddress: "0xabc", passkey: { credentialId: "cred-1" }, safeBalanceEur: 100,
};
const INTENT = {
  intentId: "I1", status: "PENDING", amountEur: 25, merchant: "Shop", merchantIban: "DE89370400440532013000",
  reference: "order-1", transferReference: "order-1 ZP0123456789AB", expired: false,
};

function boot(opts: { route: Router; session?: boolean; stored?: Record<string, string> }) {
  const els: Record<string, Fake> = {};
  const calls: Call[] = [];
  const storage = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      has: (k: string) => m.has(k),
    };
  };
  const session = storage({ ...(opts.session ? { "zold-checkout-session": "session-1" } : {}), ...(opts.stored ?? {}) });
  const redirects: string[] = [];
  const window: any = { PublicKeyCredential: function () {} };
  const buf = new Uint8Array([1, 2, 3]).buffer;

  const ctx = vm.createContext({
    document: { getElementById: (id: string) => (els[id] ??= makeEl()) },
    window,
    location: { search: "?intent=I1", origin: "https://pay.test", href: "https://pay.test/checkout?intent=I1" },
    sessionStorage: session,
    localStorage: storage(),
    navigator: { credentials: { get: async () => ({ id: "cred-1", response: { authenticatorData: buf, clientDataJSON: buf, signature: buf } }) } },
    atob, btoa, URL, URLSearchParams, console,
    // Timers run at once. 1400ms is the pause before leaving for the merchant.
    setTimeout: (fn: () => void, ms: number) => {
      if (ms === 1400) redirects.push("scheduled");
      fn();
      return 0;
    },
    fetch: async (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url, body });
      const [status, json] = opts.route(method, url, body, calls);
      return { ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => JSON.stringify(json) };
    },
  });
  vm.runInContext(script, ctx);
  window.__deviceLibReady({
    keyStatus: () => ({ present: true, protection: "prf" }),
    deviceAddress: async () => "0xABC",
    createKey: async () => ({ address: "0xabc", protection: "prf" }),
    destinationCommitment: () => "0xdest",
    signTypedData: async () => "0xsig",
    passkeyAssertion: async (req: unknown) => (req ? { assertion: true } : undefined),
  });
  const el = (id: string) => (els[id] ??= makeEl());
  return { el, calls, session, redirects };
}
type Page = ReturnType<typeof boot>;

/** A core + checkout service that behaves, with hooks for the part under test. */
const happyRoute = (over: { attach?: (n: number) => Reply; intent?: (n: number) => Record<string, unknown> } = {}): Router => {
  let intentReads = 0;
  let attaches = 0;
  return (method, p, _body, calls) => {
    if (p === "/bff/config") return [200, { appUrl: "https://app.zold.test" }];
    if (p === "/api/checkout/intents/I1") return [200, over.intent ? over.intent(++intentReads) : INTENT];
    if (p === "/api/webauthn/challenge") return [200, { challenge: "AAAA" }];
    if (p === "/api/passkey/login") return [200, USER];
    if (p === "/api/users/u1") return [200, USER];
    if (p === "/api/quotes") return [200, { id: "q1", sendEur: 25.3, receiveEur: 25 }];
    if (p === "/api/transfers") {
      return [200, {
        id: "t1",
        authorization: {
          authorizer: "0xabc", typedData: { message: { destination: "0xdest" } },
          safeExecution: { challenge: "c1", credentialId: "cred-1" }, moneriumRedeem: { challenge: "c2", credentialId: "cred-1" },
        },
      }];
    }
    if (p === "/api/transfers/t1/authorize") return [200, { id: "t1", state: "PAYOUT_SUBMITTED" }];
    if (p === "/api/checkout/intents/I1/attach") {
      attaches++;
      return over.attach ? over.attach(attaches) : [200, { redirectUrl: "https://shop.test/cb?code=abc&state=s" }];
    }
    throw new Error(`unscripted ${method} ${p} (${calls.length} calls so far)`);
  };
};

const count = (page: Page, p: string, method = "POST") => page.calls.filter((c) => c.path === p && c.method === method).length;
const shown = (page: Page, id: string) => !page.el(id).classes.has("hidden");
const click = (page: Page) => page.el("btn-pay").onclick!();
const ATTACH = "/api/checkout/intents/I1/attach";
const TRANSFER_KEY = "zold-checkout-transfer:I1";

describe("opening a checkout link", () => {
  for (const status of ["AUTHORIZED", "PAID"]) {
    it(`shows "already paid", not the pay form, for a ${status} checkout`, async () => {
      const page = boot({ route: happyRoute({ intent: () => ({ ...INTENT, status }) }) });
      await settle();
      assert.equal(shown(page, "pay"), false, "no way to pay a second time");
      assert.equal(shown(page, "result"), true);
      assert.equal(page.el("result-title").textContent, "Already paid");
    });
  }

  for (const status of ["FAILED", "EXPIRED"]) {
    it(`shows a dead end, not the pay form, for a ${status} checkout`, async () => {
      const page = boot({ route: happyRoute({ intent: () => ({ ...INTENT, status }) }) });
      await settle();
      assert.equal(shown(page, "pay"), false);
      assert.equal(page.el("result").classes.has("bad"), true);
    });
  }

  it("shows the pay form for an open checkout", async () => {
    const page = boot({ route: happyRoute() });
    await settle();
    assert.equal(shown(page, "pay"), true);
    assert.notEqual(page.el("btn-pay").textContent, "Confirm with merchant", "an open checkout is paid, not confirmed");
    assert.equal(shown(page, "head"), true);
  });
});

describe("paying", () => {
  it("puts this checkout's own reference on the payment", async () => {
    const page = boot({ route: happyRoute() });
    await settle();
    await click(page);
    const created = page.calls.find((c) => c.path === "/api/transfers")!;
    assert.equal(created.body.reference, INTENT.transferReference);
  });

  it("completes, forgets the transfer note, and redirects", async () => {
    const page = boot({ route: happyRoute() });
    await settle();
    await click(page);
    assert.equal(page.el("result-title").textContent, "Payment sent");
    assert.equal(page.session.has(TRANSFER_KEY), false);
    assert.equal(page.redirects.length, 1);
  });

  it("re-checks the checkout is still open before it creates a transfer", async () => {
    const page = boot({ route: happyRoute({ intent: (n) => (n === 1 ? INTENT : { ...INTENT, status: "AUTHORIZED" }) }) });
    await settle();
    await click(page);
    assert.equal(count(page, "/api/transfers"), 0, "no money may move for a checkout that closed meanwhile");
    assert.match(page.el("err").textContent, /no longer open/);
    assert.equal(page.el("btn-pay").disabled, false);
  });
});

describe("when the payment went through but the merchant was not told", () => {
  it("keeps the transfer, warns not to pay again, and a second click only retries the confirmation", async () => {
    let failing = true;
    const page = boot({
      route: happyRoute({ attach: () => (failing ? [500, { error: "core down" }] : [200, { redirectUrl: "https://shop.test/cb?code=abc&state=s" }]) }),
    });
    await settle();
    await click(page);

    assert.equal(count(page, "/api/transfers"), 1);
    assert.equal(page.session.getItem(TRANSFER_KEY), "t1", "the transfer is remembered across a reload");
    assert.match(page.el("err").textContent, /do not pay again/i);
    assert.match(page.el("err").textContent, /core down/);
    assert.equal(page.el("btn-pay").textContent, "Confirm with merchant");
    assert.equal(page.el("btn-pay").disabled, false);

    failing = false;
    await click(page);
    assert.equal(count(page, "/api/transfers"), 1, "no second transfer was created");
    assert.equal(count(page, "/api/quotes"), 2, "no second quote either");
    assert.equal(count(page, ATTACH), 2);
    assert.equal(page.el("result-title").textContent, "Payment sent");
    assert.equal(page.session.has(TRANSFER_KEY), false);
  });

  it("waits out a payout that has not settled yet instead of showing an error", async () => {
    const page = boot({
      route: happyRoute({
        attach: (n) =>
          n < 3
            ? [409, { error: "transfer not settled (state PAYOUT_PENDING)", retryable: true }]
            : [200, { redirectUrl: "https://shop.test/cb?code=abc&state=s" }],
      }),
    });
    await settle();
    await click(page);
    assert.equal(count(page, ATTACH), 3);
    assert.equal(count(page, "/api/transfers"), 1);
    assert.equal(page.el("result-title").textContent, "Payment sent");
  });

  it("does not retry a final refusal, and still keeps the user from paying again", async () => {
    const page = boot({ route: happyRoute({ attach: () => [400, { error: "checkout expired" }] }) });
    await settle();
    await click(page);
    assert.equal(count(page, ATTACH), 1);
    assert.equal(page.session.getItem(TRANSFER_KEY), "t1");
    assert.match(page.el("err").textContent, /checkout expired/);
    assert.match(page.el("err").textContent, /do not pay again/i);
  });

  it("after a reload, offers to confirm the remembered payment and never the pay form", async () => {
    const page = boot({
      session: true,
      stored: { [TRANSFER_KEY]: "t1" },
      // The merchant's code was minted but the response was lost.
      route: happyRoute({ intent: () => ({ ...INTENT, status: "AUTHORIZED" }) }),
    });
    await settle();
    assert.equal(shown(page, "pay"), true);
    assert.equal(page.el("btn-pay").textContent, "Confirm with merchant");
    assert.match(page.el("note").textContent + page.el("err").textContent, /do not pay again/i);

    await click(page);
    assert.equal(count(page, "/api/transfers"), 0, "confirming never creates a transfer");
    assert.equal(count(page, "/api/quotes"), 0);
    assert.equal(count(page, ATTACH), 1);
    assert.equal(page.el("result-title").textContent, "Payment sent");
  });

  it("treats 'already completed' as done, not as an error", async () => {
    const page = boot({
      session: true,
      stored: { [TRANSFER_KEY]: "t1" },
      route: happyRoute({ intent: () => ({ ...INTENT, status: "PAID" }), attach: () => [400, { error: "checkout already completed" }] }),
    });
    await settle();
    await click(page);
    assert.equal(page.el("result-title").textContent, "Already paid");
    assert.equal(page.session.has(TRANSFER_KEY), false);
  });
});
