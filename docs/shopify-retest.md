# Shopify retest and the agent payment path (30 Oct 2026)

Covers this service (`zold-pay`) and Zold core (`Zold-app`), both at their
`main` heads of 30 Oct 2026. Testnets and sandboxes only.

## 1. What passed (stubbed)

| Repo | Command | Result |
|---|---|---|
| zold-pay | `npm run typecheck` | passes |
| zold-pay | `node --import tsx --test test/shopify*.test.ts` | 83 tests pass |
| Zold-app | `npm run check` (full offline run) | passes; in it `shopify:test` 28 checks, `shopify:orders:test` 40, `merchant-links:test` 65, `checkout-service:test` all |

Harness problem, not a product bug: run alone, two Zold-app suites fail.
- `npm run shopify:test` stops at start-up (the orchestrator refuses hardhat's
  key on `https://mainnet.base.org`) unless `TRANSF_RPC_URL` points at a local
  node. `npm run check` sets it, but the file's own "Run:" line does not.
- `npm run shopify:orders:test` fails 4 order-lookup checks (14, 17, 18, 29)
  with `ENOENT deployments.json`: it needs a local deployment that an earlier
  suite in `check` writes.

Everything above runs against stubs. Nothing has talked to a real Shopify
store yet (see `shopify.md`, "What has never run").

## 2. What a real retest needs from you

Creating the accounts and entering credentials is for you to do. Claude does not do it.

1. **Shopify Partner account** (free) at partners.shopify.com.
2. **Development store** made from it. Set the store currency to EUR and leave
   the storefront password on.
3. **App** in the Partner Dashboard: Distribution **Custom**, scopes
   `read_orders,write_orders`, redirect
   `https://<checkout origin>/shopify/callback`. Keep the client id and secret
   in your password manager.
4. **Public origins for both services**:
   - this service: `npx shopify app dev` gives a tunnel, or use the
     Cloudflare tunnel already set up for Zold;
   - Zold core: reachable at `CORE_PUBLIC_URL`, on Base Sepolia, with Monerium
     **sandbox**.
5. **Zold core env**: `CHECKOUT_SERVICE_ORIGIN`, `DATA_ENCRYPTION_KEYS`,
   `CHECKOUT_WEBHOOK_URL` and `CHECKOUT_WEBHOOK_SECRET`, plus
   `MERCHANT_LINK_BANK=1` for the agent path. Then issue the checkout
   credential with `POST /api/admin/service-credentials/checkout/rotate`.
6. **zold-pay `.env`**: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
   `SHOPIFY_TOKEN_KEY` (`openssl rand -base64 32`), `CORE_PUBLIC_URL`,
   `ZOLD_SERVICE_TOKEN` (the credential from step 5) and
   `ZOLD_WEBHOOK_SECRET`.
7. **Extension**: fill the `REPLACE_WITH_*` values in
   `shopify-app/shopify.app.toml`, then run `npx shopify app config link` and
   `npx shopify app deploy`. This is the first time it will be built.
8. **Merchant steps** in the dev store: add a manual payment method named
   "Zold", connect the store from Zold's /business, add the thank-you block,
   and paste the pay-link snippet into the order confirmation email
   (`shopify.md`, "Merchant").
9. **A Zold business account on sandbox** with a payment page and a Monerium
   sandbox IBAN. It is the payee.

## 3. Human flow on the dev store

**Not run yet.** It is blocked on section 2. The plan, once the store exists:

1. Place an order with the Zold method.
2. `orders/create` reaches this service, which opens a request at Zold.
3. The thank-you block and the email link show the pay page.
4. Pay it: USDC on Base Sepolia, or with the flag on, a Monerium sandbox
   transfer.
5. The settle loop marks the order paid and writes the `zold.payment`
   metafield.

Record each break here.

Where it is most likely to break, from reading the code:
- the extension build, which has never run;
- the `__Host-` install cookie through a tunnel;
- Shopify's real webhook body against the stub's;
- the email Liquid `hmac_sha256` output against `b=`.

## 4. How an agent pays a Shopify order

An order paid through Zold has two separate steps for an agent: placing the
order, then paying it.

### Paying

**(a) Pay the Zold pay link from the agent's own mandate-limited account.
Recommended.**

The pay page is already machine-readable: `GET <core>/api/pay/<handle>/<code>`
returns the amount due, the USDC address and quote, and (for a request that
takes a bank transfer) the IBAN, holder and reference. Zold already attributes
a Monerium credit to a request when its memo carries the code
(`matchMoneriumOrder`). The settle loop here then marks the Shopify order paid
whatever the method was.

Two pieces were missing, and both are on branch `x/shopify-agent-pay` in
Zold-app:
- Shopify requests opened through merchant links were **crypto only**.
  `MERCHANT_LINK_BANK=1` adds the bank method when the payee has an IBAN. It is
  off by default, because a slow SEPA credit can land after the 24-hour request
  has expired, and the merchant then marks the order paid by hand. With it on,
  anyone holding the order's pay link sees the merchant's IBAN and holder
  name on Zold's pay page, as with an ordinary link. This service's buyer
  lookup still leaves them out.
  `merchant-links:test` now opens such a request and pays it with a Monerium
  credit.
- `scripts/agent-pay-shopify.ts` (prototype) turns a pay link into the
  Monerium payout the agent would place:
  - EUR to the payee IBAN;
  - the request code alone as the memo;
  - the signed message `Send EUR <amt> to <IBAN> at <RFC3339>`, which is
    exactly the hackathon contract's shape 3.

  First it pre-checks the mandate: the state, the expiry, the per-payment cap,
  and the IBAN allowlist (a pay page that swaps the IBAN is refused). It
  fetches only from the origins passed with `--origin`, and it validates the
  pay JSON before using it. It signs and sends nothing. Its test is
  `npm run agent-pay:test`.

This path needs:
- no passkey and no card;
- no 3DS, because the money moves outside the card networks.

The NEAR mandate contract signs the payout, and its SEPA budget covers this
payment too. When both sides are on Monerium, the credit is internal and
arrives in seconds, which fits the 24-hour window. The x402/USDC variant also
works: send `amountUsdc` to `methods.crypto.address` before `validUntil`. It
is attributed by amount, so the agent must send exactly the quoted figure.

Zold's underpayment tolerance (`PAY_REQUEST_UNDERPAY_TOLERANCE_BPS`,
default 50, so 0.5%) also covers bank credits. A €2,000 order paid with
€1,990 counts as PAID and is marked paid in Shopify. The crypto path already
works this way. Set the tolerance near zero for shop orders before going
live.

The signature does not cover the order. Monerium's signed message
(`Send EUR <amt> to <IBAN> at <ts>`) has no memo field, so the request
code travels unsigned beside it. Whoever submits the signed order could
swap the code and credit another of the same merchant's orders instead.
Zold matches any amount, so the payment can part-pay or overpay that order.
The money still reaches the merchant, but it is booked to the wrong order.
A code from another merchant does not match, because Zold only looks at the
requests of the account the credit lands on.
- **Limit today:** the agent submits its own Monerium order, so no relay
  holds a signature it could re-memo. This assumes the agent's host is
  trusted.
- **To close it:** the contract would take the request code as a decoded
  field in shape 3 and record it with the reservation. Today shape 3 has no
  such field. Catching a wrong memo means comparing the Monerium order's
  memo with the order it was meant for, and that finds it only after the
  fact.

One check for the contract: Monerium's amount format. Zold writes `42.5`, not
`42.50` (`moneriumAmountString`), and the contract's canonical form must
produce the same string.

**(b) Single-use virtual card.**
- **Stripe Issuing**: the real-time `issuing_authorization.request` webhook
  (~2 s) is the right place for a mandate check. But a test-mode Issuing card
  only authorizes through Stripe's test helpers. It cannot pay a Shopify
  checkout, and Shopify Payments test mode takes only the public test card
  numbers. A real Shopify demo would therefore need **live** cards and live
  funds. On top of that, EU card payments carry SCA/3DS for an agent with no
  human present.
- **Gnosis Pay**: EURe-native, but it has no real-time authorization hook, so
  the mandate could only be a pre-funded budget. The sandbox is available
  only on request, with one card per user by default.

Cards are the general answer for stores that never install Zold. They are
not the demo.

**(c) What blocks an agent at Shopify checkout.**
- **Bot protection** on the storefront and checkout. A password-protected dev
  store is lenient. In production the industry answer is **Web Bot Auth**
  (HTTP Message Signatures), which both Visa's Trusted Agent Protocol and
  Mastercard Agent Pay build on: the agent registers its key and signs its
  requests, and the merchant's edge admits it.
- **3DS/SCA**: card payments only. Path (a) avoids it.
- **Shopify's own agent rails**: UCP (Shopify and Google, Jan 2026) and
  Agentic Storefronts. These are reported in press coverage; check them
  against shopify.dev before relying on them. They are the long-term way for
  an agent to place the order. Zold would plug in as the payment handler.
  That is the payments-app mode and needs Shopify's approval.

### Placing the order (demo)

**The agent drives the dev store's real checkout in a browser and picks the
Zold manual method.** No card field appears, so it hits no 3DS. The order
confirmation email, sent to the agent's own mailbox, carries the signed pay
link. That link feeds `agent-pay-shopify.ts`, then the mandate contract, then
the Monerium sandbox payout. Zold attributes the payment, and this service
marks the order paid.

A headless alternative, still to verify:
- the store's own tooling calls Admin `draftOrderComplete` with the Zold
  gateway and `paymentPending: true`;
- the order's gateway name must contain "Zold" for `orders/create` to open a
  request.

### Recommendation

Use **(a) over SEPA/EURe** for the demo:
- it reuses the mandate contract's shape 3 unchanged;
- it touches no card network;
- it needs no live funds;
- every piece except the dev-store setup now exists and is tested against
  stubs.

Keep (b) Stripe Issuing for later, for paying stores that don't use Zold.
That needs a live Issuing programme.
