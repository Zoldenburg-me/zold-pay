/**
 * Settle a checkout: move it from AUTHORIZED to PAID or FAILED once its payout
 * is final.
 *
 * A checkout is AUTHORIZED when its payment is attached while the SEPA payout is
 * still PAYOUT_SUBMITTED, which can still end FAILED, REFUNDED or in manual
 * review. The payer has gone by then, so the transfer is read with this
 * service's own credential instead of their session: Zold's
 * GET /api/service/checkout/transfers/:id, which answers only for transfers
 * carrying a checkout reference.
 *
 * A poller reads every AUTHORIZED checkout, backing off while a payout is still
 * moving. Zold's webhook (zold-webhook.ts) only says "read this one now": it
 * makes that checkout due on the poller's next tick, so a burst of deliveries
 * still gets the batch limit and the stop on 401/429/503. It is never believed
 * about a state.
 *
 * Only AUTHORIZED moves. PAID is final here, and a transfer that does not match
 * the checkout it is attached to is logged and left alone, never settled.
 */
import { CoreResponseError, normIban, toCents, transferReference } from "./checkout.js";
import { CONFIG } from "./config.js";
import { core, type CoreError } from "./core.js";
import { store } from "./store.js";

/** The fields of Zold's service view that settlement decides on. */
export interface ServiceTransfer {
  id: string;
  state: string;
  rail: string;
  receiveEur: number;
  reference: string;
  /** The payee IBAN's last four characters; the service view never has more. */
  recipientLast4?: string;
}

export type SettleOutcome = "paid" | "failed" | "pending" | "mismatch" | "skipped";

export interface SettleOptions {
  log?: (...args: unknown[]) => void;
}

/** Reads one transfer from Zold by id; rejects with a CoreError on a non-2xx. */
export type ReadTransfer = (transferId: string) => Promise<unknown>;

/**
 * Zold's payout states that end a checkout. Anything else, known or new, waits.
 * A Map, not an object: a state named "constructor" must not find a prototype key.
 */
const FINAL = new Map<string, "PAID" | "FAILED">([
  ["PAID", "PAID"],
  ["FAILED", "FAILED"],
  ["REFUNDED", "FAILED"],
]);

/** `…3000` as Zold writes it, with or without the ellipsis. */
const LAST_FOUR = /^…?([A-Za-z0-9]{4})$/;

/**
 * Check a reply is the transfer we asked for and has what a decision needs. Zold
 * is trusted to be right, not to be well-formed.
 */
export function parseServiceTransfer(raw: unknown, expectedId: string): ServiceTransfer {
  const t = raw as Record<string, unknown> | null;
  const bad = (why: string) => new CoreResponseError(`unexpected response from the Zold API (${why})`);
  if (!t || typeof t !== "object" || Array.isArray(t)) throw bad("not a transfer");
  if (t.id !== expectedId) throw bad("a different transfer");
  if (typeof t.state !== "string" || typeof t.rail !== "string") throw bad("no rail or state");
  if (typeof t.receiveEur !== "number" || !Number.isFinite(t.receiveEur)) throw bad("no amount");
  if (typeof t.reference !== "string") throw bad("no reference");
  const last4 = typeof t.recipientIban === "string" ? LAST_FOUR.exec(t.recipientIban)?.[1] : undefined;
  return {
    id: t.id,
    state: t.state,
    rail: t.rail,
    receiveEur: t.receiveEur,
    reference: t.reference,
    ...(last4 ? { recipientLast4: last4.toUpperCase() } : {}),
  };
}

/**
 * Apply what Zold says about a checkout's transfer. Reads the checkout fresh: the
 * caller has been waiting on the network.
 */
export function applySettlement(intentId: string, transfer: ServiceTransfer, opts: SettleOptions = {}): SettleOutcome {
  const log = opts.log ?? console.error;
  const intent = store.findPaymentIntent(intentId);
  if (!intent || intent.status !== "AUTHORIZED" || intent.transferId !== transfer.id) return "skipped";
  const why = mismatch(intent, transfer);
  if (why) {
    log(`checkout ${intent.id}: transfer ${transfer.id} not settled, ${why}`);
    return "mismatch";
  }
  const final = FINAL.get(transfer.state);
  if (!final) return "pending";
  store.updatePaymentIntent(intent.id, { status: final });
  return final === "PAID" ? "paid" : "failed";
}

/** The attach already checked all of this; checked again so a wrong answer can never settle a checkout. */
function mismatch(
  intent: { destinationIban: string; amountEur: number; reference: string; payRef: string },
  t: ServiceTransfer,
): string | undefined {
  if (t.rail !== "sepa") return "not a SEPA payout";
  if (t.reference !== transferReference(intent)) return "a different payment reference";
  if (toCents(t.receiveEur) !== toCents(intent.amountEur)) return "a different amount";
  const pinned = normIban(intent.destinationIban);
  if (!pinned || !t.recipientLast4 || pinned.slice(-4) !== t.recipientLast4) return "a different account";
  return undefined;
}

/** Read one AUTHORIZED checkout's transfer and apply it. Does not read for any other status. */
export async function settleIntent(intentId: string, read: ReadTransfer, opts: SettleOptions = {}): Promise<SettleOutcome> {
  const intent = store.findPaymentIntent(intentId);
  if (!intent || intent.status !== "AUTHORIZED" || !intent.transferId) return "skipped";
  const transferId = intent.transferId;
  const transfer = parseServiceTransfer(await read(transferId), transferId);
  return applySettlement(intentId, transfer, opts);
}

/** Zold's checkout-service read, with this service's credential. */
export function zoldTransferReader(token: string = CONFIG.zoldServiceToken): ReadTransfer {
  return (transferId) =>
    core(`/api/service/checkout/transfers/${encodeURIComponent(transferId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
}

/**
 * Answers that end the tick, because the next read would get the same: 401, our
 * credential is wrong or expired; 503, Zold has none issued; 429, we are over
 * Zold's rate limit and more reads would only keep us there.
 */
const STOP_STATUSES = new Map<number, string>([
  [401, "Zold refused the service credential"],
  [503, "Zold has no service credential issued"],
  [429, "Zold is rate-limiting the service credential"],
]);

/** A stalled poller is reported on its first stopped tick and every this many after. */
const STALL_REPORT_EVERY = 10;
/** An AUTHORIZED checkout older than this is reported, and again each time this passes. */
const STUCK_AFTER_MS = 24 * 60 * 60_000;

export interface SettlePollerOptions extends SettleOptions {
  read: ReadTransfer;
  /** Wait after the first read of a payout that is still moving; doubles each time. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Most transfers read per tick, so a backlog stays under Zold's per-credential rate limit. */
  batch: number;
}

/**
 * Operators find trouble by the uppercase tokens: SETTLE_STALLED (no reads can
 * work: credential, rate limit, Zold down), SETTLE_RECOVERED, SETTLE_STUCK (a
 * checkout AUTHORIZED for over a day, with Zold's last state), SETTLE_REVIEW
 * (Zold put a payout in manual review), SETTLE_MISMATCH (once per checkout) and
 * SETTLE_STORE_WRITE_FAILED (Zold said final, we could not save it).
 */
export function createSettlePoller(opts: SettlePollerOptions) {
  const log = opts.log ?? console.error;
  /** Per checkout: when to read next and the wait after that. In memory, so a restart reads everything once. */
  const backoff = new Map<string, { dueAt: number; delayMs: number }>();
  /** Checkouts the webhook asked about during a read: the read's answer may predate the change. */
  const nudged = new Set<string>();
  const lastState = new Map<string, string>();
  const stuckReportedAt = new Map<string, number>();
  const mismatchReported = new Set<string>();
  let running = false;
  let rerun = false;
  let stalledTicks = 0;
  let stalledSince = 0;

  const forget = (id: string) => {
    backoff.delete(id);
    nudged.delete(id);
    lastState.delete(id);
    stuckReportedAt.delete(id);
    mismatchReported.delete(id);
  };

  const later = (id: string, now: number) => {
    if (nudged.delete(id)) {
      // Zold said it changed while we were reading: read again at once.
      backoff.set(id, { dueAt: 0, delayMs: opts.baseDelayMs });
      return;
    }
    const delayMs = Math.min(backoff.get(id)?.delayMs ?? opts.baseDelayMs, opts.maxDelayMs);
    backoff.set(id, { dueAt: now + delayMs, delayMs: Math.min(delayMs * 2, opts.maxDelayMs) });
  };

  const noteState = (id: string, transferId: string, state: string) => {
    const before = lastState.get(id);
    lastState.set(id, state);
    if (state === "MANUAL_REVIEW" && before !== state) {
      log(`SETTLE_REVIEW checkout ${id}: transfer ${transferId} is in manual review at Zold`);
    }
  };

  const reportStuck = (awaiting: readonly { id: string; createdAt: string }[], now: number) => {
    for (const i of awaiting) {
      const age = now - Date.parse(i.createdAt);
      if (!(age > STUCK_AFTER_MS)) continue;
      if (now - (stuckReportedAt.get(i.id) ?? Number.NEGATIVE_INFINITY) < STUCK_AFTER_MS) continue;
      stuckReportedAt.set(i.id, now);
      const hours = Math.floor(age / 3_600_000);
      log(`SETTLE_STUCK checkout ${i.id} AUTHORIZED for ${hours}h (Zold state ${lastState.get(i.id) ?? "not read yet"})`);
    }
  };

  /** One pass over what is due. Returns why it stopped early, if it did. */
  async function pass(now: number): Promise<{ checked: number; stopped?: string }> {
    const awaiting = store.intentsAwaitingSettlement();
    const live = new Set(awaiting.map((i) => i.id));
    for (const id of backoff.keys()) if (!live.has(id)) forget(id);
    reportStuck(awaiting, now);
    const due = awaiting
      .map((i) => ({ id: i.id, transferId: i.transferId as string, dueAt: backoff.get(i.id)?.dueAt ?? 0 }))
      .filter((d) => d.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, opts.batch);
    let checked = 0;
    for (const { id, transferId } of due) {
      checked++;
      // A nudge from before this read is answered by it; one during it is not.
      nudged.delete(id);
      let transfer: ServiceTransfer;
      try {
        transfer = parseServiceTransfer(await opts.read(transferId), transferId);
      } catch (err) {
        const stop = stopReason(err);
        if (stop) return { checked, stopped: stop };
        log(`checkout settle: checkout ${id} not read: ${describe(err)}`);
        later(id, now);
        continue;
      }
      noteState(id, transferId, transfer.state);
      let outcome: SettleOutcome;
      try {
        outcome = applySettlement(id, transfer, {
          log: (msg) => {
            if (mismatchReported.has(id)) return;
            mismatchReported.add(id);
            log(`SETTLE_MISMATCH ${String(msg)}`);
          },
        });
      } catch (err) {
        // Zold has answered; only our write failed. Not Zold's fault, so no
        // backoff: it is due again on the next tick.
        log(`SETTLE_STORE_WRITE_FAILED checkout ${id}: Zold says ${transfer.state}, not saved: ${(err as Error)?.message ?? String(err)}`);
        backoff.delete(id);
        continue;
      }
      if (outcome === "paid" || outcome === "failed" || outcome === "skipped") forget(id);
      else later(id, now);
    }
    return { checked };
  }

  /**
   * Read what is due. Never two at once: a tick asked for while one runs makes
   * the running one go round again, so a webhook during a long tick is not lost.
   */
  async function tick(now?: number): Promise<{ checked: number; stopped: boolean }> {
    if (running) {
      rerun = true;
      return { checked: 0, stopped: false };
    }
    running = true;
    try {
      let checked = 0;
      let stopped: string | undefined;
      do {
        rerun = false;
        const at = now ?? Date.now();
        const result = await pass(at);
        checked += result.checked;
        stopped = result.stopped;
      } while (rerun && !stopped);
      reportStall(stopped, now ?? Date.now());
      return { checked, stopped: !!stopped };
    } finally {
      running = false;
    }
  }

  const reportStall = (stopped: string | undefined, now: number) => {
    if (!stopped) {
      if (stalledTicks > 0) log(`SETTLE_RECOVERED after ${stalledTicks} stopped ticks`);
      stalledTicks = 0;
      return;
    }
    if (stalledTicks === 0) stalledSince = now;
    stalledTicks++;
    if (stalledTicks === 1 || stalledTicks % STALL_REPORT_EVERY === 0) {
      log(`SETTLE_STALLED ${stopped}; ${stalledTicks} ticks stopped since ${new Date(stalledSince).toISOString()}`);
    }
  };

  /**
   * Make the checkout this transfer is attached to due now (the webhook). True
   * when there is an AUTHORIZED one, so the caller knows a tick is worth running.
   */
  function nudge(transferId: string): boolean {
    const intent = store.findPaymentIntentByTransfer(transferId);
    if (!intent || intent.status !== "AUTHORIZED") return false;
    backoff.set(intent.id, { dueAt: 0, delayMs: opts.baseDelayMs });
    nudged.add(intent.id);
    return true;
  }

  return { tick, nudge, waiting: () => backoff.size };
}

function isCoreError(err: unknown): err is CoreError {
  return err instanceof Error && typeof (err as Partial<CoreError>).status === "number";
}

/** fetch reports an unreachable host as TypeError("fetch failed"); our own TypeErrors are not that. */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  return err instanceof TypeError && err.message === "fetch failed";
}

/** Why no further read this tick can work, or undefined to go on with the next one. */
function stopReason(err: unknown): string | undefined {
  if (isCoreError(err)) {
    const why = STOP_STATUSES.get(err.status);
    return why ? `${why} (HTTP ${err.status})` : undefined;
  }
  // Zold down or unreachable: fifty reads in a row would each wait out the timeout.
  return isNetworkError(err) ? describe(err) : undefined;
}

/** Never the core's own text: it is not ours to put in a log line. */
function describe(err: unknown): string {
  if (isCoreError(err)) return `HTTP ${err.status}`;
  if (err instanceof CoreResponseError) return err.message;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "Zold API timed out";
  if (isNetworkError(err)) return "Zold API unreachable";
  return `local error: ${(err as Error)?.message ?? String(err)}`;
}
