# Shopify adapter

A Shopify store takes Zold payments through this service. The store offers a
**manual payment method** named Zold; when a buyer places an order with it,
Shopify tells this service, which asks Zold to open a payment request for the
order. The buyer pays on Zold's pay page (reached from the thank-you page block
or the order confirmation email). When Zold says the request is paid, this
service presses **Mark as paid** on the order in Shopify.

Zold (core) keeps the money: payment requests, deposit attribution, the pay
page. This service holds everything Shopify-facing: OAuth with Shopify,
Shopify's webhooks, the Admin API calls, each store's access token, the
thank-you page extension (`shopify-app/`) and the email pay link.

The order exists before the money does: an order placed with the Zold method
is "payment pending" in Shopify until the buyer pays.

## What has never run

- **No Shopify app is registered** for this service. No client id or secret exists.
- **No store has installed it.** Nothing here has talked to a real Shopify store.
- **The extension in `shopify-app/` has never been built** with the Shopify CLI
  or rendered in a real checkout.
- **Zold's side of the contract** (merchant links and the service routes below)
  is built in a separate Zold-app pull request and has not run against this
  service either.

What is tested: every route and the settle loop, over real HTTP, against a
local stub that plays both Shopify (OAuth, Admin GraphQL) and Zold's service
routes (`npm run check`, `test/shopify*.test.ts`). The stub follows Shopify's
documented shapes and the contract; neither real service has checked it.

**Not ported: Shopify's payments-app mode** (Zold as a payment method inside
Shopify's checkout, with payment sessions). It needs Shopify's Payments Apps
program approval, which nobody has. Only the custom-app mode is here.

## Setup, in order

### Operator (once per deployment)

1. **Zold**: set `CHECKOUT_SERVICE_ORIGIN` to this service's public origin,
   make sure data encryption is configured, and issue the checkout service
   credential (`POST /api/admin/service-credentials/checkout/rotate`). Merchant
   links are offered in Zold's /business only when all three hold. For the
   webhook hints, set Zold's `CHECKOUT_WEBHOOK_URL` to
   `https://<checkout origin>/bff/zold/webhook` and `CHECKOUT_WEBHOOK_SECRET`.
2. **Shopify Partner Dashboard**: create an app with **Distribution → Custom**
   (one store each, no Shopify review). Scopes `read_orders,write_orders`.
   Redirect URL `https://<checkout origin>/shopify/callback`. Note the client id
   and secret.
3. **This service** (`.env`, see `.env.example`): `SHOPIFY_API_KEY`,
   `SHOPIFY_API_SECRET`, `SHOPIFY_TOKEN_KEY` (32 random bytes, base64),
   `CORE_PUBLIC_URL` (Zold's public origin), and the existing
   `ZOLD_SERVICE_TOKEN` and `ZOLD_WEBHOOK_SECRET`. The service refuses to start
   with Shopify half-configured.
4. **Extension**: in `shopify-app/`, fill the `REPLACE_WITH_*` values in
   `shopify.app.toml`, then `npx shopify app config link` and
   `npx shopify app deploy`.

### Merchant (once per store)

1. In the Shopify admin: **Settings → Payments → Manual payment methods →
   Create custom payment method**, with a name containing "Zold"
   (`SHOPIFY_MANUAL_GATEWAY`). Store currency for checkout: EUR.
2. In Zold's **/business → Shopify**, enter the store's `myshopify.com` domain
   and connect. Zold sends you to this service, which sends you to Shopify to
   approve the app, and back to Zold.
3. In the store's **checkout editor**, add the "Zold — pay with crypto" block to
   the **Thank you** page and set its **Zold Checkout origin** to this service's
   origin.
4. In **Settings → Notifications → Order confirmation**, paste the pay-link
   snippet Zold's /business shows for the store. It is signed per store, so
   only a link from the email opens the order's payment.

## How it works

### Connecting a store

`GET /shopify/install?shop=<shop>&link=<zlc_ code>` is where Zold's /business
sends the merchant. The link code is Zold's one-time, 15-minute record of the
organisation's consent for that shop. It is kept in memory under an OAuth state
nonce and the merchant goes to Shopify to approve.

`GET /shopify/callback` checks Shopify's query HMAC (constant time), the state
and the shop; exchanges Shopify's code for the store's offline access token;
exchanges the link code with Zold (`POST /api/service/merchant/links/exchange`)
for the link id and the store's pay-link secret; seals both secrets
(AES-256-GCM, associated data `purpose|connection id`) and stores the
connection; subscribes `orders/create`, `orders/cancelled` and `app/uninstalled`
at `/shopify/webhooks`; and sends the merchant back to
`<CORE_PUBLIC_URL>/business?view=shopify&shop=<shop>` (with `error=` and, for
Zold's refusals, its `code`). If Zold does not accept the link, the Shopify
token is dropped, never stored. The link code is spent by Zold on its first use
whatever the answer, so a failed exchange is not retried: the merchant starts again.

### Orders

`POST /shopify/webhooks` is mounted with the raw body, before any JSON parser,
because Shopify's HMAC is over the bytes as sent. The shop header picks the
connection; it is not covered by the signature, so a delivery id is bound to the
first shop it arrived under (kept 72 hours in memory) and a replay under
another shop is refused.

- **orders/create** opens a request (`POST .../links/:linkId/payment-requests`)
  only for a pending order whose payment method name contains the gateway
  name, in EUR, with a total above 0 and at most Zold's ceiling, rounded to
  whole cents. The order status URL is passed on only if it is https. Only the
  SHA-256 of the order's checkout token is kept. Anything else is acknowledged
  with a 200 and ignored: Shopify drops a subscription that keeps failing.
- **orders/cancelled** asks Zold to cancel the request. One that cannot be
  (paid, or already cancelled or expired) comes back with its state.
- **app/uninstalled** disables the connection. Requests already open stay open.
- Zold refusing (400, 403, 404, 409 with a `code`) is acknowledged. A revoked
  link (`LINK_REVOKED`) disables the connection and removes its webhook
  subscriptions. `ORDER_TAKEN` for an order we already hold (opened under the
  store's earlier link) is "already opened": the row keeps its original link id
  and is read, cancelled and settled through it. `NO_PAYMENT_PAGE` (the link's
  payee can no longer be paid) is logged as `SHOPIFY_LINK_STALE` and not
  retried; the order stays unpaid in Shopify until the store is linked again. Zold answering 401, 429 or 5xx, timing out or unreachable is
  **not** a refusal: the delivery answers 503, stays unhandled, and Shopify's
  retry processes it again.

### Settlement

Every order whose request is open, or paid and not yet marked, is read through
`GET .../links/:linkId/payment-requests/:id` with this service's credential:
every `SETTLE_POLL_SECONDS`, backing off from 30 seconds to an hour while it
stays open, at most 50 a tick. Zold's webhook hint
`{"paymentRequestId", "linkId"}` makes one due now; it is never believed about
a state.

- **PAID** → `orderMarkAsPaid`, then a `zold.payment` JSON metafield with the
  payment code, amount and payments. A refused metafield is logged and does not
  undo the mark. A refused mark is recorded on the order and retried from 30
  seconds, doubling to an hour.
- **CANCELLED** or **EXPIRED** → the order is closed here.
- A 401, 429 or 503 from Zold, or Zold unreachable, ends the tick.

Log tokens to alert on: `SHOPIFY_SETTLE_STALLED` / `SHOPIFY_SETTLE_RECOVERED`,
`SHOPIFY_MARK_FAILED` (first failure and every tenth), `SHOPIFY_METAFIELD_FAILED`,
`SHOPIFY_SETTLE_MISMATCH` (Zold answered about another order),
`SHOPIFY_STORE_WRITE_FAILED`, `SHOPIFY_ORDER_REFUSED`, `SHOPIFY_CANCEL_REFUSED`,
`SHOPIFY_SUBSCRIBE_FAILED`, `SHOPIFY_DISABLED`, `SHOPIFY_LINK_READ_FAILED`,
`SHOPIFY_LINK_STALE`.
No log line carries an access token, link secret, link code, checkout token or
payment code. Nothing logs request URLs: the install URL's query carries the
link code.

Zold's `{"linkId"}` hint makes this service read the link; a revoked link
disables the store's connection and removes its webhook subscriptions.

### The buyer

Order ids are per-store sequences, so each buyer route also takes a proof only
the buyer holds, and without it answers the same whether the order exists or not.

- `GET /shopify/orders/:shop/:orderId?t=<checkout token>` is what the thank-you
  block polls (CORS-open, `no-store`, `noindex`). With the order's checkout
  token: Zold's public projection of the request, without the payment code, the
  return and cancel URLs or any transaction hash, plus the pay page URL and the
  order name. Without it: the same `404 {pending: true}` as an unknown order.
- `GET /shopify/orders/:shop/:orderId/pay?b=<proof>` is the email link. `b` must
  be HMAC-SHA256 of the numeric order id under the store's link secret (what
  Liquid's `hmac_sha256` renders), compared in constant time; then a 302 to the
  pay page. Without it: the same 403 text whether the order or store exists or not.

`/bff/health` and `/bff/config` say nothing about Shopify.

## Data

`data/checkout.json` gains `shopifyConnections` (one per shop: link id, sealed
access token and link secret, scope, webhook subscription ids, disabled
reason) and `shopifyOrders` (keyed by shop and order gid: the request's id,
handle, code, public path and pay page URL, the checkout token's hash, Zold's
last state, and the mark-paid record). A file written before these lists gets
them empty on load. Orders that are marked paid or closed are swept after 90
days.

## Known gaps

- The delivery-id memory and the started installs are in memory: after a
  restart the order-level idempotency (shop + order gid, here and at Zold) is
  what holds, and an install in progress starts again.
- A store reconnected through a new link gets a new pay-link secret, so links in
  confirmation emails sent before it stop opening; the thank-you page block is
  unaffected.
- A merchant who marks an order paid by hand makes our "Mark as paid" fail; it
  is retried up to hourly and logged every tenth failure.
- One process: the settle loop and the in-memory maps assume a single instance.
