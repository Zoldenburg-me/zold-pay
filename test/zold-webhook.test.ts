import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";

process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";

const { createZoldWebhookRouter, verifyStandardWebhook } = await import("../server/src/zold-webhook.js");
const { createErrorHandler } = await import("../server/src/errors.js");

const KEY = randomBytes(32);
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW_S = 1_791_000_000;

/** Signs exactly as Zold's http/standard-webhooks.ts does, written out independently. */
const sign = (id: string, ts: string, body: string, key: Buffer = KEY) =>
  `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;

const seen: string[] = [];
const logged: string[] = [];
let clock = NOW_S * 1000;
let base = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  const app = express();
  app.use(
    createZoldWebhookRouter({
      secret: SECRET,
      now: () => clock,
      onTransfer: (id) => {
        seen.push(id);
      },
      log: (m) => logged.push(String(m)),
    }),
  );
  // Anything the router does not claim falls through, like the real server's JSON parser.
  app.use(express.json());
  app.post("/after", (req, res) => res.json(req.body));
  app.use(createErrorHandler(() => {}));
  await new Promise<void>((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());
beforeEach(() => {
  seen.length = 0;
});

let n = 0;
function deliver(over: { id?: string; ts?: string; body?: string; sig?: string; type?: string } = {}) {
  const id = over.id ?? `msg_${++n}`;
  const ts = over.ts ?? String(NOW_S);
  const body = over.body ?? JSON.stringify({ transferId: "t1" });
  return fetch(`${base}/bff/zold/webhook`, {
    method: "POST",
    headers: {
      "content-type": over.type ?? "application/json",
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": over.sig ?? sign(id, ts, body),
    },
    body,
  });
}

const flush = () => new Promise((r) => setImmediate(r));

describe("Zold webhook receiver", () => {
  it("accepts a signed delivery and asks for that transfer to be read", async () => {
    const r = await deliver();
    assert.equal(r.status, 204);
    await flush();
    assert.deepEqual(seen, ["t1"]);
  });

  it("accepts any one of several signatures (Zold rotating its secret)", async () => {
    const id = "msg_rot";
    const body = JSON.stringify({ transferId: "t1" });
    const r = await deliver({ id, body, sig: `v1,${randomBytes(32).toString("base64")} ${sign(id, String(NOW_S), body)}` });
    assert.equal(r.status, 204);
  });

  for (const [name, over] of [
    ["a wrong signature", { sig: sign("msg_x", String(NOW_S), "{}") }],
    ["a signature by another key", { key: randomBytes(32) }],
    ["no signature", { sig: "" }],
    ["a timestamp six minutes old", { ts: String(NOW_S - 360) }],
    ["a timestamp six minutes ahead", { ts: String(NOW_S + 360) }],
    ["an ISO timestamp", { ts: new Date(NOW_S * 1000).toISOString() }],
    ["a timestamp that is not a number", { ts: "soon" }],
  ] as const) {
    it(`refuses ${name} with 401 and reads nothing`, async () => {
      const o = over as { sig?: string; ts?: string; key?: Buffer };
      const id = `msg_bad_${++n}`;
      const ts = o.ts ?? String(NOW_S);
      const body = JSON.stringify({ transferId: "t1" });
      const sig = o.key ? sign(id, ts, body, o.key) : o.sig ?? sign(id, ts, body);
      const r = await deliver({ id, ts, body, sig });
      assert.equal(r.status, 401);
      await flush();
      assert.deepEqual(seen, []);
    });
  }

  it("refuses a body changed after signing", async () => {
    const id = "msg_tamper";
    const sig = sign(id, String(NOW_S), JSON.stringify({ transferId: "t1" }));
    const r = await deliver({ id, sig, body: JSON.stringify({ transferId: "t2" }) });
    assert.equal(r.status, 401);
  });

  it("answers a repeated delivery id without reading again", async () => {
    const id = "msg_twice";
    assert.equal((await deliver({ id })).status, 204);
    assert.equal((await deliver({ id })).status, 204);
    await flush();
    assert.deepEqual(seen, ["t1"]);
  });

  for (const [name, body] of [
    ["no transfer id", "{}"],
    ["extra fields", JSON.stringify({ transferId: "t1", state: "PAID" })],
    ["a transfer id that is not an id", JSON.stringify({ transferId: "../admin" })],
    ["a list", JSON.stringify([{ transferId: "t1" }])],
    ["not JSON", "transferId=t1"],
  ] as const) {
    it(`refuses a signed body with ${name} with 400`, async () => {
      const r = await deliver({ body });
      assert.equal(r.status, 400);
      await flush();
      assert.deepEqual(seen, []);
    });
  }

  it("refuses a body over 4 KB before checking it", async () => {
    const r = await deliver({ body: JSON.stringify({ transferId: "t1", pad: "x".repeat(5000) }) });
    assert.equal(r.status, 413);
  });

  it("refuses a body that is not JSON by content type", async () => {
    const r = await deliver({ type: "text/plain" });
    assert.equal(r.status, 415);
  });

  it("logs refused deliveries as a count at most once a minute, without header values", async () => {
    logged.length = 0;
    clock = NOW_S * 1000 + 61_000; // past any earlier report
    const ts = String(Math.floor(clock / 1000));
    for (let i = 0; i < 3; i++) await deliver({ ts, sig: "v1,forged-signature-value" });
    clock += 61_000;
    await deliver({ ts: String(Math.floor(clock / 1000)), sig: "v1,forged-signature-value" });
    clock = NOW_S * 1000;
    assert.equal(logged.length, 2);
    assert.match(logged[1], /refused 3 deliveries .*\(3 bad signature: .* 0 outside the time window/);
    assert.equal(logged.some((l) => l.includes("forged-signature-value") || l.includes("msg_")), false);
  });

  it("tells a stale timestamp from a wrong signature in the log", async () => {
    logged.length = 0;
    clock = NOW_S * 1000 + 200_000;
    await deliver({ ts: String(NOW_S) }); // 200 s… inside the window: signed fine, accepted
    await deliver({ ts: String(NOW_S - 200) }); // 400 s old: refused for its time
    clock = NOW_S * 1000;
    assert.match(logged.at(-1) ?? "", /0 bad signature: .* 1 outside the time window/);
  });

  it("leaves every other route to the parsers after it", async () => {
    const r = await fetch(`${base}/after`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    assert.deepEqual(await r.json(), { a: 1 });
  });
});

describe("verifyStandardWebhook", () => {
  const raw = Buffer.from('{"transferId":"t1"}');
  const args = (over: Record<string, unknown> = {}) => ({
    id: "msg_1", timestamp: String(NOW_S), signature: sign("msg_1", String(NOW_S), raw.toString()), raw, secret: SECRET, now: NOW_S * 1000, ...over,
  });

  it("accepts exactly the five-minute edge and refuses one second past it", () => {
    const at = (ts: number) => verifyStandardWebhook(args({ timestamp: String(ts), signature: sign("msg_1", String(ts), raw.toString()) }));
    assert.equal(at(NOW_S - 300), true);
    assert.equal(at(NOW_S - 301), false);
  });

  it("refuses when any input is missing", () => {
    for (const k of ["id", "timestamp", "signature", "secret"]) assert.equal(verifyStandardWebhook(args({ [k]: "" })), false);
  });
});
