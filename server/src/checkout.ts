/**
 * "Pay with Zold" — the authorization-server half of the merchant handoff.
 *
 * A partner (Mony) redirects its user here with an amount, a reference, a
 * redirect_uri and a PKCE code_challenge. We create a PaymentIntent and show
 * the checkout page, where the user authorizes a SEPA transfer into the
 * merchant's IBAN using the core API's normal device-key flow. On success the
 * merchant gets a one-time code, which it exchanges (with the PKCE verifier
 * and its client secret) for the payment status.
 *
 * This is the mirror image of the Monerium OAuth-connect flow, with us as the
 * issuer instead of the client.
 *
 * Ported from the core repo, where it lived as services/api/src/checkout.ts
 * until PR #68 extracted the checkout product into this service. The one real
 * change: the core validated the transfer by reading its own store, and we
 * cannot — we read it back from the core API using the caller's own session,
 * which is also what proves the transfer is theirs.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { store, type Merchant, type PaymentIntent } from "./store.js";

const INTENT_TTL_MS = 15 * 60_000;

/** The fields of a core-API transfer that a checkout decision depends on. */
export interface CoreTransfer {
  id: string;
  userId: string;
  rail: string;
  state: string;
  recipientIban?: string;
  receiveEur?: number;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Ensure a demo merchant exists for local/sandbox runs so the flow is
 * exercisable without a real partner. Never seeded on a hosted deploy (guarded
 * by the caller). `redirectUris: ["*"]` is a demo-only convenience.
 */
export function seedDemoMerchant(ibanTarget = "DE89370400440532013000") {
  if (store.findMerchantByClientId("demo-merchant")) return;
  store.addMerchant({
    id: randomUUID(),
    name: "Mony (demo)",
    clientId: "demo-merchant",
    clientSecret: "demo-secret",
    ibanTarget,
    redirectUris: ["*"],
    webhookUrl: undefined,
    createdAt: new Date().toISOString(),
  });
}

export function redirectAllowed(merchant: Merchant, redirectUri: string): boolean {
  return merchant.redirectUris.includes("*") || merchant.redirectUris.includes(redirectUri);
}

export function createIntent(
  merchant: Merchant,
  args: { amountEur: number; reference: string; redirectUri: string; state: string; codeChallenge: string },
): PaymentIntent {
  const now = new Date().toISOString();
  return store.addPaymentIntent({
    id: randomUUID(),
    merchantId: merchant.id,
    amountEur: args.amountEur,
    reference: args.reference,
    redirectUri: args.redirectUri,
    state: args.state,
    codeChallenge: args.codeChallenge,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  });
}

export function isIntentExpired(intent: PaymentIntent): boolean {
  return Date.now() - Date.parse(intent.createdAt) > INTENT_TTL_MS;
}

/** Terminal payout states of a transfer that count as a completed checkout. */
const SETTLED = new Set(["PAYOUT_SUBMITTED", "PAID", "PAYOUT_READY", "PAYOUT_FUNDED"]);

/**
 * Attach a user's authorized transfer to an intent and mint the one-time code.
 * Refuses unless the transfer pays the merchant's IBAN, matches the intent
 * amount, and has actually left CREATED (i.e. the device signature cleared) —
 * so a merchant can never be told "paid" for a transfer that was never
 * authorized. That the transfer belongs to the caller is established before we
 * get here, by reading it from the core API with the caller's own session.
 */
export function attachTransfer(
  intent: PaymentIntent,
  userId: string,
  transfer: CoreTransfer,
): { redirectUrl: string } {
  if (intent.status !== "PENDING") throw new Error(`intent already ${intent.status.toLowerCase()}`);
  if (isIntentExpired(intent)) {
    store.updatePaymentIntent(intent.id, { status: "EXPIRED" });
    throw new Error("checkout expired");
  }
  const merchant = store.findMerchant(intent.merchantId);
  if (!merchant) throw new Error("merchant not found");
  if (transfer.userId !== userId) throw new Error("transfer does not belong to this user");
  if (transfer.rail !== "sepa") throw new Error("checkout transfer must be a SEPA payout");
  const norm = (s?: string) => (s ?? "").replace(/\s/g, "").toUpperCase();
  if (norm(transfer.recipientIban) !== norm(merchant.ibanTarget)) {
    throw new Error("transfer does not pay the merchant's account");
  }
  if (Math.abs((transfer.receiveEur ?? 0) - intent.amountEur) > 0.01) {
    throw new Error("transfer amount does not match the checkout");
  }
  if (!SETTLED.has(transfer.state)) {
    throw new Error(`transfer not settled (state ${transfer.state})`);
  }

  const code = randomBytes(24).toString("base64url");
  const status: PaymentIntent["status"] = transfer.state === "PAID" ? "PAID" : "AUTHORIZED";
  store.updatePaymentIntent(intent.id, {
    status,
    userId,
    transferId: transfer.id,
    code,
  });
  const u = new URL(intent.redirectUri);
  u.searchParams.set("code", code);
  u.searchParams.set("state", intent.state);
  return { redirectUrl: u.toString() };
}

export interface IntentStatusView {
  intentId: string;
  status: PaymentIntent["status"];
  amountEur: number;
  reference: string;
  transferId?: string;
}

export function statusView(intent: PaymentIntent): IntentStatusView {
  return {
    intentId: intent.id,
    status: intent.status,
    amountEur: intent.amountEur,
    reference: intent.reference,
    transferId: intent.transferId,
  };
}

/**
 * Confidential token exchange: the merchant proves it started this checkout by
 * presenting the PKCE verifier for the code_challenge, plus its client secret.
 * Returns the status and a bearer for subsequent polling; burns the code.
 */
export function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
): IntentStatusView & { statusToken: string } {
  const merchant = store.findMerchantByClientId(clientId);
  if (!merchant || merchant.clientSecret !== clientSecret) throw new Error("bad client credentials");
  const intent = store.findPaymentIntentByCode(code);
  if (!intent || intent.merchantId !== merchant.id) throw new Error("unknown or used code");
  if (pkceChallenge(codeVerifier) !== intent.codeChallenge) throw new Error("PKCE verification failed");
  const statusToken = randomBytes(24).toString("base64url");
  const updated = store.updatePaymentIntent(intent.id, { code: undefined, statusToken });
  return { ...statusView(updated), statusToken };
}

export function statusByToken(intentId: string, statusToken: string): IntentStatusView {
  const intent = store.findPaymentIntent(intentId);
  if (!intent || !intent.statusToken || intent.statusToken !== statusToken) {
    throw new Error("unknown intent or bad token");
  }
  return statusView(intent);
}
