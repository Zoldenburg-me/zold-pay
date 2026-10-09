/**
 * "Pay with Zold" checkout service.
 *
 * A thin web app + BFF. It owns no users, no keys and no ledger: the core Zold
 * API is the source of truth, and this process serves the checkout origin and
 * forwards an allowlisted set of calls to it.
 *
 * Passkeys are scoped to a relying-party id and the device key lives in one
 * origin's localStorage, so the checkout page, its API and the account app have
 * to agree on one origin. See README §"Origins and the RP ID" and ADR 0001.
 */
import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CheckoutError,
  CoreResponseError,
  assertNoWildcardRedirects,
  attachTransfer,
  claimIntent,
  clientSecretMatches,
  createIntent,
  exchangeCode,
  isIntentExpired,
  parseCoreTransfer,
  redirectAllowed,
  releaseClaim,
  seedDemoMerchant,
  statusByToken,
  statusView,
  transferReference,
} from "./checkout.js";
import { CONFIG, assertConfigSane, coreIsLoopback, devShortcutsEnabled, originIsLoopback } from "./config.js";
import { core, type CoreError } from "./core.js";
import { createErrorHandler } from "./errors.js";
import { createRateLimiter } from "./limits.js";
import { proxy } from "./proxy.js";
import { addNoncePlaceholders, fillNonce, newNonce, originPolicy, pageCsp, securityHeaders } from "./security.js";
import { INTENT_TTL_MS, initStore, store } from "./store.js";
import { isId, parseIntentInput } from "./validate.js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const MAX_FIELD = 512;

assertConfigSane();
initStore();
// A wildcard redirect is for the local demo only. Check it whenever this service
// is reachable from elsewhere, not just when NODE_ENV says "production": a
// hosted box running with NODE_ENV=development must not carry one either.
if (CONFIG.production || !originIsLoopback()) assertNoWildcardRedirects(store.allMerchants());
// Drop abandoned checkouts and expired payer names now and every minute, so
// neither depends on a restart. The timer reports a failed write instead of
// letting it escape and end the process.
store.sweep();
setInterval(() => store.sweepSafely(), 60_000).unref();
// Seed a demo merchant only where explicitly asked for and the core is on
// loopback, so the flow is exercisable without a real partner.
if (devShortcutsEnabled()) seedDemoMerchant(process.env.CHECKOUT_DEMO_IBAN);

const parseOpts = {
  maxAmountEur: CONFIG.maxAmountEur,
  allowInsecureLoopback: !CONFIG.production && coreIsLoopback(),
};

export const app = express();
app.disable("x-powered-by");
// Honest client addresses for rate limiting: trust only the hops we were told about.
app.set("trust proxy", CONFIG.trustedProxyHops ?? false);
app.use(securityHeaders(CONFIG.production));
app.use(originPolicy(CONFIG.publicOrigin));

const { windowMs, general, credential } = CONFIG.rateLimit;
const generalLimit = createRateLimiter({ windowMs, max: general });
app.use("/api", generalLimit);
app.use("/bff", generalLimit);
// Credential-guessing surfaces get a tight bucket each, so one noisy route
// cannot starve another.
const credentialLimit = () => createRateLimiter({ windowMs, max: credential });
// Sign-in is a guessing surface on the core too; give each its own tight bucket
// before the request is proxied.
for (const signInPath of ["/api/passkey/login", "/api/webauthn/challenge"]) app.use(signInPath, credentialLimit());
// The front channel starts a checkout with only a merchant's public client id,
// so the per-address limit alone lets many addresses open checkouts for one
// merchant. Each merchant also gets one front-channel bucket across every
// address. Only the front channel: the back channel needs the client secret, and
// a flood on the public URL must not lock the merchant out of its own
// authenticated checkouts. Unknown ids get no bucket (they are refused anyway),
// so made-up ids cannot grow the table.
const frontChannelMerchantLimit = createRateLimiter({
  windowMs,
  max: CONFIG.rateLimit.client,
  keyOf: (req) => {
    const clientId = req.query.client_id;
    return isShortString(clientId) && store.findMerchantByClientId(clientId) ? clientId : undefined;
  },
});

app.use(express.json({ limit: CONFIG.jsonBodyLimit }));

const wrap =
  (fn: express.Handler): express.Handler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const bearer = (req: express.Request) => {
  const h = req.header("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : undefined;
};

const isShortString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD;

/**
 * Answer a failed call to the core. The core's own refusals (4xx) are relayed so
 * the page can say why. Anything else is OUR problem to describe: a 3xx or 5xx, an
 * unreadable reply, a timeout or an unreachable core becomes a fixed message with
 * the right gateway status, never raw upstream text.
 */
function relayCoreError(err: unknown, res: express.Response) {
  if (err instanceof CoreResponseError) {
    console.error(`checkout: ${err.message}`);
    return res.status(502).json({ error: "the Zold API sent an unexpected response" });
  }
  const e = err as CoreError;
  if (typeof e?.status === "number") {
    if (e.status >= 400 && e.status < 500) return res.status(e.status).json({ error: e.message });
    return res.status(502).json({ error: "the Zold API could not complete the request" });
  }
  const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
  res.status(timedOut ? 504 : 502).json({
    error: timedOut ? "the Zold API did not respond in time" : "could not reach the Zold API",
  });
}

/**
 * The payer's legal name is optional evidence for the merchant. It must never be
 * the reason a payment that has already left the payer's account cannot be
 * attached, so a failed lookup means no name, not no checkout.
 */
async function lookupPayerName(userId: string, token: string, intentId: string): Promise<string | undefined> {
  try {
    // Read with the CALLER's session, so we can only ever learn the name of
    // the person actually completing this checkout.
    const payer = await core<{ name?: string }>(`/api/users/${encodeURIComponent(userId)}`, { sessionToken: token });
    return typeof payer?.name === "string" ? payer.name : undefined;
  } catch {
    console.warn(`checkout: payer name unavailable for checkout ${intentId}`);
    return undefined;
  }
}

/** What the browser needs to know about how this deployment is configured. */
app.get("/bff/config", (_req, res) => {
  res.json({ publicOrigin: CONFIG.publicOrigin, appUrl: CONFIG.appUrl });
});

// Whether this service is up and can reach the core, and nothing else: what the
// core says about itself (versions, paths, chain) is not for the public.
app.get(
  "/bff/health",
  wrap(async (_req, res) => {
    try {
      await core("/api/health");
      res.json({ ok: true, core: { reachable: true } });
    } catch {
      // No upstream error text: it can carry addresses and internals.
      res.status(503).json({ ok: false, core: { reachable: false } });
    }
  }),
);

// --- "Pay with Zold" checkout (the merchant OAuth handoff) -------------------
// This service is the authorization server. These routes are declared before
// the proxy so they are answered locally rather than forwarded.

/**
 * Back channel: the merchant POSTs the payment details with its client secret
 * and gets an intent id, then redirects the user to the returned URL.
 *
 * Authenticating the call is what makes a per-transaction destination safe;
 * the merchant's IBAN allowlist is what keeps it safe if the secret leaks.
 */
app.post(
  "/api/checkout/intents",
  credentialLimit(),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const merchant = typeof b.client_id === "string" ? store.findMerchantByClientId(b.client_id) : undefined;
    // Same error for unknown client and wrong secret: the back channel should
    // not confirm which client ids exist.
    if (!merchant || !clientSecretMatches(merchant, b.client_secret)) {
      return res.status(401).json({ error: "bad client credentials" });
    }
    const parsed = parseIntentInput(b, parseOpts);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (!redirectAllowed(merchant, parsed.value.redirectUri)) {
      return res.status(400).json({ error: "redirect_uri not allowed for this client" });
    }
    try {
      const intent = createIntent(merchant, parsed.value);
      res.status(201).json({
        intentId: intent.id,
        checkoutUrl: `${CONFIG.publicOrigin}/checkout?intent=${intent.id}`,
        merchant: merchant.name,
        amountEur: intent.amountEur,
        destinationIban: intent.destinationIban,
        reference: intent.reference,
        expiresAt: new Date(Date.parse(intent.createdAt) + INTENT_TTL_MS).toISOString(),
      });
    } catch (e) {
      if (e instanceof CheckoutError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }),
);

// Front channel: unauthenticated GET, kept for the simple case where the
// merchant is paid into its default account. Deliberately cannot choose a
// destination — see the back channel above.
app.get(
  "/api/checkout/authorize",
  credentialLimit(),
  frontChannelMerchantLimit,
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const merchant = isShortString(q.client_id) ? store.findMerchantByClientId(q.client_id) : undefined;
    if (!merchant) return res.status(400).json({ error: "unknown client_id" });
    if (q.destination_iban) {
      return res.status(400).json({
        error:
          "destination_iban cannot be set on the unauthenticated authorize URL — " +
          "use POST /api/checkout/intents with your client secret",
      });
    }
    const parsed = parseIntentInput(q, parseOpts);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (!redirectAllowed(merchant, parsed.value.redirectUri)) {
      return res.status(400).json({ error: "redirect_uri not allowed for this client" });
    }
    try {
      const intent = createIntent(merchant, { ...parsed.value, channel: "front" });
      // Absolute: the merchant redirects the user here from its own origin.
      const checkoutUrl = `${CONFIG.publicOrigin}/checkout?intent=${intent.id}`;
      if ((req.header("accept") ?? "").includes("application/json")) {
        return res.status(201).json({ intentId: intent.id, checkoutUrl, merchant: merchant.name, amountEur: intent.amountEur });
      }
      res.redirect(checkoutUrl);
    } catch (e) {
      if (e instanceof CheckoutError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }),
);

// Public-facing intent info for the checkout UI (no secrets): who is being
// paid and how much. No auth — it's a redirect target the user just landed on.
app.get(
  "/api/checkout/intents/:id",
  credentialLimit(),
  wrap(async (req, res) => {
    const intent = store.findPaymentIntent(req.params.id);
    if (!intent) return res.status(404).json({ error: "unknown checkout" });
    const merchant = store.findMerchant(intent.merchantId);
    res.json({
      ...statusView(intent),
      merchant: merchant?.name,
      // The account this intent pays, not the merchant's whole allowlist: the
      // page shows it to the user and folds it into the signed destination
      // commitment, so it must be the one pinned at creation.
      merchantIban: intent.destinationIban,
      // What the payer's transfer must carry as its payment reference. Unique to
      // this checkout, so the payment can only ever be matched back to it.
      transferReference: transferReference(intent),
      expired: isIntentExpired(intent),
    });
  }),
);

/**
 * The page makes its claim token from 32 random bytes (43 base64url characters);
 * anything shorter is not a secret worth holding a checkout with.
 */
const isClaimToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(v);

/** A refusal the caller may see, with its stable code and whether asking again can help. */
const checkoutErrorBody = (e: CheckoutError) => ({
  error: e.message,
  ...(e.code ? { code: e.code } : {}),
  ...(e.retryable ? { retryable: true } : {}),
});

// The page claims the checkout for its payer BEFORE it creates a core transfer,
// so a second tab or device that loaded the same checkout cannot pay it too.
// The session must belong to the payer named: the core answers the user read
// with the caller's own session, and refuses anyone else's.
app.post(
  "/api/checkout/intents/:id/claim",
  credentialLimit(),
  wrap(async (req, res) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "authorization required" });
    const userId = req.body?.userId;
    if (!isId(userId)) return res.status(400).json({ error: "userId required" });
    const claimToken = req.body?.claimToken;
    if (!isClaimToken(claimToken)) return res.status(400).json({ error: "claimToken required" });
    try {
      await core(`/api/users/${encodeURIComponent(userId)}`, { sessionToken: token });
    } catch (err) {
      return relayCoreError(err, res);
    }
    try {
      // By id, after the await: the checkout may have been claimed meanwhile.
      // claimIntent checks and writes with no await in between, which is what
      // makes two simultaneous claims end with exactly one holder.
      claimIntent(req.params.id, userId, claimToken);
      res.json({ status: "PAYING" });
    } catch (e) {
      if (e instanceof CheckoutError) return res.status(e.status).json(checkoutErrorBody(e));
      throw e;
    }
  }),
);

// The paying tab gives the checkout back when its payment surely did not happen.
// The claim token is the credential: only the tab that claimed holds it.
app.post(
  "/api/checkout/intents/:id/release",
  credentialLimit(),
  wrap(async (req, res) => {
    const claimToken = req.body?.claimToken;
    if (!isClaimToken(claimToken)) return res.status(400).json({ error: "claimToken required" });
    try {
      releaseClaim(req.params.id, claimToken);
      res.status(204).end();
    } catch (e) {
      if (e instanceof CheckoutError) return res.status(e.status).json(checkoutErrorBody(e));
      throw e;
    }
  }),
);

// The user links the transfer they just authorized into the merchant's IBAN,
// minting the one-time code and the redirect back. The transfer is read back
// from the core API with the caller's own bearer: a transfer another user owns
// is not readable with this session, so a 403/404 upstream is the answer.
app.post(
  "/api/checkout/intents/:id/attach",
  credentialLimit(),
  wrap(async (req, res) => {
    const intent = store.findPaymentIntent(req.params.id);
    if (!intent) return res.status(404).json({ error: "unknown checkout" });
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "authorization required" });
    const transferId = req.body?.transferId;
    // It becomes a path segment on the core API, so it must be a plain id.
    if (!isId(transferId)) return res.status(400).json({ error: "transferId required" });
    let transfer;
    try {
      // Read with the CALLER's session: a transfer another user owns is not
      // readable with it, so the core's 403/404 is the ownership check.
      transfer = parseCoreTransfer(
        await core(`/api/transfers/${encodeURIComponent(transferId)}`, { sessionToken: token }),
        transferId,
      );
    } catch (err) {
      return relayCoreError(err, res);
    }
    const payerName = await lookupPayerName(transfer.userId, token, intent.id);
    try {
      // By id, not the record fetched above: it can be stale after the awaits.
      res.json(attachTransfer(intent.id, transfer, payerName));
    } catch (e) {
      if (e instanceof CheckoutError) return res.status(e.status).json(checkoutErrorBody(e));
      throw e;
    }
  }),
);

// Merchant confidential token exchange: code + PKCE verifier + client secret
// → status + a bearer for polling. Burns the code.
app.post(
  "/api/checkout/token",
  credentialLimit(),
  wrap(async (req, res) => {
    const { client_id, client_secret, code, code_verifier } = req.body ?? {};
    if (![client_id, client_secret, code, code_verifier].every(isShortString)) {
      return res.status(400).json({ error: "client_id, client_secret, code and code_verifier required" });
    }
    try {
      res.json(exchangeCode(client_id, client_secret, code, code_verifier));
    } catch (e) {
      if (e instanceof CheckoutError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }),
);

// Merchant status polling with the exchange bearer.
app.get(
  "/api/checkout/status/:id",
  credentialLimit(),
  wrap(async (req, res) => {
    const tok = bearer(req);
    if (!tok) return res.status(401).json({ error: "authorization required" });
    try {
      res.json(statusByToken(req.params.id, tok));
    } catch (e) {
      if (e instanceof CheckoutError) return res.status(404).json({ error: e.message });
      throw e;
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

// The page's inline script and style carry a per-response nonce, so the CSP can
// refuse every other inline script. The template is read once at startup.
const pageTemplate = addNoncePlaceholders(readFileSync(path.join(WEB, "checkout.html"), "utf8"));
const page: express.Handler = (_req, res) => {
  const nonce = newNonce();
  res.setHeader("Content-Security-Policy", pageCsp(nonce));
  // Never cached: the body carries a nonce that is only valid for this response.
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(fillNonce(pageTemplate, nonce));
};
app.get("/", page);
app.get("/checkout", page);
app.get("/checkout.html", page);

app.use(
  express.static(WEB, {
    index: false,
    setHeaders(res, filePath) {
      // device.js and the vendored crypto are the security-relevant assets;
      // don't let a stale copy linger in a cache we cannot bust.
      if (filePath.endsWith(".js")) res.setHeader("cache-control", "no-cache");
    },
  }),
);

app.use((_req, res) => res.status(404).json({ error: "not found" }));
app.use(createErrorHandler());

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  app.listen(CONFIG.port, () => {
    console.log(`Pay with Zold checkout on http://localhost:${CONFIG.port}`);
    console.log(`  core API      ${CONFIG.coreApiUrl}`);
    console.log(`  public origin ${CONFIG.publicOrigin}`);
    console.log(`  mode          ${CONFIG.production ? "production" : "development"}`);
    console.log(`  demo merchant ${devShortcutsEnabled() ? "seeded (local only)" : "off"}`);
  });
}
