# Zold Shopify app (custom-app mode)

This folder is the Shopify side of the integration: the app config Shopify's
CLI reads, and one checkout UI extension that renders the order's Zold payment
on the **Thank you** page. There is no server here. Everything Shopify calls
lives in this repo's service (`server/src/shopify*.ts`), which needs
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and the settings listed in
[docs/shopify.md](../docs/shopify.md).

## Why this shape

Only an app approved into Shopify's Payments Apps program can add a payment
method to checkout. This app does not need that: the store offers a **manual
payment method** named Zold, Shopify sends `orders/create`, the checkout
service opens a Zold payment request for the order, and when Zold says the
request is paid the service presses **Mark as paid** on the order through the
Admin API. The extension shows the buyer the payment on the very next screen
after "Place order", and updates itself when the payment is seen. Without the
extension the buyer gets the pay link from the order confirmation email
instead (Zold's business dashboard prints the Liquid snippet).

The order exists before the money does.

## Setup

The full order, for the merchant and the operator, is in
[docs/shopify.md](../docs/shopify.md). For this folder:

```
npm install
npx shopify app config link      # attach to the app created in the Partner Dashboard
npx shopify app dev              # or: npx shopify app deploy
```

Replace the `REPLACE_WITH_*` values in `shopify.app.toml` first. Then in the
store's **checkout editor** add the "Zold — pay with crypto" block to the Thank
you page and set its **Zold Checkout origin** setting to this service's public
origin (`CHECKOUT_PUBLIC_ORIGIN`).

## Not proven

This extension has never been built with the Shopify CLI or run in a real
checkout. Things the first `shopify app dev` may correct:

- The `@shopify/ui-extensions*` package versions in
  `extensions/zold-pay/package.json` (they track Shopify's API version; use
  whatever the CLI scaffolds for `2026-07`).
- The API names on the thank-you target: `api.orderConfirmation` and
  `api.checkoutToken` are the documented ones as of the version this was
  written against.
- `network_access = true` may need enabling for the app in the Partner
  Dashboard before the block can fetch the checkout service.

The service side is tested against stubs of Shopify and Zold (`npm run check`).
