import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// The real server, with a stand-in Zold: the webhook must be mounted before the
// JSON parser (its signature is over the raw body) and must reach the poller.
const KEY = randomBytes(32);
const TOKEN = `zsc_${randomBytes(32).toString("base64url")}`;
let zoldState = "PAYOUT_SUBMITTED";
let zoldView: Record<string, unknown> = {};
const zoldAuth: (string | undefined)[] = [];
const fakeZold = createServer((req, res) => {
  zoldAuth.push(req.headers.authorization);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ...zoldView, state: zoldState }));
});
await new Promise<void>((r) => fakeZold.listen(0, "127.0.0.1", r));

const dir = mkdtempSync(path.join(tmpdir(), "pay-wiring-"));
process.env.CHECKOUT_DB_PATH = path.join(dir, "checkout.json");
process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";
process.env.CHECKOUT_PUBLIC_ORIGIN = "http://localhost:3100";
process.env.CORE_API_URL = `http://127.0.0.1:${(fakeZold.address() as AddressInfo).port}`;
process.env.ZOLD_SERVICE_TOKEN = TOKEN;
process.env.ZOLD_WEBHOOK_SECRET = `whsec_${KEY.toString("base64")}`;
process.env.RATE_LIMIT_GENERAL = "1000";

const { app } = await import("../server/src/server.js");
const { store } = await import("../server/src/store.js");
const { hashSecret } = await import("../server/src/secrets.js");
const co = await import("../server/src/checkout.js");

let base = "";
let server: ReturnType<typeof app.listen>;
before(async () => {
  await new Promise<void>((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  try {
    server?.close();
  } finally {
    // Created before the imports: if it stayed open the test process would never end.
    fakeZold.closeAllConnections();
    fakeZold.close();
  }
});

const IBAN = "DE89370400440532013000";

describe("settlement wiring", () => {
  it("a signed webhook makes the real server read Zold with the token and settle the checkout", async () => {
    const merchant = store.addMerchant({
      id: "m-w", name: "W", clientId: "w", clientSecretHash: hashSecret("w"), settlementIbans: [IBAN],
      redirectUris: ["https://shop.test/cb"], createdAt: new Date().toISOString(),
    });
    const intent = co.createIntent(merchant, {
      amountEur: 9, reference: "r", redirectUri: "https://shop.test/cb", state: "s",
      codeChallenge: createHash("sha256").update("v".repeat(43)).digest("base64url"),
    });
    const reference = co.transferReference(intent);
    co.attachTransfer(intent.id, { id: "tw1", userId: "u1", rail: "sepa", state: "PAYOUT_SUBMITTED", recipientIban: IBAN, receiveEur: 9, reference });
    zoldView = { id: "tw1", rail: "sepa", receiveEur: 9, recipientIban: "…3000", reference };
    zoldState = "PAID";

    const body = JSON.stringify({ transferId: "tw1" });
    const id = "msg_wiring";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v1,${createHmac("sha256", KEY).update(`${id}.${ts}.${body}`).digest("base64")}`;
    const r = await fetch(`${base}/bff/zold/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig },
      body,
    });
    assert.equal(r.status, 204);

    const deadline = Date.now() + 5_000;
    while (store.findPaymentIntent(intent.id)!.status !== "PAID" && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(store.findPaymentIntent(intent.id)!.status, "PAID");
    assert.ok(zoldAuth.length >= 1);
    assert.equal(zoldAuth.every((a) => a === `Bearer ${TOKEN}`), true);
  });
});
