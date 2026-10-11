import { useEffect, useState } from "react";

/**
 * The thank-you page block. It reads the order with the checkout token
 * Shopify gives the extension: order ids are sequential, so the API answers
 * only a caller holding the order's checkout token.
 *
 * It reads from the Zold Checkout service (`/shopify/orders/<shop>/<id>`), which
 * relays Zold's public view of the order's payment request.
 *
 * It shows what the API returns:
 *  - while the webhook is on its way: "preparing your payment" (404 pending);
 *  - OPEN: the EUR total, the exact USDC figure, the address, a QR of the
 *    EIP-681 URI, the chain, and how long the request stays open;
 *  - PAID: the payment was seen; the order is being marked paid;
 *  - EXPIRED / CANCELLED: the request closed, with the pay link still shown
 *    so the buyer can reach the merchant's page.
 * It computes no amounts and shows "paid" only after the API does, since the
 * API marks the order paid in Shopify.
 */
const POLL_MS = 4000;
const PENDING_GIVE_UP_MS = 90_000;

function numericId(gid) {
  const m = /(\d+)$/.exec(String(gid ?? ""));
  return m ? m[1] : undefined;
}

export function ZoldPay({ ui, orderId, checkoutToken, shop, apiBase }) {
  const { BlockStack, InlineStack, Heading, Text, Banner, Link, QRCode, Divider, SkeletonText } = ui;
  const [state, setState] = useState({ phase: "loading" });
  const id = numericId(orderId);
  const base = String(apiBase ?? "").replace(/\/$/, "");

  useEffect(() => {
    if (!id || !checkoutToken || !shop || !base) {
      setState({ phase: "unconfigured" });
      return;
    }
    let stop = false;
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const res = await fetch(`${base}/shopify/orders/${encodeURIComponent(shop)}/${id}?t=${encodeURIComponent(checkoutToken)}`, { headers: { accept: "application/json" } });
        if (res.status === 404) {
          const body = await res.json().catch(() => ({}));
          if (body.pending && Date.now() - startedAt < PENDING_GIVE_UP_MS) {
            setState({ phase: "pending" });
            return true;
          }
          setState({ phase: "none" });
          return false;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const r = await res.json();
        setState({ phase: "ready", r });
        return r.state === "OPEN";
      } catch (err) {
        setState((s) => (s.phase === "ready" ? s : { phase: "error", message: String(err?.message ?? err) }));
        return true;
      }
    };
    const loop = async () => {
      while (!stop) {
        const again = await tick();
        if (!again) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    };
    loop();
    return () => {
      stop = true;
    };
  }, [id, checkoutToken, shop, base]);

  if (state.phase === "unconfigured") return null;
  if (state.phase === "pending" || state.phase === "loading") {
    return (
      <BlockStack spacing="base">
        <Heading level={2}>Pay with Zold</Heading>
        <Text>Preparing your payment…</Text>
        <SkeletonText inlineSize="large" />
      </BlockStack>
    );
  }
  if (state.phase === "none") {
    return (
      <Banner status="info" title="Pay with Zold">
        This order's payment page is not ready yet. The link in your order confirmation email opens it once it is.
      </Banner>
    );
  }
  if (state.phase === "error") {
    return (
      <Banner status="warning" title="Pay with Zold">
        Could not load the payment right now ({state.message}). Use the link in your order confirmation email.
      </Banner>
    );
  }

  const r = state.r;
  const c = r.methods?.crypto;
  const eur = typeof r.amountEur === "number" ? `€${r.amountEur.toFixed(2)}` : "";
  const name = r.orderName ? `Order ${r.orderName}` : "Your order";

  if (r.state === "PAID") {
    return (
      <Banner status="success" title={`${name} — payment received`}>
        Your payment of {eur} was seen on chain and the order is being marked paid. Keep this page for your records.
      </Banner>
    );
  }
  if (r.state !== "OPEN") {
    return (
      <Banner status="critical" title={`${name} — payment window closed`}>
        This payment request is {String(r.state).toLowerCase()}. If you have already sent funds, contact the store with your transaction. <Link to={r.pageUrl} external>Open the payment page</Link>
      </Banner>
    );
  }
  if (!c) {
    return (
      <Banner status="warning" title={`${name} — pay with Zold`}>
        Crypto payment cannot be quoted right now. <Link to={r.pageUrl} external>Open the payment page</Link> to try again.
      </Banner>
    );
  }

  const usdc = typeof c.amountUsdc === "number" ? c.amountUsdc.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : undefined;
  const validUntil = c.validUntil ? new Date(c.validUntil) : undefined;
  const expires = r.expiresAt ? new Date(r.expiresAt) : undefined;

  return (
    <BlockStack spacing="base" border="base" cornerRadius="base" padding="base">
      <Heading level={2}>{name} — pay {eur} with crypto</Heading>
      <Text>
        Send <Text emphasis="bold">{usdc ? `${usdc} USDC` : "USDC"}</Text> on {c.token?.chainName ?? `chain ${c.chainId}`} to the address below. The order is marked paid the moment the transfer is seen.
        {c.allowanceBps ? ` The USDC figure includes a ${(c.allowanceBps / 100).toFixed(2)}% rate allowance.` : ""}
      </Text>
      {c.uri ? (
        <InlineStack blockAlignment="center" inlineAlignment="center">
          <QRCode content={c.uri} size="base" />
        </InlineStack>
      ) : null}
      <BlockStack spacing="extraTight">
        <Text size="small" appearance="subdued">Address</Text>
        <Text emphasis="bold">{c.address}</Text>
      </BlockStack>
      {c.uri ? (
        <Link to={c.uri} external>Open in wallet</Link>
      ) : null}
      <Divider />
      <Text size="small" appearance="subdued">
        {validUntil ? `This USDC figure is valid until ${validUntil.toLocaleTimeString()}. ` : ""}
        {expires ? `The payment window closes ${expires.toLocaleString()}. ` : ""}
        Sending a different token or chain will not be recognised.
      </Text>
      <Link to={r.pageUrl} external>Open the payment page in Zold</Link>
      {r.test ? <Banner status="warning">Test order: any payment made here is a real payment.</Banner> : null}
    </BlockStack>
  );
}
