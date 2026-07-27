# Real-browser checklist (WebAuthn)

`npm run onboard:test` covers everything except the two WebAuthn ceremonies.
Those never resolve in an embedded preview pane, so they are checked by hand,
in Chrome or Safari, against a real authenticator (Touch ID, a phone, or a
security key).

## Setup

1. Main repo: `npm run dev`, with

   ```
   RP_ID=localhost
   WEBAUTHN_ORIGINS=http://localhost:3000,http://localhost:3100
   ```

   Add `KYC_AUTO_APPROVE=0` to exercise the pending-KYC screens.

2. Here: `ALLOW_DEV_SHORTCUTS=1` in `.env`, then `npm start`.

3. Create an intent and open
   `http://localhost:3100/checkout?intent=<id>` — see the README for the
   `curl`. Use a **fresh browser profile** for each new-user run; a device key
   left over from a previous account is refused by design.

## New user

| # | Step | Expect |
|---|---|---|
| 1 | Land on the checkout | Amount and merchant name render; two buttons |
| 2 | "New to Zold" → fill details → Continue | Passkey step; the step dots advance |
| 3 | "Create passkey" | A real OS prompt (Touch ID / phone / key). Not a hang. |
| 4 | Approve it | Moves to the identity step with no error |
| 5 | Check the amber note | It should be **absent** on a PRF-capable authenticator. If it appears, that authenticator has no PRF and the device key is stored unwrapped — note which authenticator. |
| 6 | Approve KYC (demo button) | Moves to the spending-key step |
| 7 | "Create spending key" | A **second** OS prompt — this is the step-up the core requires before binding |
| 8 | Approve it | Moves to "Add money" |
| 9 | Read the funding copy | States the shortfall, the fee, and shows the IBAN |
| 10 | "Simulate a deposit" | Balance updates; moves to the pay step |
| 11 | "Confirm with passkey" | On a PRF authenticator, a **third** prompt — this is the device key being unwrapped to sign |
| 12 | Approve it | "Payment sent", then a redirect to the merchant with `code` and `state` in the query |

## The PRF question — check this before trusting the wrap

Still unverified against a real authenticator, and it decides whether a wrapped
key survives a reload:

- **Is PRF offered at all?** If step 5 shows the amber note, no.
- **Does it return the same 32 bytes every time?** After step 12, **reload the
  page and pay a second intent**. If the second payment fails to unlock the
  device key, PRF is not stable across ceremonies and the wrapped key is
  unrecoverable after a reload. That is a blocker for the wrap, not a bug in
  this page.

## Existing user, same origin

1. Fresh tab, new intent, same browser profile as a completed run.
2. "I have a Zold account" → the passkey prompt appears with no username.
3. It should quote, check the balance, ask for the payment ceremony, and
   redirect.

## Existing user, cross-origin (expected to refuse)

1. Onboard in the consumer app on `localhost:3000`.
2. Open a checkout on `localhost:3100` and sign in with that passkey — the
   passkey **works** (shared RP ID).
3. Confirm the payment fails with *"your spending key was set up in a different
   browser…"*. That refusal is correct: the device key is not on this origin.
   If it instead fails at the signature or with a contract revert, the
   pre-check has regressed.

## Things that should refuse

- **Two accounts, one browser.** Complete a new-user run, then start another
  new-user run in the same profile. The spending-key step must refuse with
  "this browser already holds a spending key for a different Zold account".
- **Expired intent.** Wait 15 minutes, reload — "Checkout expired".
- **Already paid.** Reload a completed intent — "Already paid".
