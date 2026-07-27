# Pay with Zold — checkout service

Repo: `tonyzil/pay-with-zold`, alongside `tonyzil/transF`. The directory on disk
is `zold-checkout`, and the main repo's CLAUDE.md calls this "the
checkout-service repo" — same thing.

A hosted checkout page where someone who has never heard of Zold can create an
account and pay a merchant without leaving the flow, and where an existing user
can pay with a passkey and a device signature.

This service is the **authorization server** for the merchant handoff: it owns
the merchant registry, the payment intents, and the PKCE code exchange. It owns
no users, keys or balances — the core Zold API (`services/api` in the main repo)
stays the source of truth for those, and an allowlisted proxy is how the browser
reaches it.

```
merchant ──▶ /api/checkout/authorize ──▶ checkout.zold.app/checkout?intent=…
   (here)                                          │
                                                   ├─ new user: account → KYC → device key → funding → pay
                                                   └─ existing user: passkey → pay
                                                   │        (both via the core API)
merchant ◀── code ── redirect_uri ◀────────────────┘
   │
   └──▶ /api/checkout/token  (code + PKCE verifier + client secret → status)
```

The checkout half briefly lived in the core repo. PR #68 removed it there —
`main`'s CLAUDE.md now says *"Do not rebuild them here — see the checkout-service
repo"* — so `checkout.ts` and the `Merchant`/`PaymentIntent` store are ported
here, with one real change: the core validated a transfer by reading its own
store, and this service reads it back from the core API **with the caller's own
session**, which is also what proves the transfer is theirs.

---

## Origins and the RP ID

This is the decision everything else follows from, so it comes first.

> **Under revision.** What follows describes what is built.
> [ADR 0001](docs/adr/0001-serve-the-checkout-from-the-app-origin.md) proposes
> replacing the two-subdomain layout with path routing on a single origin,
> because the split removes the existing-user path rather than degrading it.
> Do not provision `checkout.zold.app` before reading it.

WebAuthn passkeys are scoped to a **relying-party id**, and the FP4 device key —
the EOA the vault recognises as an account's `authorizer` — lives in **one
origin's localStorage** and is bound **on-chain**. Neither travels across
origins on its own.

**The layout:**

| | |
|---|---|
| Consumer app | `app.zold.app` |
| This service | `checkout.zold.app` |
| Shared `RP_ID` | `zold.app` |
| Core `WEBAUTHN_ORIGINS` | both origins |

**What that buys and what it doesn't:**

- A **new user onboarded here** gets their passkey *and* their device key
  created on this origin. Both halves are in one place. This is the clean case,
  and it is what this service is built for.
- A passkey created here **also works in the consumer app**, because both set
  `rp.id = zold.app`. The **device key does not** — `app.zold.app` has a
  different localStorage. That user has to re-establish a device key there, and
  since only the current authorizer can rotate the binding, they must do it
  from a browser that still holds the original key.
- An **existing user whose keys live on `app.zold.app`** cannot sign here. The
  page detects it (the account's on-chain authorizer will not match anything in
  this browser) and says so, rather than failing at the signature. Making that
  case actually work means redirecting to the app origin for the signing step —
  **out of scope for this build.**

The client never guesses the RP ID from `location.hostname`. It reads it from
the core's `/api/webauthn/challenge` response, so the two stay in step.

Locally this is not a special case: the checkout runs on `localhost:3100` and
the core on `localhost:3000`, two origins under the registrable domain
`localhost`, which is exactly the shape production has.

---

## Running it

You need the core Zold API running first — this service is a client of it.

In the main repo:

```bash
npm run dev
```

Then here:

```bash
cp .env.example .env   # set ALLOW_DEV_SHORTCUTS=1 for a local demo
npm install
npm start
```

Start a checkout as a merchant would, and open the `checkoutUrl` it returns:

```bash
curl -s -H 'accept: application/json' "http://127.0.0.1:3100/api/checkout/authorize?client_id=demo-merchant&amount=40&reference=demo&redirect_uri=https%3A%2F%2Fmony.example%2Fcallback&state=xyz&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
```

`checkoutUrl` is absolute (built from `CHECKOUT_PUBLIC_ORIGIN`), unlike the
core's old relative `/checkout.html?intent=…` — the merchant redirects from its
own origin, where a bare path would resolve against the wrong host.

The `demo-merchant` client is seeded only when `ALLOW_DEV_SHORTCUTS=1`. There is
**no merchant onboarding** yet: registering a real partner means adding a row to
`data/checkout.json` by hand.

---

## The flow, and where it deviates from the handoff

1. **Land** — `GET /api/checkout/intents/:id` gives the merchant name, amount
   and target IBAN.
2. **Details** — name, optional email, country.
3. **Passkey** — `POST /api/users`, then `POST /api/users/:id/passkey` with the
   attestation. Asks for the `prf` extension so the device key can be encrypted;
   if the authenticator has no PRF, the page **says so** instead of implying the
   key is protected.
4. **KYC** — `GET /api/users/:id/kyc`.
5. **Device key** — generated in this browser by `device.js`, bound via
   `POST /api/users/:id/authorizer` with a step-up assertion.
6. **Funding** — the honest step. See below.
7. **Pay** — two quotes (the first reveals the flat fee, the second sizes the
   send so the merchant receives exactly the intent amount), create the
   transfer, verify the terms, sign, `POST /api/transfers/:id/authorize`, then
   `POST /api/checkout/intents/:id/attach` and redirect back with the code.

**Deviation from the handoff doc: KYC comes before the device key, not after.**
The core's `/api/users/:id/authorizer` calls `requireKycApproved`, so binding a
key to a pending account is refused. The handoff's order (passkey → device key →
KYC) cannot execute against the API as it exists.

Before signing, the page recomputes the destination commitment from the
recipient it can actually see and compares it to what the server asked it to
sign. A server that swapped the merchant's IBAN into the terms is caught there,
before the passkey unlocks anything.

---

## What is real, and what is not

**Real:** the merchant OAuth handoff with PKCE, account and Safe creation,
server-verified WebAuthn registration and assertion, the on-chain authorizer
binding, live quotes, the device-signed EIP-712 payment, the SEPA payout, and
the merchant's code exchange. The browser run in this repo's verification went
end to end to a `PAID` intent.

**The funding gap — the real product gap.** A brand-new account has €0, and
there is no instant way to fund it at a checkout moment:

- crypto/USDC into the Safe — fast, but only if they already hold crypto;
- SEPA into their new IBAN — as slow as SEPA is, and the intent expires in 15
  minutes;
- card / open-banking PIS — not integrated.

The page states the shortfall, shows the IBAN, and waits. It does not pretend.
In a local demo build (`ALLOW_DEV_SHORTCUTS=1`) there is a button that credits a
simulated deposit; it is labelled as such and refuses to exist unless the core
is on loopback. **This is why the existing-user path is the stronger pitch** —
that user already has a balance.

**Tiered KYC does not exist.** The handoff suggests a small first payment could
ride a low-KYC tier. The core has one global daily cap and no tier concept
(FP5's "tiered/KYC-risk caps" is still open), so this build does not claim one:
an account is approved or it cannot transact. Adding a tier is a core change,
not a checkout change.

**Custody is half-done.** FP4's device key is real — the server cannot move a
balance without it. But the Safe *owner* key is still server-held in the core's
plaintext `db.json`. Don't describe this checkout as non-custodial.

**One device key per origin, not per user.** `device.js` keeps a single key
slot per origin. On a shared browser a second person onboarding would otherwise
bind the first person's key as their own authorizer, and either could then
spend the other's balance. This service tracks which account the slot belongs to
(`zold-checkout-key-owner`) and **refuses** rather than sharing a key. The
proper fix is a per-account slot in `device.js`, which is a main-repo change —
that file is copied verbatim here on purpose.

---

## The proxy allowlist

`/api/checkout/*` is served here. Everything else the browser needs is forwarded
to the core by `server/src/proxy.ts`, which holds a named list and 404s the
rest. A blanket `/api/*` proxy would re-expose the operator KYC decision route,
the Monerium OAuth callback and the webhook receiver on a new origin, each of
which has its own assumptions about who can reach it. The list and the reasons
for the exclusions are in that file.

`FORWARD_CLIENT_IP=1` (default) sends `X-Forwarded-For` so the core's per-IP
rate limits key on the real client — set `TRUSTED_PROXY_HOPS` on the core to
match. A deliberate consequence: the core refuses its `/api/simulate/*` routes
for any forwarded request, so those are unreachable through the proxy. The
local-demo shortcuts (`/bff/dev/*`) exist for that reason and call the core
from this process, on loopback, without a forwarding header.

---

## Merchant integration

### Starting a checkout

**Back channel (preferred).** Authenticated with the client secret, so the
merchant can name which of its settlement accounts to be paid into:

```bash
curl -s -X POST https://app.zold.app/api/checkout/intents \
  -H 'content-type: application/json' \
  -d '{
    "client_id": "…", "client_secret": "…",
    "amount": 40.00,
    "destination_iban": "DE02120300000000202051",
    "reference": "mony-user-8412/topup-77af",
    "redirect_uri": "https://mony.example/callback",
    "state": "…", "code_challenge": "…", "code_challenge_method": "S256"
  }'
```

→ `{intentId, checkoutUrl, merchant, amountEur, destinationIban, reference, expiresAt}`.
Redirect the user to `checkoutUrl`.

**Front channel.** `GET /api/checkout/authorize?client_id=…&amount=…` still
works for the simple case and needs no secret — but it **cannot** choose a
destination, and says so if you try. `client_id` is public, so a destination
selectable from a URL would let anyone who has seen a checkout link mint one
that looks like the merchant and pays an account of their choosing. The
authenticated call is what makes a per-transaction destination safe; the
allowlist is what keeps it safe if the secret leaks.

### Destination accounts

A merchant registers one or more settlement IBANs. `destination_iban` must be
one of them; omit it for the first. Unregistered accounts are refused even with
a valid secret. The chosen account is **pinned to the intent**, so changing the
allowlist mid-checkout neither invalidates a payment the user has already
signed nor makes a newly-added account payable for an intent that never named
it. Attach validates the transfer against that pinned value.

There is no merchant onboarding UI — registering a merchant means adding a row
to `data/checkout.json`, and `clientSecret` is stored there in plaintext.

### Getting the result

`POST /api/checkout/token` with the code, the PKCE verifier and the client
secret returns:

```json
{
  "intentId": "…", "status": "PAID", "amountEur": 40,
  "reference": "mony-user-8412/topup-77af",
  "destinationIban": "DE02120300000000202051",
  "transferId": "…",
  "payer": { "sub": "8Qk2…", "name": "Alex Müller" },
  "statusToken": "…"
}
```

- **`reference`** is echoed back verbatim, so the merchant maps the payment to
  its own user and transaction.
- **`payer.sub`** is `HMAC(CHECKOUT_SUBJECT_SECRET, merchantId + userId)` —
  stable for this merchant so a returning customer is recognisable, and
  uncorrelatable with any other merchant's id for the same person. Rotating
  `CHECKOUT_SUBJECT_SECRET` turns every repeat payer into a stranger, which is
  why the service refuses to start without it rather than generating one.
- **`payer.name`** is the payer's legal name, for evidencing that a top-up is
  first-party. Real PII crossing to a third party: it needs a lawful basis and
  a merchant agreement, and it is deliberately absent from the unauthenticated
  `GET /api/checkout/intents/:id` the checkout page reads.

### Not done: the reference does not reach the bank

**The merchant's `reference` does not currently appear on the SEPA payment.**
The rail supports it — `redeemToIban` in the core takes a `memo` and passes it
to Monerium — but the orchestrator hardcodes it:

```js
const order = await redeemToIban(user, payoutEur, counterpart, `Zold ${transfer.id}`);
```

So the money arrives labelled with *our* internal uuid. A merchant reconciling
against its bank statement still cannot tell which of its users paid, which is
the manual step this product is supposed to remove. Closing it needs a change
in the core repo, not here:

1. `POST /api/transfers` accepts an optional `reference` and persists it.
2. The orchestrator passes it as the memo, keeping a short form of our transfer
   id alongside it so our own reconciliation survives.
3. Sanitise to the SEPA remittance charset and 140 characters — this service
   already refuses a longer reference at creation rather than truncating the
   thing the merchant reconciles on.

Until that lands, `reference` is an API-level identifier only: correct in the
token exchange, absent from the bank statement.

---

## The core API contract this service depends on

Nothing in the core repo's tests exercises this one, so a shape change there
breaks this silently — the failure surfaces as a user stuck mid-checkout, not
as a red build. If you are changing any of these in `transF`, this is the list.

**Passkey auth is being reworked in the core (July 2026)** — another agent is
implementing passkey-based auth and will then add usernames per UserID. That is
compatible with everything below; see *Where usernames fit* at the end.

### Auth — the sharp edges

| Endpoint | What this service relies on |
|---|---|
| `POST /api/webauthn/challenge` | Body `{purpose: "register" \| "login" \| "step_up"}`. Returns `{challenge, rpId}`. The page uses the returned **`rpId`**, never `location.hostname` — hardcoding the hostname would scope passkeys to one origin and quietly break the shared-RP-ID layout. `register` and `step_up` require a session. |
| `POST /api/passkey/login` | Body `{credentialId, authenticatorData, clientDataJSON, signature}` — no username field today. Returns the user **plus `sessionToken`**. Identifies by credential (`findUserByCredential`), i.e. a discoverable credential. |
| `POST /api/users/:id/passkey` | Body `{credentialId, attestation, clientDataJSON}` and, when a passkey already exists, a `stepUp`. Returns `publicUser` including `passkey.credentialId` — the page needs that id to unwrap the device key via PRF. |
| `POST /api/users/:id/authorizer` | Body `{address, stepUp}`, where `stepUp` is a full assertion `{credentialId, authenticatorData, clientDataJSON, signature}`. **The most fragile one.** If a username-first flow changes what a step-up assertion looks like, device-key binding breaks at exactly the step where a new user is mid-checkout, with money already in their account. |

### Everything else

| Endpoint | What this service relies on |
|---|---|
| `POST /api/users` | `{name, country, email?}` → user + `sessionToken`. |
| `GET /api/users/:id` | `balanceEur`, `iban`, `kycStatus`, `authorizerAddress`. |
| `GET /api/users/:id/kyc` | `kycStatus` of `approved` / `pending` / `rejected` / `manual_review`. |
| `POST /api/quotes` | `{userId, rail: "sepa", sendEur}` → `{id, sendEur, receiveEur}`. Sender-fixed, so the page quotes twice to size the send. |
| `POST /api/transfers` | `{quoteId, recipientName, recipientIban}` → transfer plus `authorization.{authorizer, typedData}`. |
| `POST /api/transfers/:id/authorize` | `{signature}` → the transfer in a settled state. |
| `GET /api/transfers/:id` | Session-scoped. Attach reads the transfer with the **caller's own bearer** — that is what proves the transfer is theirs, so this must stay session-scoped rather than becoming public. |

Also load-bearing, and not an endpoint:

- **`destinationCommitment` in `chain.ts` must stay byte-identical** to the copy
  in `web/device.js`. The page recomputes the commitment from the recipient it
  can see and refuses to sign on a mismatch. Change one side only and every
  checkout payment refuses — correctly, and confusingly.
- **`requireKycApproved` on `/api/users/:id/authorizer`** is what forces KYC
  before the device key. Relax it and the onboarding order here becomes wrong.

### Where usernames fit

The seamless flow in [ADR 0001](docs/adr/0001-serve-the-checkout-from-the-app-origin.md)
opens with a `mediation: "conditional"` passkey prompt: existing users tap and
pay, everyone else falls through to onboarding without being asked. Its weak
spot is that it needs a **discoverable** credential to appear in the picker, and
not every authenticator stores one.

Usernames per UserID are the fallback that closes it:

1. Conditional UI on load → tap → paid.
2. Nothing in the picker → ask for the username → server returns
   `allowCredentials` for that id → same ceremony.

Still one entry point. The username is a recovery path for the picker, not a
second login system — so `POST /api/passkey/login` should **gain** an optional
identifier rather than require one, or this page has to ask every user for a
username before it knows whether it needed to.

None of this affects ADR 0001 stage 2 (passkey as a Safe owner). That is about
*spending* authority, not identification.

---

## Tests

```bash
npm run onboard:test
```

Drives the whole new-user flow headlessly — account, KYC, device key, funding,
the device-signed SEPA payment, attach, and the merchant's PKCE exchange
(rejecting a wrong verifier, a wrong client secret, and a replayed code) — plus
the proxy allowlist. It runs against its own `data/checkout-test.json`, and
needs the core API running; it deliberately does not spawn or reset the core,
because that store is a single `db.json` at its repo root and a test in another
repo has no business wiping it.

The two WebAuthn ceremonies cannot run headlessly. They are covered by
[BROWSER-CHECKLIST.md](BROWSER-CHECKLIST.md), by hand, in a real browser.

```bash
npm run typecheck
```

---

## Two bugs the old page had

Both were in the core repo's `services/api/public/checkout.html`, and both were
invisible to its `checkout-test.ts` because that test drove the backend
directly. Together they meant the page could not complete a payment in a
browser. The file has since been deleted from the core by PR #68, so they are
recorded here to keep them from being reintroduced — this repo's page does not
have them.

1. **No import map.** The page loaded `/device.js`, which transitively imports
   the bare specifiers `crypto` and `@noble/hashes/crypto`. `index.html` maps
   them; `checkout.html` did not, so the module never loaded, `deviceLib` never
   resolved, and "Confirm with passkey" hung.
2. **`intent.id` is undefined.** `GET /api/checkout/intents/:id` returns
   `statusView`, whose field is `intentId`. The page built the attach URL from
   `intent.id`, so it posted to `/api/checkout/intents/undefined/attach` and got
   "unknown checkout" *after* the payment had already been authorized on-chain
   — money moves, the merchant is never told.

---

## Known gaps in this service

**Intent status is captured at attach and does not advance.** The core version
re-read the transfer from its own store on every status poll, so a payout that
reached `PAID` later showed up. This service cannot: reading a transfer needs
the user's session, and the merchant polls long after the user has gone. On the
local chain the transfer is already `PAID` at attach so it never shows; on a
real SEPA payout an intent would sit at `AUTHORIZED` forever. The fix is
core-side — a checkout webhook, or a service credential that can read a transfer
without a user session.

**No merchant onboarding**, and `clientSecret` is stored in plaintext in
`data/checkout.json`. Fine for a demo, not for a partner.

---

## Changes the core still needs

- `RP_ID=zold.app` and both origins in `WEBAUTHN_ORIGINS`.
- `TRUSTED_PROXY_HOPS` set to the real hop count.
- A way for this service to observe a transfer reaching its terminal state
  (see *Known gaps*).
- A per-account device-key slot in `device.js` (see above).
- Tiered KYC, if a low-friction first payment is wanted.

---

## Layout

```
server/src/config.ts    env; the loopback gate on the dev shortcuts
server/src/core.ts      typed client for the core API (this service's own calls)
server/src/store.ts     merchants + payment intents (JSON file)
server/src/checkout.ts  the authorization-server logic, ported from the core
server/src/proxy.ts     the allowlist
server/src/server.ts    checkout routes, /bff/* routes, proxy mount, static page
web/checkout.html       the checkout + onboarding page
web/device.js           VERBATIM copy from the main repo — see below
web/vendor/             VERBATIM copy (noble secp256k1 + hashes)
scripts/onboard-test.ts headless orchestration test
```

`device.js` and `vendor/` are copied **verbatim** and must stay that way. The
`PRF_SALT = "zoll/device-key/v1"` string and the legacy `zoll-*` localStorage
slots keep the old spelling on purpose: the salt is an input to the key
derivation, so a new spelling derives a different AES key and every already-
wrapped device key becomes undecryptable. Do not finish the Zoll → Zold rename
in that file.
