# Real-browser checklist (WebAuthn)

`npm run check` covers the service (secrets, validation, proxy, the whole
merchant flow against a stub core), and `npm run harness:smoke` covers the wiring
against a running local core. Neither can run a WebAuthn ceremony, and a SEPA
payment needs a live Monerium connection that a local harness cannot provide. So
the payment itself is checked by hand, in Chrome or Safari, against a real
authenticator (Touch ID, a phone, or a security key).

This checkout is for **existing Zold users**. Creating an account (passkey, Safe,
identity check, Monerium) happens in the Zold app.

## Setup

1. An account made in the Zold app, on a chain with a real Monerium sandbox
   connection (for example Base Sepolia), with: a passkey, an **active** Safe,
   approved identity check, a linked Monerium account, and enough balance in the
   Safe for the amount plus the fee.

2. The core must accept this origin for passkeys. In the core's environment:

   ```
   RP_ID=<the same relying-party id the account's passkey was made under>
   WEBAUTHN_ORIGINS=<the app origin>,http://localhost:3100
   ```

   For a real run, serve the checkout from the same origin as the app (ADR 0001)
   so the passkey and the device key are both available.

3. Here: set `CORE_API_URL`, `CHECKOUT_PUBLIC_ORIGIN`, `CHECKOUT_SUBJECT_SECRET`
   and `ZOLD_APP_URL` (see `.env.example`), seed a merchant, then `npm start`.
   `ALLOW_DEV_SHORTCUTS=1` only seeds a local demo merchant (loopback core only).

4. Create an intent (see the README for the `curl`) and open
   `/checkout?intent=<id>`.

## Existing user, one device

| # | Step | Expect |
|---|---|---|
| 1 | Land on the checkout | Amount and merchant name render; one "Sign in and pay" button; a "New to Zold?" link to the app |
| 2 | "Sign in and pay" | A real OS passkey prompt with **no username to type**. Not a hang. |
| 3 | Approve it | Moves to "Preparing…"; the fee and total fill in |
| 4 | *Only if the account has no spending key yet:* a **second** prompt | This is the step-up the core requires to bind a spending key (`authorizer.bind`). Skipped when a key is already bound. |
| 5 | Check for an amber note | **Absent** on a PRF-capable authenticator. If it appears, the device key is stored unwrapped; note which authenticator. |
| 6 | Wait at "Approve on your device…" | Up to three prompts, in this order on a PRF authenticator: (a) unlock the device key to sign the terms, (b) approve the Safe debit, (c) approve the Monerium redeem. Each is its own ceremony. |
| 7 | Approve all of them | "Payment sent", then a redirect to the merchant with `code` and `state` in the query |
| 8 | In the Zold app | The transfer shows `PAYOUT_SUBMITTED`, then `PAID` |
| 9 | As the merchant | Exchange the code (`POST /api/checkout/token`) and get the payment status; a second exchange of the same code is refused |

## The PRF question — check this before trusting the wrap

Still unverified against a real authenticator, and it decides whether a wrapped
key survives a reload:

- **Is PRF offered at all?** If step 5 shows the amber note, no.
- **Does it return the same 32 bytes every time?** After step 7, **reload the
  page and pay a second intent**. If the second payment fails to unlock the
  device key, PRF is not stable across ceremonies and the wrapped key is
  unrecoverable after a reload. That is a blocker for the wrap, not a bug in
  this page.

## Losing the confirmation after paying

The server-side retry and the page's recovery logic are covered by tests with
stubs; this checks it for real, once.

1. Start a checkout and pay it, but stop the checkout service (or block
   `/api/checkout/intents/*/attach` in the browser's network panel) right after
   the last passkey prompt, before the page can confirm with the merchant.
2. The page must say *"Your payment was sent. Do not pay again"*, and the button
   must read **Confirm with merchant**. It must not show the pay form.
3. Reload the tab. The same screen must come back (the transfer is remembered for
   the tab's session).
4. Restore the service and press the button. It must go through to the merchant
   **without** another quote, transfer or passkey prompt, and the merchant's
   first code must no longer work.
5. Open the same checkout link in a second tab: it must say "Already paid".

## Things that should refuse

- **Identity check not approved.** Sign in with an account whose check is pending:
  "Your identity check isn't complete yet…", before any transfer is created.
- **Safe not active.** An account mid-setup: "Your account setup isn't finished…".
- **Not enough balance.** "Not enough balance (€x). Top up in the Zold app…",
  before any transfer is created.
- **Spending key from another browser.** Onboard in the Zold app on a different
  origin, then open a checkout here and sign in. The passkey works (shared RP ID),
  but the payment must stop with *"your spending key was set up in a different
  browser…"*. If it fails later, at the signature or with a contract revert, the
  pre-check has regressed.
- **Two accounts, one browser.** Bind a key for account A through this checkout,
  then sign in as account B in the same profile. It must refuse with "this browser
  already holds a spending key for a different Zold account".
- **A tampered destination.** With a proxy that rewrites the transfer's
  destination commitment, the page must stop with "the signed payout destination
  does not match this merchant — not signing", before any passkey prompt.
- **Expired intent.** Wait 15 minutes, reload — "Checkout expired".
- **Already paid.** Reload a completed intent — "Already paid".
- **Cancelled prompt.** Dismiss any passkey prompt: an error is shown, the button
  comes back, and nothing is sent to the merchant.
