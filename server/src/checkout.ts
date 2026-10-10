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
import { createHash, createHmac, randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { hashSecret, newToken, safeEqual, secretMatchesHash } from "./secrets.js";
import {
  ATTACH_GRACE_MS,
  CODE_TTL_MS,
  INTENT_TTL_MS,
  newPayRef,
  store,
  type Merchant,
  type PaymentIntent,
  type UnattachedPayment,
  type UnattachedReason,
} from "./store.js";
import { isId } from "./validate.js";

/**
 * A deliberate refusal with a message that is safe to show the caller.
 * `status` is the HTTP status it maps to. `retryable` tells the page that asking
 * again later can succeed (a payout that has not settled yet), as opposed to a
 * refusal that never will.
 */
export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly retryable: boolean = false,
    /** A stable machine-readable reason, for the page and for tests; the message may change. */
    readonly code?: CheckoutErrorCode,
  ) {
    super(message);
  }
}

export type CheckoutErrorCode =
  | "unknown_checkout"
  | "checkout_closed"
  | "checkout_expired"
  | "checkout_completed"
  | "payment_in_progress"
  | "not_claim_holder"
  | "duplicate_payment"
  | "late_payment"
  | "not_settled";

/**
 * How many unattachable payments one checkout keeps. Each needs real money that
 * settled, so the cap is generous; past it the checkout is flagged and the
 * transfer is logged for an operator.
 */
export const MAX_UNATTACHED_PAYMENTS = 100;

/** The core API answered with something that is not what a decision about a payment can rest on. */
export class CoreResponseError extends Error {}

export const normIban = (s?: string) => (s ?? "").replace(/\s/g, "").toUpperCase();

/**
 * Which of the merchant's settlement accounts this payment lands in.
 *
 * Unnamed means the default (first registered). Named means it must be on the
 * allowlist — a merchant cannot invent a destination, so a leaked client id
 * cannot redirect a user's money to an account we never agreed to pay.
 */
export function resolveDestination(merchant: Merchant, requested?: string): string {
  if (!merchant.settlementIbans.length) {
    throw new CheckoutError("merchant has no registered settlement account");
  }
  if (!requested) return merchant.settlementIbans[0];
  const want = normIban(requested);
  const match = merchant.settlementIbans.find((i) => normIban(i) === want);
  if (!match) {
    // Deliberately does not echo the registered accounts back: the caller is
    // authenticated, but the error travels further than the caller.
    throw new CheckoutError("destination_iban is not a registered settlement account for this client");
  }
  return match;
}

/** Constant-time client-secret check against the stored hash. */
export function clientSecretMatches(merchant: Merchant, provided: unknown): boolean {
  return secretMatchesHash(provided, merchant.clientSecretHash);
}

/**
 * A payer id that is stable for one merchant and useless to any other.
 *
 * The merchant needs to recognise a returning customer — for limits, for
 * fraud, for support — without us handing every merchant a shared identifier
 * they could join across. HMAC over (merchant, user) gives them a stable
 * handle that cannot be correlated with another merchant's.
 */
export function payerSubject(merchantId: string, userId: string): string {
  return createHmac("sha256", CONFIG.subjectSecret)
    .update(`${merchantId}\0${userId}`)
    .digest("base64url")
    .slice(0, 32);
}

/** The fields of a core-API transfer that a checkout decision depends on. */
export interface CoreTransfer {
  id: string;
  userId: string;
  rail: string;
  state: string;
  recipientIban?: string;
  receiveEur?: number;
  /** The payment reference the payer's transfer was created with. */
  reference?: string;
}

/**
 * Check a core API reply is a transfer we can decide on, and is the one we asked
 * for. The core is trusted to be right, not to be well-formed: a reply with no id
 * or no amount must stop the attach, not slide through a comparison against
 * `undefined`.
 */
export function parseCoreTransfer(raw: unknown, expectedId: string): CoreTransfer {
  const t = raw as Record<string, unknown> | null;
  const bad = (why: string) => new CoreResponseError(`unexpected response from the Zold API (${why})`);
  if (!t || typeof t !== "object" || Array.isArray(t)) throw bad("not a transfer");
  if (t.id !== expectedId) throw bad("a different transfer");
  // userId becomes a path segment on the next core call.
  if (typeof t.userId !== "string" || !isId(t.userId)) throw bad("no usable user id");
  if (typeof t.rail !== "string" || typeof t.state !== "string") throw bad("no rail or state");
  if (typeof t.receiveEur !== "number" || !Number.isFinite(t.receiveEur)) throw bad("no amount");
  return {
    id: t.id,
    userId: t.userId,
    rail: t.rail,
    state: t.state,
    ...(typeof t.recipientIban === "string" ? { recipientIban: t.recipientIban } : {}),
    receiveEur: t.receiveEur,
    ...(typeof t.reference === "string" ? { reference: t.reference } : {}),
  };
}

/**
 * The reference the payer's SEPA transfer must carry for this checkout: the
 * merchant's own (so it reconciles on their statement) plus the checkout's
 * unique part (so the payment can only ever belong to this checkout).
 */
export function transferReference(intent: { reference: string; payRef: string }): string {
  return intent.reference ? `${intent.reference} ${intent.payRef}` : intent.payRef;
}

/** Whole cents, so amounts are compared exactly instead of within a float tolerance. */
export const toCents = (eur: unknown): number =>
  typeof eur === "number" && Number.isFinite(eur) ? Math.round(eur * 100) : Number.NaN;

/** Milliseconds since `iso`; a date that cannot be read counts as infinitely old, never as fresh. */
const ageMs = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
};

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
    clientSecretHash: hashSecret("demo-secret"),
    // Two accounts so the per-transaction selection is exercisable locally.
    settlementIbans: [ibanTarget, "DE02120300000000202051"],
    redirectUris: ["*"],
    webhookUrl: undefined,
    createdAt: new Date().toISOString(),
  });
}

/** A wildcard redirect is a local-demo convenience; a hosted deployment must not carry one. */
export function assertNoWildcardRedirects(merchants: readonly Merchant[]): void {
  const bad = merchants.find((m) => m.redirectUris.includes("*"));
  if (bad) {
    throw new Error(`merchant "${bad.name}" has a wildcard redirect URI (*), which is only allowed for the local demo`);
  }
}

export function redirectAllowed(merchant: Merchant, redirectUri: string): boolean {
  return merchant.redirectUris.includes("*") || merchant.redirectUris.includes(redirectUri);
}

export function createIntent(
  merchant: Merchant,
  args: {
    amountEur: number;
    reference: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    /** Must be on the merchant's allowlist; omitted means the default. */
    destinationIban?: string;
    /** "front" for the unauthenticated GET; the authenticated back channel is the default. */
    channel?: "front" | "back";
  },
  maxPending?: number,
): PaymentIntent {
  // Intent creation is reachable with only the public client_id (the front
  // channel), so the number of open checkouts per merchant is capped, and each
  // channel is counted on its own: a full front channel must not stop the
  // merchant's own authenticated checkouts.
  const channel = args.channel ?? "back";
  const cap = maxPending ?? (channel === "front" ? CONFIG.maxPendingFrontIntents : CONFIG.maxPendingIntents);
  if (store.pendingCount(merchant.id, channel) >= cap) {
    throw new CheckoutError("too many pending checkouts for this merchant, try again shortly");
  }
  const now = new Date().toISOString();
  return store.addPaymentIntent({
    id: randomUUID(),
    merchantId: merchant.id,
    amountEur: args.amountEur,
    reference: args.reference,
    payRef: newPayRef(),
    channel,
    destinationIban: resolveDestination(merchant, args.destinationIban),
    redirectUri: args.redirectUri,
    state: args.state,
    codeChallenge: args.codeChallenge,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  });
}

/** Past the time limit for STARTING a payment. A payment already made can still be attached for a while longer. */
export function isIntentExpired(intent: PaymentIntent): boolean {
  return ageMs(intent.createdAt) > INTENT_TTL_MS;
}

const inProgressError = (): CheckoutError =>
  new CheckoutError("this checkout is already being paid in another window or device", 409, false, "payment_in_progress");
const expiredError = (): CheckoutError => new CheckoutError("checkout expired", 410, false, "checkout_expired");

/**
 * Claim an open checkout for one payer BEFORE any money moves. Two tabs or two
 * devices that both loaded the checkout would otherwise each create and authorize
 * a transfer: the first attach wins and the second payment still reaches the
 * merchant, where we cannot recall it. Only the claim holder's page goes on to pay.
 *
 * A claim does not time out on its own while the checkout can still be attached:
 * a tab that went quiet may be mid-payment, and handing the checkout to someone
 * else then is exactly the double payment this prevents. The holder releases it
 * when its payment surely did not happen; otherwise it ends with the checkout.
 *
 * The page makes the claim token and keeps it before asking, so a claim whose
 * answer was lost is simply asked for again with the same token. The holder may
 * claim again with it (a retry, or a reload of the same tab) while the checkout
 * can still be started. Nobody else may, not even another tab of the same payer.
 */
export function claimIntent(intentId: string, userId: string, claimToken: string): void {
  const intent = store.findPaymentIntent(intentId);
  if (!intent) throw new CheckoutError("unknown checkout", 404, false, "unknown_checkout");
  if (intent.status === "PAYING") {
    const holder = intent.claimUserId === userId && secretMatchesHash(claimToken, intent.claimTokenHash);
    if (!holder) throw inProgressError();
    if (isIntentExpired(intent)) throw expiredError();
    return;
  }
  if (intent.status !== "PENDING") {
    throw new CheckoutError(`checkout already ${intent.status.toLowerCase()}`, 409, false, "checkout_closed");
  }
  if (isIntentExpired(intent)) throw expiredError();
  store.updatePaymentIntent(intent.id, {
    status: "PAYING",
    claimUserId: userId,
    claimTokenHash: hashSecret(claimToken),
    claimedAt: new Date().toISOString(),
  });
}

/**
 * Give the checkout back, for a payment that surely did not happen (the passkey
 * was cancelled, or the core refused the authorization). Only the holder can, and
 * only before a payment is attached.
 */
export function releaseClaim(intentId: string, claimToken: string): void {
  const intent = store.findPaymentIntent(intentId);
  if (!intent) throw new CheckoutError("unknown checkout", 404, false, "unknown_checkout");
  if (intent.status !== "PAYING") {
    throw new CheckoutError(`checkout already ${intent.status.toLowerCase()}`, 409, false, "checkout_closed");
  }
  if (!secretMatchesHash(claimToken, intent.claimTokenHash)) {
    throw new CheckoutError("this window does not hold the payment for this checkout", 403, false, "not_claim_holder");
  }
  store.updatePaymentIntent(intent.id, {
    status: "PENDING",
    claimUserId: undefined,
    claimTokenHash: undefined,
    claimedAt: undefined,
  });
}

/**
 * Payout states of a SEPA transfer that count as a completed checkout. (The
 * core's PAYOUT_READY / PAYOUT_FUNDED belong to the cash rail only.)
 * PAYOUT_SUBMITTED is not final: it can still end FAILED, REFUNDED or in manual
 * review, so it attaches as AUTHORIZED, and settle.ts moves it to PAID or FAILED
 * once Zold says the payout is final. AUTHORIZED is not proof of final payment.
 */
const SETTLED = new Set(["PAYOUT_SUBMITTED", "PAID"]);

/** The payout can still settle while the payer waits, so the page asks again. */
const notSettledError = (state: string): CheckoutError =>
  new CheckoutError(`transfer not settled (state ${state})`, 409, true, "not_settled");

/** Transfer states that mean the money did not, or may not, reach the merchant. */
const FAILED_STATES: Record<string, string> = {
  FAILED: "transfer failed",
  REFUNDED: "transfer refunded",
  MANUAL_REVIEW: "transfer is in manual review",
};

/**
 * Why `transfer` was not made for `intent`, or undefined if it was: it is a SEPA
 * payout of exactly this amount, into the account pinned on this intent, carrying
 * this checkout's own reference.
 */
function mismatchWithCheckout(intent: PaymentIntent, transfer: CoreTransfer): string | undefined {
  if (transfer.rail !== "sepa") return "checkout transfer must be a SEPA payout";
  // Against the destination pinned on THIS intent, not the merchant's current
  // allowlist: an account removed from the allowlist mid-checkout must not
  // invalidate a payment the user has already signed, and an account added
  // mid-checkout must not become payable for an intent that never named it.
  // Both sides must name an account: an empty pin must never match an empty recipient.
  const pinned = normIban(intent.destinationIban);
  if (!pinned || normIban(transfer.recipientIban) !== pinned) {
    return "transfer does not pay the account this checkout was created for";
  }
  if (toCents(transfer.receiveEur) !== toCents(intent.amountEur)) return "transfer amount does not match the checkout";
  // The core stores the reference exactly as the checkout page sent it, so a
  // plain comparison is safe. It is required, never optional: the checkout's own
  // part is unique, so only a payment made FOR this checkout can match. Without
  // it, an older payment to the same account for the same amount could be
  // attached to a new checkout and the merchant told "paid" for money it had
  // already counted.
  if (transfer.reference !== transferReference(intent)) return "transfer payment reference does not match the checkout";
  return undefined;
}

/**
 * Keep a settled payment that was made for this checkout but cannot be attached
 * to it. The money has left the payer and a SEPA payout cannot be recalled by us,
 * so it is recorded on the checkout (once) for the merchant to see and refund.
 *
 * "not_ours": not made for this checkout, failed, or the one already attached.
 * "not_settled": made for it but has not moved money yet; never recorded, so a
 * draft can never have the merchant refund a payment that did not happen.
 */
function recordUnattached(
  intent: PaymentIntent,
  transfer: CoreTransfer,
  reason: UnattachedReason,
): "recorded" | "not_settled" | "not_ours" {
  if (mismatchWithCheckout(intent, transfer) || FAILED_STATES[transfer.state] || transfer.id === intent.transferId) {
    return "not_ours";
  }
  if (!SETTLED.has(transfer.state)) return "not_settled";
  const kept = intent.unattachedPayments ?? [];
  if (kept.some((p) => p.transferId === transfer.id)) return "recorded";
  if (kept.length >= MAX_UNATTACHED_PAYMENTS) {
    console.error(`checkout ${intent.id}: unattached payment ${transfer.id} not kept, the list is full`);
    if (!intent.unattachedPaymentsTruncated) store.updatePaymentIntent(intent.id, { unattachedPaymentsTruncated: true });
    return "recorded";
  }
  const entry: UnattachedPayment = { transferId: transfer.id, reason, state: transfer.state, recordedAt: new Date().toISOString() };
  store.updatePaymentIntent(intent.id, { unattachedPayments: [...kept, entry] });
  return "recorded";
}

const duplicateError = (): CheckoutError =>
  new CheckoutError(
    "this checkout was already paid; your second payment is recorded and the merchant will refund it",
    409,
    false,
    "duplicate_payment",
  );
const lateError = (): CheckoutError =>
  new CheckoutError(
    "this checkout closed before your payment arrived; your payment is recorded and the merchant will refund it",
    409,
    false,
    "late_payment",
  );

/**
 * Attach a user's authorized transfer to an intent and mint the one-time code.
 * Refuses unless the transfer pays the merchant's IBAN, matches the intent
 * amount and this checkout's own payment reference, and has actually left
 * CREATED (i.e. the device signature cleared) — so a merchant can never be told
 * "paid" for a transfer that was never authorized, or that was made for
 * something else. That the transfer belongs to the caller is established before
 * we get here, by reading it from the core API with the caller's own session.
 *
 * Takes the intent's id and reads it fresh: the caller has been waiting on the
 * network, and a record fetched before that wait may be out of date.
 *
 * Safe to call again for the same transfer until the merchant has exchanged the
 * code. That is how a payer recovers when the first response was lost: the
 * money has moved, so they must be able to get back to the merchant, and the
 * earlier code is replaced so there is only ever one live.
 */
export function attachTransfer(intentId: string, transfer: CoreTransfer, payerName?: string): { redirectUrl: string } {
  const intent = store.findPaymentIntent(intentId);
  if (!intent) throw new CheckoutError("unknown checkout", 404, false, "unknown_checkout");
  const open = intent.status === "PENDING" || intent.status === "PAYING";
  if (!open) {
    const sameAttach =
      (intent.status === "AUTHORIZED" || intent.status === "PAID") &&
      intent.transferId === transfer.id &&
      intent.userId === transfer.userId;
    if (!sameAttach) {
      const paid = intent.status === "AUTHORIZED" || intent.status === "PAID";
      if (paid || intent.status === "EXPIRED") {
        const outcome = recordUnattached(intent, transfer, paid ? "duplicate" : "late");
        if (outcome === "recorded") throw paid ? duplicateError() : lateError();
        if (outcome === "not_settled" && paid) throw notSettledError(transfer.state);
      }
      if (intent.status === "EXPIRED") throw new CheckoutError("checkout expired", 400, false, "checkout_expired");
      throw new CheckoutError(`intent already ${intent.status.toLowerCase()}`, 400, false, "checkout_closed");
    }
    if (intent.statusTokenHash) throw new CheckoutError("checkout already completed", 400, false, "checkout_completed");
  } else if (ageMs(intent.createdAt) > INTENT_TTL_MS + ATTACH_GRACE_MS) {
    // Too late to attach, but a settled payment made for it must not be lost.
    store.updatePaymentIntent(intent.id, { status: "EXPIRED" });
    if (recordUnattached(intent, transfer, "late") === "recorded") throw lateError();
    throw new CheckoutError("checkout expired", 400, false, "checkout_expired");
  } else if (intent.status === "PAYING" && intent.claimUserId !== transfer.userId) {
    // Paid by someone who does not hold the claim: the holder may still finish.
    const outcome = recordUnattached(intent, transfer, "claimed_by_another");
    if (outcome === "recorded") throw duplicateError();
    if (outcome === "not_settled") throw notSettledError(transfer.state);
    throw inProgressError();
  }
  const merchant = store.findMerchant(intent.merchantId);
  if (!merchant) throw new CheckoutError("merchant not found");
  const mismatch = mismatchWithCheckout(intent, transfer);
  if (mismatch) throw new CheckoutError(mismatch);
  const failure = FAILED_STATES[transfer.state];
  if (failure) throw new CheckoutError(failure);
  if (!SETTLED.has(transfer.state)) {
    // Not final: the payout can still settle while the payer waits, so the page retries.
    throw notSettledError(transfer.state);
  }
  // One payment, one checkout. Without this a single transfer could be attached
  // to any number of matching intents, and the merchant would be handed a code
  // (and a "paid" status) for each. Checked in the same synchronous block as the
  // update below, so two concurrent attaches cannot both pass.
  const alreadyUsed = store.findPaymentIntentByTransfer(transfer.id);
  if (alreadyUsed && alreadyUsed.id !== intent.id) {
    throw new CheckoutError("this transfer already paid another checkout");
  }

  const code = newToken();
  // A retried attach can carry a state read before settlement moved this checkout
  // to PAID (settle.ts); PAID is final, so it is never lowered.
  const status: PaymentIntent["status"] = intent.status === "PAID" || transfer.state === "PAID" ? "PAID" : "AUTHORIZED";
  store.updatePaymentIntent(intent.id, {
    status,
    userId: transfer.userId,
    transferId: transfer.id,
    codeHash: hashSecret(code),
    codeExpiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    payerSub: payerSubject(intent.merchantId, transfer.userId),
    payerName: payerName ?? intent.payerName,
    // The claim has done its job: the checkout is paid.
    claimUserId: undefined,
    claimTokenHash: undefined,
    claimedAt: undefined,
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

export interface MerchantIntentView extends IntentStatusView {
  /** Which of the merchant's settlement accounts this payment lands in. */
  destinationIban: string;
  payer?: {
    /** Stable for this merchant, uncorrelatable with any other merchant's. */
    sub: string;
    /** Legal name of the payer, for evidencing a first-party top-up. */
    name?: string;
  };
  /**
   * Settled payments made for this checkout that could not be attached: a second
   * payment, one by someone who did not hold the checkout, or one that arrived
   * after it closed. Refund them, after checking the money arrived: `state` is as
   * recorded, and PAYOUT_SUBMITTED can still fail.
   */
  unattachedPayments?: (UnattachedPayment & { amountEur: number })[];
  /** More arrived than are listed; ask Zold support for the rest. */
  unattachedPaymentsTruncated?: boolean;
}

/**
 * What the checkout PAGE may see. Reached by an unauthenticated GET — it is a
 * redirect target the user has just landed on — so it carries no payer data.
 * Adding a field here publishes it to anyone holding an intent id.
 */
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
 * What the MERCHANT may see, once it has proved itself with its client secret
 * and the PKCE verifier. Includes the payer identity they were granted.
 */
export function merchantView(intent: PaymentIntent, includeName = false): MerchantIntentView {
  return {
    ...statusView(intent),
    destinationIban: intent.destinationIban,
    ...(intent.payerSub
      ? { payer: { sub: intent.payerSub, ...(includeName && intent.payerName ? { name: intent.payerName } : {}) } }
      : {}),
    ...(intent.unattachedPayments?.length
      ? { unattachedPayments: intent.unattachedPayments.map((p) => ({ ...p, amountEur: intent.amountEur })) }
      : {}),
    ...(intent.unattachedPaymentsTruncated ? { unattachedPaymentsTruncated: true } : {}),
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
): MerchantIntentView & { statusToken: string } {
  const merchant = store.findMerchantByClientId(clientId);
  if (!merchant || !clientSecretMatches(merchant, clientSecret)) throw new CheckoutError("bad client credentials");
  const intent = store.findPaymentIntentByCode(code);
  if (!intent || intent.merchantId !== merchant.id) throw new CheckoutError("unknown or used code");
  // Written so that an unreadable date (NaN) counts as expired, not as valid.
  if (!intent.codeExpiresAt || !(Date.parse(intent.codeExpiresAt) >= Date.now())) {
    // An expired code is dead: burn it, and drop the payer name it was guarding.
    store.updatePaymentIntent(intent.id, { codeHash: undefined, codeExpiresAt: undefined, payerName: undefined });
    throw new CheckoutError("code expired");
  }
  if (!safeEqual(pkceChallenge(codeVerifier), intent.codeChallenge)) throw new CheckoutError("PKCE verification failed");

  const statusToken = newToken();
  // The name is returned in THIS response only, then deleted with the code.
  const view = merchantView(intent, true);
  store.updatePaymentIntent(intent.id, {
    codeHash: undefined,
    codeExpiresAt: undefined,
    payerName: undefined,
    statusTokenHash: hashSecret(statusToken),
  });
  return { ...view, statusToken };
}

export function statusByToken(intentId: string, statusToken: string): MerchantIntentView {
  const intent = store.findPaymentIntent(intentId);
  if (!intent || !secretMatchesHash(statusToken, intent.statusTokenHash)) {
    throw new CheckoutError("unknown intent or bad token");
  }
  return merchantView(intent);
}
