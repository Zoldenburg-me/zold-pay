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
import { CONFIG, assertConfigSane, coreIsLoopback, devShortcutsEnabled } from "./config.js";
import { core, type CoreError } from "./core.js";
import { proxy } from "./proxy.js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

assertConfigSane();

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
