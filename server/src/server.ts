/**
 * "Pay with Zold" checkout service.
 *
 * A thin web app + BFF. It owns no users, no keys and no ledger: the core Zold
 * API is the source of truth, and this process serves the checkout origin and
 * forwards an allowlisted set of calls to it.
 *
 * Why it is a separate origin at all: passkeys are scoped to a relying-party
 * id and the FP4 device key lives in one origin's localStorage. A user who
 * onboards here gets both created here, which is the only combination that is
 * self-consistent. See README §"Origins and the RP ID".
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachTransfer,
  createIntent,
  exchangeCode,
  isIntentExpired,
  redirectAllowed,
  seedDemoMerchant,
  statusByToken,
  statusView,
  type CoreTransfer,
} from "./checkout.js";
import { CONFIG, assertConfigSane, coreIsLoopback, devShortcutsEnabled } from "./config.js";
import { core, type CoreError } from "./core.js";
import { proxy } from "./proxy.js";
import { initStore, store } from "./store.js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

assertConfigSane();
initStore();
// Seed a demo merchant only where the demo shortcuts are on, so the flow is
// exercisable without a real partner. A hosted deploy gets no default client.
if (devShortcutsEnabled()) seedDemoMerchant(process.env.CHECKOUT_DEMO_IBAN);

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: CONFIG.jsonBodyLimit }));

const wrap =
  (fn: express.Handler): express.Handler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const bearer = (req: express.Request) => {
  const h = req.header("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : undefined;
};

/** What the browser needs to know about how this deployment is configured. */
app.get("/bff/config", (_req, res) => {
  res.json({
    publicOrigin: CONFIG.publicOrigin,
    // The RP ID is the core's (SECURITY.rpId) and comes back on every
    // /api/webauthn/challenge response — the client uses that, not this.
    devShortcuts: devShortcutsEnabled(),
  });
});

app.get(
  "/bff/health",
  wrap(async (_req, res) => {
    try {
      const upstream = await core("/api/health");
      res.json({ ok: true, core: { reachable: true, ...upstream } });
    } catch (err: any) {
      res.status(503).json({ ok: false, core: { reachable: false, error: err?.message ?? String(err) } });
    }
  }),
);

// --- Dev-only shortcuts ------------------------------------------------------
// These reach core endpoints the proxy deliberately does not expose. They exist
// because the core refuses its /api/simulate/* routes for any request carrying
// a forwarding header, so the browser can never reach them through the proxy —
// only this process can, from loopback. Both are gated on ALLOW_DEV_SHORTCUTS
// *and* a loopback core, and both still require the caller's own session, so
// they act on the signed-in account and no other.

function requireDevShortcuts(res: express.Response): boolean {
  if (!devShortcutsEnabled()) {
    res.status(403).json({
      error: coreIsLoopback()
        ? "dev shortcuts are disabled — set ALLOW_DEV_SHORTCUTS=1 for local runs"
        : "dev shortcuts are local-only and the configured Zold API is not loopback",
    });
    return false;
  }
  return true;
}

function relayCoreError(err: unknown, res: express.Response) {
  const e = err as CoreError;
  if (typeof e?.status === "number") return res.status(e.status).json({ error: e.message });
  res.status(502).json({ error: "could not reach the Zold API" });
}

/** Local demo: approve this account's KYC through the core's mock review. */
app.post(
  "/bff/dev/kyc-approve",
  wrap(async (req, res) => {
    if (!requireDevShortcuts(res)) return;
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "authorization required" });
    const userId = req.body?.userId;
    if (typeof userId !== "string" || !userId) return res.status(400).json({ error: "userId required" });
    try {
      res.json(
        await core(`/api/users/${encodeURIComponent(userId)}/kyc/mock-review`, {
          body: { decision: "approved" },
          sessionToken: token,
        }),
      );
    } catch (err) {
      relayCoreError(err, res);
    }
  }),
);

/** Local demo: credit a simulated SEPA deposit so a new account has a balance. */
app.post(
  "/bff/dev/fund",
  wrap(async (req, res) => {
    if (!requireDevShortcuts(res)) return;
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "authorization required" });
    const { iban, amountEur } = req.body ?? {};
    if (!iban || !(Number(amountEur) > 0)) {
      return res.status(400).json({ error: "iban and a positive amountEur required" });
    }
    try {
      res.json(
        await core("/api/simulate/sepa-deposit", {
          body: { iban, amountEur: Number(amountEur) },
          sessionToken: token,
        }),
      );
    } catch (err) {
      relayCoreError(err, res);
    }
  }),
);

// --- "Pay with Zold" checkout (the merchant OAuth handoff) -------------------
// This service is the authorization server. These routes were in the core app
// until PR #68 extracted the checkout product here; the core no longer serves
// /api/checkout/* at all. They are declared before the proxy so they are
// answered locally rather than forwarded.

// Merchant handoff: validate the client + redirect_uri, create a payment
// intent, and send the user to the checkout UI. Returns JSON to API callers
// (tests, merchant backends), redirects a browser.
app.get(
  "/api/checkout/authorize",
  wrap(async (req, res) => {
    const q = req.query as Record<string, string>;
    const merchant = q.client_id ? store.findMerchantByClientId(q.client_id) : undefined;
    if (!merchant) return res.status(400).json({ error: "unknown client_id" });
    if (!q.redirect_uri || !redirectAllowed(merchant, q.redirect_uri)) {
      return res.status(400).json({ error: "redirect_uri not allowed for this client" });
    }
    const amountEur = Number(q.amount);
    if (!(amountEur > 0)) return res.status(400).json({ error: "positive amount required" });
    if (!q.code_challenge || (q.code_challenge_method ?? "S256") !== "S256") {
      return res.status(400).json({ error: "S256 code_challenge required" });
    }
    const intent = createIntent(merchant, {
      amountEur,
      reference: q.reference ?? "",
      redirectUri: q.redirect_uri,
      state: q.state ?? "",
      codeChallenge: q.code_challenge,
    });
    // Absolute, unlike the core's old relative URL: the merchant redirects the
    // user here from its own origin, so a path alone would resolve against the
    // wrong host.
    const checkoutUrl = `${CONFIG.publicOrigin}/checkout?intent=${intent.id}`;
    if ((req.header("accept") ?? "").includes("application/json")) {
      return res.status(201).json({ intentId: intent.id, checkoutUrl, merchant: merchant.name, amountEur });
    }
    res.redirect(checkoutUrl);
  }),
);

// Public-facing intent info for the checkout UI (no secrets): who is being
// paid and how much. No auth — it's a redirect target the user just landed on.
app.get(
  "/api/checkout/intents/:id",
  wrap(async (req, res) => {
    const intent = store.findPaymentIntent(req.params.id);
    if (!intent) return res.status(404).json({ error: "unknown checkout" });
    const merchant = store.findMerchant(intent.merchantId);
    res.json({
      ...statusView(intent),
      merchant: merchant?.name,
      merchantIban: merchant?.ibanTarget,
      expired: isIntentExpired(intent),
    });
  }),
);

// The user links the transfer they just authorized into the merchant's IBAN,
// minting the one-time code and the redirect back.
//
// The core app could read the transfer from its own store and check the
// session against it. We read it back from the core API with the caller's own
// bearer instead — which is the same proof: a transfer another user owns is
// not readable with this session, so a 403/404 upstream is the answer.
app.post(
  "/api/checkout/intents/:id/attach",
  wrap(async (req, res) => {
    const intent = store.findPaymentIntent(req.params.id);
    if (!intent) return res.status(404).json({ error: "unknown checkout" });
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "authorization required" });
    const transferId = req.body?.transferId;
    if (typeof transferId !== "string" || !transferId) {
      return res.status(400).json({ error: "transferId required" });
    }
    let transfer: CoreTransfer;
    try {
      transfer = await core<CoreTransfer>(`/api/transfers/${encodeURIComponent(transferId)}`, {
        sessionToken: token,
      });
    } catch (err) {
      return relayCoreError(err, res);
    }
    try {
      res.json(attachTransfer(intent, transfer.userId, transfer));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  }),
);

// Merchant confidential token exchange: code + PKCE verifier + client secret
// → status + a bearer for polling. Burns the code.
app.post(
  "/api/checkout/token",
  wrap(async (req, res) => {
    const { client_id, client_secret, code, code_verifier } = req.body ?? {};
    if (!client_id || !client_secret || !code || !code_verifier) {
      return res.status(400).json({ error: "client_id, client_secret, code and code_verifier required" });
    }
    try {
      res.json(exchangeCode(client_id, client_secret, code, code_verifier));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  }),
);

// Merchant status polling with the exchange bearer.
app.get(
  "/api/checkout/status/:id",
  wrap(async (req, res) => {
    const tok = bearer(req);
    if (!tok) return res.status(401).json({ error: "authorization required" });
    try {
      res.json(statusByToken(req.params.id, tok));
    } catch (e: any) {
      res.status(404).json({ error: String(e?.message ?? e) });
    }
  }),
);

// --- Core API proxy ----------------------------------------------------------

// Mounted at the root rather than at "/api" so that req.path stays the full
// core path the allowlist is written against.
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  return proxy(req, res, next);
});

// --- Static checkout UI ------------------------------------------------------

// The core's /api/checkout/authorize hands back a relative "/checkout.html?intent=…".
// Serve the page at both spellings so that URL resolves against this origin too.
const page: express.Handler = (_req, res) => res.sendFile(path.join(WEB, "checkout.html"));
app.get("/", page);
app.get("/checkout", page);

app.use(
  express.static(WEB, {
    index: false,
    setHeaders(res, filePath) {
      // device.js and the vendored crypto are the security-relevant assets;
      // don't let a stale copy linger in a cache we cannot bust.
      if (filePath.endsWith(".js") || filePath.endsWith(".html")) {
        res.setHeader("cache-control", "no-cache");
      }
    },
  }),
);

app.use((_req, res) => res.status(404).json({ error: "not found" }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "checkout service error" });
}) as express.ErrorRequestHandler);

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  app.listen(CONFIG.port, () => {
    console.log(`Pay with Zold checkout on http://localhost:${CONFIG.port}`);
    console.log(`  core API      ${CONFIG.coreApiUrl}`);
    console.log(`  public origin ${CONFIG.publicOrigin}`);
    console.log(`  dev shortcuts ${devShortcutsEnabled() ? "ENABLED (simulated KYC + deposits)" : "off"}`);
  });
}
