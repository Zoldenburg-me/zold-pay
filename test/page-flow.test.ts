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

/** A reply, or "network" for a request that never got an answer. */
type Reply = [number, unknown] | "network";
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

/** Web Locks: free, held by another tab of this browser, missing, or refusing (e.g. a sandboxed frame). */
type LockMode = "free" | "busy" | "absent" | "rejects";

function boot(opts: { route: Router; session?: boolean; stored?: Record<string, string>; device?: Record<string, unknown>; locks?: LockMode }) {
  const lockReleases: string[] = [];
  const lockMode = opts.locks ?? "free";
  let randomSeq = 0;
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
    navigator: {
      ...(lockMode === "absent"
        ? {}
        : {
            locks: {
              request: (name: string, _opts: unknown, cb: (lock: unknown) => unknown) => {
                if (lockMode === "rejects") return Promise.reject(new Error("SecurityError"));
                // A held lock lasts until the callback's promise settles: record when that happens.
                return Promise.resolve(cb(lockMode === "busy" ? null : { name })).then(() => void lockReleases.push(name));
              },
            },
          }),
      credentials: { get: async () => ({ id: "cred-1", response: { authenticatorData: buf, clientDataJSON: buf, signature: buf } }) },
    },
    crypto: { getRandomValues: (a: Uint8Array) => a.fill(++randomSeq) },
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
      const reply = opts.route(method, url, body, calls);
      if (reply === "network") throw new TypeError("Failed to fetch");
      const [status, json] = reply;
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
    ...opts.device,
  });
  const el = (id: string) => (els[id] ??= makeEl());
  return { el, calls, session, redirects, lockReleases };
}
type Page = ReturnType<typeof boot>;

/** A core + checkout service that behaves, with hooks for the part under test. */
const happyRoute = (
  over: {
    attach?: (n: number) => Reply;
    intent?: (n: number) => Record<string, unknown>;
    claim?: () => Reply;
    authorize?: () => Reply;
  } = {},
): Router => {
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
    if (p === "/api/checkout/intents/I1/claim") return over.claim ? over.claim() : [200, { status: "PAYING" }];
    if (p === "/api/checkout/intents/I1/release") return [204, {}];
    if (p === "/api/transfers/t1/authorize") return over.authorize ? over.authorize() : [200, { id: "t1", state: "PAYOUT_SUBMITTED" }];
    if (p === "/api/checkout/intents/I1/attach") {
      attaches++;
      return over.attach ? over.attach(attaches) : [200, { redirectUrl: "https://shop.test/cb?code=abc&state=s" }];
    }
    throw new Error(`unscripted ${method} ${p} (${calls.length} calls so far)`);
  };
};

const count = (page: Page, p: string, method = "POST") => page.calls.filter((c) => c.path === p && c.method === method).length;
const shown = (page: Page, id: string) => !page.el(id).classes.has("hidden");
const click = async (page: Page) => {
  await page.el("btn-pay").onclick!();
  await settle();
};
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
    const page = boot({
      route: happyRoute({ claim: () => [409, { error: "checkout already authorized", code: "checkout_closed" }] }),
    });
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
      route: happyRoute({ intent: () => ({ ...INTENT, status: "PAID" }), attach: () => [400, { error: "checkout already completed", code: "checkout_completed" }] }),
    });
    await settle();
    await click(page);
    assert.equal(page.el("result-title").textContent, "Already paid");
    assert.equal(page.session.has(TRANSFER_KEY), false);
  });
});

const CLAIM = "/api/checkout/intents/I1/claim";
const RELEASE = "/api/checkout/intents/I1/release";
const CLAIM_KEY = "zold-checkout-claim:I1";
const indexOf = (page: Page, p: string) => page.calls.findIndex((c) => c.path === p);
const claimTokens = (page: Page) => page.calls.filter((c) => c.path === CLAIM).map((c) => c.body.claimToken as string);
const UNUSUAL_BROWSER = /up-to-date browser/;

describe("one payment per checkout, across tabs and devices", () => {
  it("claims the checkout for this payer, with a token it made, before it creates a transfer", async () => {
    const page = boot({ route: happyRoute() });
    await settle();
    await click(page);
    const claim = page.calls.find((c) => c.path === CLAIM)!;
    assert.equal(claim.body.userId, "u1");
    assert.match(claim.body.claimToken, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(indexOf(page, CLAIM) < indexOf(page, "/api/transfers"), "the claim comes before any money can move");
    assert.equal(page.el("result-title").textContent, "Payment sent");
    assert.equal(page.session.has(CLAIM_KEY), false, "the claim is forgotten once the merchant is told");
    assert.deepEqual(page.lockReleases, [CLAIM_KEY], "and the tab's lock is let go");
  });

  it("a second tab that cannot claim creates no transfer, says the payment is in progress, and lets go", async () => {
    const page = boot({
      route: happyRoute({ claim: () => [409, { error: "this checkout is already being paid", code: "payment_in_progress" }] }),
    });
    await settle();
    await click(page);
    assert.equal(count(page, "/api/transfers"), 0);
    assert.equal(count(page, "/api/quotes"), 0);
    assert.match(page.el("err").textContent, /being paid in another window/);
    assert.equal(count(page, RELEASE), 0, "a refused tab holds no claim to release");
    assert.equal(page.session.has(CLAIM_KEY), false);
    assert.deepEqual(page.lockReleases, [CLAIM_KEY]);
  });

  it("asks again with the same token when the answer to the claim was lost", async () => {
    let first = true;
    const page = boot({ route: happyRoute({ claim: () => (first ? ((first = false), "network") : [200, { status: "PAYING" }]) }) });
    await settle();
    await click(page);
    const [lost] = claimTokens(page);
    // The claim may have been taken: it is released with the token the page kept.
    assert.equal(page.calls.find((c) => c.path === RELEASE)!.body.claimToken, lost);
    assert.equal(count(page, "/api/transfers"), 0);
    await click(page);
    assert.equal(page.el("result-title").textContent, "Payment sent");
  });

  it("keeps the token when the release also gets no answer, and the next claim reuses it", async () => {
    let claims = 0;
    const route = happyRoute({ claim: () => (++claims === 1 ? "network" : [200, { status: "PAYING" }]) });
    const page = boot({ route: (m, p, b, c) => (p === RELEASE ? "network" : route(m, p, b, c)) });
    await settle();
    await click(page);
    await click(page);
    const [lost, retried] = claimTokens(page);
    assert.equal(retried, lost);
  });

  it("shows no pay form for a checkout another tab or device is paying", async () => {
    const page = boot({ route: happyRoute({ intent: () => ({ ...INTENT, status: "PAYING" }) }) });
    await settle();
    assert.equal(shown(page, "pay"), false);
    assert.equal(page.el("result-title").textContent, "Payment in progress");
  });

  it("lets the tab holding the claim carry on after a reload, presenting its token", async () => {
    const page = boot({
      session: true,
      stored: { [CLAIM_KEY]: "claim-1" },
      route: happyRoute({ intent: () => ({ ...INTENT, status: "PAYING" }) }),
    });
    await settle();
    assert.equal(shown(page, "pay"), true);
    await click(page);
    assert.deepEqual(claimTokens(page), ["claim-1"]);
    assert.equal(page.el("result-title").textContent, "Payment sent");
  });

  it("releases the claim and the lock when the passkey is cancelled, because no money moved", async () => {
    const page = boot({
      route: happyRoute(),
      device: { passkeyAssertion: async () => { throw new Error("The operation was cancelled"); } },
    });
    await settle();
    await click(page);
    assert.equal(page.calls.find((c) => c.path === RELEASE)!.body.claimToken, claimTokens(page)[0]);
    assert.equal(page.session.has(TRANSFER_KEY), false);
    assert.equal(page.session.has(CLAIM_KEY), false);
    assert.deepEqual(page.lockReleases, [CLAIM_KEY]);
    assert.doesNotMatch(page.el("err").textContent, /do not pay again/i);
  });

  it("releases the claim when the core refuses the authorization", async () => {
    const page = boot({ route: happyRoute({ authorize: () => [400, { error: "insufficient balance" }] }) });
    await settle();
    await click(page);
    assert.equal(count(page, RELEASE), 1);
    assert.equal(page.session.has(TRANSFER_KEY), false);
    assert.match(page.el("err").textContent, /insufficient balance/);
  });

  for (const [what, reply] of [
    ["a 502", [502, { error: "the Zold API could not complete the request" }]],
    ["a 409", [409, { error: "conflict" }]],
    ["a 408", [408, { error: "timeout" }]],
    ["a 422", [422, { error: "unprocessable" }]],
    ["no answer at all", "network"],
  ] as [string, Reply][]) {
    it(`keeps the claim and remembers the transfer when the authorization gets ${what}`, async () => {
      const page = boot({ route: happyRoute({ authorize: () => reply }) });
      await settle();
      await click(page);
      assert.equal(count(page, RELEASE), 0, "the money may have moved: the checkout stays with this tab");
      assert.equal(page.session.getItem(TRANSFER_KEY), "t1");
      assert.equal(page.session.getItem(CLAIM_KEY), claimTokens(page)[0]);
      assert.match(page.el("err").textContent, /do not pay again/i);
      assert.equal(page.el("btn-pay").textContent, "Confirm with merchant");
    });
  }
});

describe("the tab lock", () => {
  it("a duplicated tab that copied the claim does not resume it while the original tab holds it", async () => {
    const page = boot({
      session: true,
      stored: { [CLAIM_KEY]: "claim-1" },
      locks: "busy",
      route: happyRoute({ intent: () => ({ ...INTENT, status: "PAYING" }) }),
    });
    await settle();
    assert.equal(shown(page, "pay"), false);
    assert.equal(page.el("result-title").textContent, "Payment in progress");
  });

  it("an open checkout cannot be paid from a tab while another tab of this browser holds its lock", async () => {
    const page = boot({ route: happyRoute(), locks: "busy" });
    await settle();
    await click(page);
    assert.equal(count(page, CLAIM), 0);
    assert.equal(count(page, "/api/transfers"), 0);
    assert.match(page.el("err").textContent, /being paid in another window/);
  });

  for (const locks of ["absent", "rejects"] as const) {
    it(`refuses, without hanging, in a browser whose Web Locks are ${locks}`, async () => {
      const page = boot({ route: happyRoute(), locks });
      await settle();
      assert.equal(shown(page, "pay"), true, "the page loads");
      await click(page);
      assert.equal(count(page, CLAIM), 0);
      assert.equal(count(page, "/api/transfers"), 0);
      assert.match(page.el("err").textContent, UNUSUAL_BROWSER);
      assert.equal(page.el("btn-pay").disabled, false, "the button comes back");
    });
  }
});

describe("a payment the checkout could not take", () => {
  for (const code of ["duplicate_payment", "late_payment"]) {
    it(`ends on a clear answer for ${code}, and stops offering to confirm`, async () => {
      const page = boot({ route: happyRoute({ attach: () => [409, { error: "recorded; the merchant will refund it", code }] }) });
      await settle();
      await click(page);
      assert.equal(page.el("result-title").textContent, "Payment recorded");
      assert.match(page.el("result-note").textContent, /refund/);
      assert.equal(shown(page, "pay"), false);
      assert.equal(page.session.has(TRANSFER_KEY), false);
      assert.equal(page.session.has(CLAIM_KEY), false);
      assert.deepEqual(page.lockReleases, [CLAIM_KEY]);
    });
  }
});

describe("the spending key", () => {
  it("is minted only passkey-protected: the page asks device.js for strict mode", async () => {
    let asked: unknown;
    const happy = happyRoute();
    const { authorizerAddress: _bound, ...unbound } = USER;
    const page = boot({
      // An account with no spending key yet: the page mints one and binds it.
      route: (m, p, b, c) =>
        p === "/api/users/u1" || p === "/api/passkey/login" ? [200, unbound]
        : p === "/api/users/u1/authorizer" ? [200, { authorizerAddress: "0xabc" }]
        : happy(m, p, b, c),
      device: {
        keyStatus: () => ({ present: false, protection: null }),
        createKey: async (_cred: string, opts: unknown) => ((asked = opts), { address: "0xabc", protection: "prf" }),
      },
    });
    await settle();
    await click(page);
    assert.equal(count(page, "/api/users/u1/authorizer"), 1, "a key was minted and bound");
    // Read the field: the options object comes from the page's own realm.
    assert.equal((asked as { requirePrf?: unknown } | undefined)?.requirePrf, true);
  });

  it("refuses to pay with a key this browser holds unencrypted, before any money can move", async () => {
    const page = boot({ route: happyRoute(), device: { keyStatus: () => ({ present: true, protection: "none" }) } });
    await settle();
    await click(page);
    assert.equal(count(page, "/api/quotes"), 0);
    assert.equal(count(page, "/api/transfers"), 0);
    assert.match(page.el("err").textContent, /unencrypted.*Zold app/);
    assert.equal(count(page, RELEASE), 1, "the claim is given back: nothing was paid");
  });
});

describe("asking device.js for the address", () => {
  it("always in strict mode, so a key cleared by another tab mid-flow is never re-made unencrypted", async () => {
    const modes: unknown[] = [];
    const page = boot({
      route: happyRoute(),
      device: { deviceAddress: async (_cred: string, opts: { requirePrf?: unknown } | undefined) => (modes.push(opts?.requirePrf), "0xABC") },
    });
    await settle();
    await click(page);
    assert.ok(modes.length > 0, "the page asked for the address");
    assert.ok(modes.every((m) => m === true), `every call strict: ${modes.join(",")}`);
  });
});

describe("the spending key, checked again", () => {
  it("refuses a damaged key record before any money can move", async () => {
    const page = boot({ route: happyRoute(), device: { keyStatus: () => ({ present: true, protection: null, damaged: true }) } });
    await settle();
    await click(page);
    assert.equal(count(page, "/api/transfers"), 0);
    assert.match(page.el("err").textContent, /damaged.*Zold app/);
  });

  it("re-checks the key's protection right before signing", async () => {
    let created = false;
    let signed = false;
    const happy = happyRoute();
    const page = boot({
      route: (m, p, b, c) => {
        if (p === "/api/transfers") created = true;
        return happy(m, p, b, c);
      },
      device: {
        // Swapped for an unencrypted key after the first checks (another tab, say).
        keyStatus: () => ({ present: true, protection: created ? "none" : "prf" }),
        signTypedData: async () => ((signed = true), "0xsig"),
      },
    });
    await settle();
    await click(page);
    assert.equal(signed, false);
    assert.match(page.el("err").textContent, /unencrypted/);
  });
});
