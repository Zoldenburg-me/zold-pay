import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/**
 * The unauthenticated front channel needs only a merchant's public client id, so
 * the per-address limit alone lets many addresses open checkouts for one
 * merchant. Each merchant also gets a front-channel bucket of its own, which a
 * flood cannot extend to the merchant's authenticated back channel.
 */
process.env.CHECKOUT_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "pay-client-limit-")), "checkout.json");
process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";
process.env.CORE_API_URL = "http://127.0.0.1:9";
process.env.RATE_LIMIT_CREDENTIAL = "1000";
process.env.RATE_LIMIT_GENERAL = "1000";
process.env.RATE_LIMIT_CLIENT = "3";

const { app } = await import("../server/src/server.js");
const { store } = await import("../server/src/store.js");
const { hashSecret } = await import("../server/src/secrets.js");

let base = "";
let server: ReturnType<typeof app.listen>;
before(async () => {
  for (const clientId of ["busy-shop", "quiet-shop", "flooded-shop"]) {
    store.addMerchant({
      id: clientId, name: clientId, clientId, clientSecretHash: hashSecret("secret"),
      settlementIbans: ["DE89370400440532013000"], redirectUris: ["https://shop.test/cb"], createdAt: new Date().toISOString(),
    });
  }
  await new Promise<void>((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const CHALLENGE = createHash("sha256").update("v".repeat(43)).digest("base64url");
const authorize = (clientId: string) =>
  fetch(
    `${base}/api/checkout/authorize?` +
      new URLSearchParams({
        client_id: clientId, amount: "5", reference: "r", redirect_uri: "https://shop.test/cb", state: "s", code_challenge: CHALLENGE,
      }),
    { headers: { accept: "application/json" } },
  );
const createIntent = (clientId: string) =>
  fetch(`${base}/api/checkout/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId, client_secret: "secret", amount: 5, reference: "r", redirect_uri: "https://shop.test/cb",
      state: "s", code_challenge: CHALLENGE,
    }),
  });

describe("per-merchant rate limit", () => {
  it("limits one merchant's front-channel checkouts, without touching another merchant", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await authorize("busy-shop")).status);
    assert.deepEqual(statuses, [201, 201, 201, 429]);
    assert.equal((await authorize("quiet-shop")).status, 201);
  });

  it("never locks the merchant out of its own authenticated back channel", async () => {
    for (let i = 0; i < 3; i++) await authorize("flooded-shop");
    assert.equal((await authorize("flooded-shop")).status, 429, "its public link is flooded");
    for (let i = 0; i < 4; i++) assert.equal((await createIntent("flooded-shop")).status, 201);
  });

  it("does not let unknown client ids fill a bucket", async () => {
    // Past the per-merchant limit with one made-up id: still refused as unknown,
    // never counted, so made-up ids leave nothing behind in the table.
    for (let i = 0; i < 5; i++) assert.equal((await authorize("made-up")).status, 400, `attempt ${i + 1}`);
  });
});
