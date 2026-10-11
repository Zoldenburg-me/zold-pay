# ADR 0001 — Serve the checkout from the app origin, not its own subdomain

- **Status:** Proposed (supersedes the layout in §4 of the build handoff)
- **Date:** 2026-07-27
- **Affects:** this repo's deployment, `RP_ID` / `WEBAUTHN_ORIGINS` in the core API,
  and whether the existing-user checkout works at all

## Context

Two separations were decided at once and treated as one:

1. **A separate repo.** PR #68 removed the checkout from the core repo so the
   consumer app stays lean.
2. **A separate origin** — `checkout.zold.app` alongside `app.zold.app`, which
   §4 of the build handoff recommended and this repo implemented.

They are independent, and only the first one is cheap.

Zold's spending authority is origin-bound in a way ordinary web auth is not:

- A **passkey** is scoped to a relying-party id. Two origins under one
  registrable domain can share it (`rp.id = zold.app`), so passkeys survive the
  split.
- The **FP4 device key** does not. It is an EOA generated in the browser, held
  in **one origin's `localStorage`**, and registered with the core as the
  account's `authorizer`. The core refuses a payment without its signature.
  A second origin has a different `localStorage`, so the key is simply absent —
  and because only the *current* authorizer may rotate the binding, the new
  origin cannot mint a replacement either.

So the origin split does not degrade the existing-user experience. It removes
it. Everything painful in this repo's README traces back to it:

| Consequence | Root cause |
|---|---|
| Existing users cannot pay at the checkout | device key lives on the app origin |
| The allowlist proxy has to exist | browser cannot call the core cross-origin |
| `device.js` + `vendor/` copied verbatim | a second origin needs its own copy |
| `RP_ID` / `WEBAUTHN_ORIGINS` misconfiguration fails silently | two origins, one RP ID |

The first row is the expensive one. This repo's own README argues the
**existing-user path is the stronger pitch** — a user with a balance pays in
two taps and never meets the funding gap. The current architecture is optimised
for the weaker half of the product, and the handoff called the strong half
"out of scope" as though it were a scoping choice rather than a capability being
designed away.

## Decision

**Keep the separate repo. Serve it from the app origin via path routing.**

```
app.zold.app/                 → core API + consumer app
app.zold.app/checkout         → this service
app.zold.app/api/checkout/*   → this service
app.zold.app/api/*            → core API
```

One reverse-proxy rule. The service stays a separate codebase, deploy and
process; only the public origin is shared.

Do **not** provision `checkout.zold.app`. Once a merchant redirect URL and a
passkey RP binding exist on that hostname, undoing it means every user who
onboarded there has a device key stranded on a dead origin — the same
unrecoverable state as a lost key.

### What changes in this repo

- `CHECKOUT_PUBLIC_ORIGIN=https://app.zold.app`, so `authorize` builds
  `https://app.zold.app/checkout?intent=…`.
- The existing-user branch in `web/checkout.html` stops being dead code. The
  `"your spending key was set up in a different browser"` refusal keeps its
  meaning — it now fires only for a genuinely different *device*, which is
  correct.
- `server/src/proxy.ts` becomes optional: the browser could call `/api/*`
  directly. **Keep it.** It is a deliberate control — a blanket surface would
  re-expose the operator KYC route and the webhook receiver — and it is cheap.
- `WEBAUTHN_ORIGINS` needs one origin, not two. `RP_ID` becomes `zold.app` with
  a single matching origin, which cannot silently half-match.

## Path to a single seamless flow

Same-origin is necessary but **not sufficient**. Three stages, in order.

### Stage 1 — one origin (this ADR)

Recovers the existing-user path *on the device they onboarded on*. Merge the UI
fork: instead of asking "new or existing", offer a passkey prompt with
`mediation: "conditional"` on load. Someone with a passkey taps and pays;
everyone else falls through to onboarding without ever seeing a choice. One
entry point, two outcomes.

### Stage 2 — passkey as the spending authority

Stage 1 leaves a hard edge: a passkey **syncs across devices**, the device key
**does not**. An existing user paying from a new laptop authenticates fine and
then cannot sign, and cannot re-bind, because only the current authorizer may
rotate. Same wall as a lost key, reached by an ordinary user doing an ordinary
thing.

Where the core stands: the passkey is the Safe's **only** owner (threshold 1)
and approves every debit as a user operation; the Monerium redeem is approved
with a passkey assertion at send time too. The core holds no key on the Safe
and refuses to add a co-owner Zold holds. Recovery is a guardian module the
user opts into.

What is left for this stage: the core still asks for the **device key's**
signature over the transfer terms next to the two passkey assertions. Dropping
that requirement, so that the passkey alone authorizes a payment, removes the
per-browser state: the "pay from that device" refusal disappears and origin
stops mattering for payments. That is a core change, not a checkout change.

### Stage 3 — the part architecture cannot fix

- **Funding.** A brand-new account has €0 and no instant rail. Neither stage
  above changes that. It is why Stage 1 matters commercially: it makes the
  *existing-user* flow — the one with no funding step — the default path
  through the checkout.

## Alternatives considered

**Keep two origins; redirect to the app origin for the signing step.** The user
bounces `checkout → app → checkout` mid-payment. It works, but it adds two
redirects to the moment the user is deciding whether to trust the page, and the
handoff back needs its own state-passing. All of that to preserve a hostname.

**Keep two origins; accept new-users-only.** What is built today. Concedes the
better half of the product to preserve a cosmetic separation.

**Merge back into the core repo.** Would also remove the duplicated merchant store
and the service credential, since the checkout could read transfers directly. But it
reverses PR #68 for reasons unrelated to why PR #68 was made, and the blast-
radius argument for a separate merchant-facing surface is real. Path routing
gets the origin benefit without the reversal.

## Consequences

**Good:** the existing-user path works; one RP ID with one origin; no DNS,
certificate or CORS surface for a second hostname; merchant redirect URLs point
at a hostname that will not need to move.

**Bad:** the checkout is no longer isolable by origin, so a bug in the checkout
page runs on the same origin as the consumer app and shares its `localStorage`.
That is a real reduction in blast radius and the honest cost of this decision.
It is accepted because the device key is the asset being protected, and origin
separation was *removing* that user's access to it rather than protecting it.

**Unresolved:** `device.js` keeps one key slot per origin, not per user, so a
shared browser would bind one person's key to another's account. This service
refuses rather than sharing (`zold-checkout-key-owner`), but a per-account slot
in `device.js` is the real fix and belongs in the core repo. Same-origin makes
this *more* likely to be hit, not less, since app and checkout now share one
slot.
