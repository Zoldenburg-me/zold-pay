# Pay with Zold — checkout service

A hosted checkout page where someone who has never heard of Zold can create an
account and pay a merchant without leaving the flow, and where an existing user
can pay with a passkey and a device signature.

It owns no users, no keys and no ledger. The core Zold API (`services/api` in
the main repo) stays the source of truth; this service serves the checkout
origin and forwards an allowlisted set of calls to it.

```
merchant ──▶ core /api/checkout/authorize ──▶ checkout.zold.app/checkout?intent=…
                                                      │
                                                      ├─ new user: account → KYC → device key → funding → pay
                                                      └─ existing user: passkey → pay
                                                      │
merchant ◀── code ── redirect_uri ◀───────────────────┘
```

---

## Origins and the RP ID

This is the decision everything else follows from, so it comes first.

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

Start a checkout as a merchant would, and open the URL it returns:

```bash
curl -s -H 'accept: application/json' "http://127.0.0.1:3000/api/checkout/authorize?client_id=demo-merchant&amount=40&reference=demo&redirect_uri=https%3A%2F%2Fmony.example%2Fcallback&state=xyz&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
```

The core hands back a **relative** `checkoutUrl` (`/checkout.html?intent=…`).
Resolve it against this origin: `http://localhost:3100/checkout?intent=…`.
Pointing merchants here for real needs a `CHECKOUT_BASE_URL` in the core so
`/api/checkout/authorize` redirects to this service — see *Changes the core
still needs*.

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

The browser talks only to this origin; `server/src/proxy.ts` forwards a named
list of core routes and 404s everything else. A blanket `/api/*` proxy would
re-expose the operator KYC decision route, the Monerium OAuth callback and the
webhook receiver on a new origin, each of which has its own assumptions about
who can reach it. The list and the reasons for the exclusions are in that file.

`FORWARD_CLIENT_IP=1` (default) sends `X-Forwarded-For` so the core's per-IP
rate limits key on the real client — set `TRUSTED_PROXY_HOPS` on the core to
match. A deliberate consequence: the core refuses its `/api/simulate/*` routes
for any forwarded request, so those are unreachable through the proxy. The
local-demo shortcuts (`/bff/dev/*`) exist for that reason and call the core
from this process, on loopback, without a forwarding header.

---

## Tests

```bash
npm run onboard:test
```

Drives the whole new-user flow headlessly — account, KYC, device key, funding,
the device-signed SEPA payment, attach, and the merchant's PKCE exchange
(including a wrong verifier being rejected) — plus the proxy allowlist. Needs
the core API running; it deliberately does not spawn or reset it, because the
core's store is a single `db.json` at its repo root and a test in another repo
has no business wiping it.

The two WebAuthn ceremonies cannot run headlessly. They are covered by
[BROWSER-CHECKLIST.md](BROWSER-CHECKLIST.md), by hand, in a real browser.

```bash
npm run typecheck
```

---

## Bugs this work found in the main repo

Both are in `services/api/public/checkout.html` on `main`, and both are
invisible to `scripts/checkout-test.ts` because that test drives the backend
directly. Together they mean the existing checkout page cannot complete a
payment in a browser.

1. **No import map.** The page loads `/device.js`, which transitively imports
   the bare specifiers `crypto` and `@noble/hashes/crypto`. `index.html` maps
   them; `checkout.html` does not, so the module never loads, `deviceLib` never
   resolves, and "Confirm with passkey" hangs.
2. **`intent.id` is undefined.** `GET /api/checkout/intents/:id` returns
   `statusView`, whose field is `intentId`. The page builds the attach URL from
   `intent.id`, so it posts to `/api/checkout/intents/undefined/attach` and gets
   "unknown checkout" *after* the payment has already been authorized on-chain
   — money moves, the merchant is never told.

Both are fixed in this repo's page.

---

## Changes the core still needs

- `CHECKOUT_BASE_URL` so `/api/checkout/authorize` can redirect to this service
  instead of its own relative `/checkout.html`.
- `RP_ID=zold.app` and both origins in `WEBAUTHN_ORIGINS`.
- `TRUSTED_PROXY_HOPS` set to the real hop count.
- A per-account device-key slot in `device.js` (see above).
- Tiered KYC, if a low-friction first payment is wanted.

---

## Layout

```
server/src/config.ts    env; the loopback gate on the dev shortcuts
server/src/core.ts      typed client for the core API (this service's own calls)
server/src/proxy.ts     the allowlist
server/src/server.ts    static page, /bff/* routes, proxy mount
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
