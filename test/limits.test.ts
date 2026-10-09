import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter, ipKey } from "../server/src/limits.js";

function run(limiter: ReturnType<typeof createRateLimiter>, ip: string) {
  const out: { status?: number; headers: Record<string, string>; passed: boolean } = { headers: {}, passed: false };
  const res: any = {
    setHeader: (k: string, v: string) => void (out.headers[k.toLowerCase()] = String(v)),
    status(code: number) {
      out.status = code;
      return res;
    },
    json: () => res,
  };
  limiter({ ip, socket: { remoteAddress: ip } } as any, res, () => void (out.passed = true));
  return out;
}

describe("createRateLimiter", () => {
  it("allows up to max requests, then answers 429 with Retry-After", () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3, now: () => now });
    for (let i = 0; i < 3; i++) assert.equal(run(limiter, "1.2.3.4").passed, true);
    const blocked = run(limiter, "1.2.3.4");
    assert.equal(blocked.passed, false);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
  });

  it("starts a fresh window after windowMs", () => {
    let now = 5_000;
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1, now: () => now });
    assert.equal(run(limiter, "1.2.3.4").passed, true);
    assert.equal(run(limiter, "1.2.3.4").passed, false);
    now += 1_001;
    assert.equal(run(limiter, "1.2.3.4").passed, true);
  });

  it("counts each client separately", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(run(limiter, "1.1.1.1").passed, true);
    assert.equal(run(limiter, "2.2.2.2").passed, true);
    assert.equal(run(limiter, "1.1.1.1").passed, false);
  });

  it("treats a whole IPv6 /64 as one client", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(run(limiter, "2001:db8:1:2::1").passed, true);
    assert.equal(run(limiter, "2001:db8:1:2:ffff:ffff:ffff:ffff").passed, false);
    assert.equal(run(limiter, "2001:db8:1:3::1").passed, true);
  });
});

describe("ipKey", () => {
  it("normalises IPv4-mapped IPv6 and keys IPv6 by /64", () => {
    assert.equal(ipKey("::ffff:10.0.0.9"), "10.0.0.9");
    assert.equal(ipKey("10.0.0.9"), "10.0.0.9");
    assert.equal(ipKey("2001:db8:1:2::1"), ipKey("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd"));
    assert.equal(ipKey(undefined), "unknown");
  });
});

describe("createRateLimiter keyed on the merchant", () => {
  /** 200 when the request went through, else the status the limiter answered. */
  const statusOf = (limiter: ReturnType<typeof createRateLimiter>, ip: string, query: Record<string, string>) => {
    let status = 200;
    const res: any = { setHeader: () => res, status: (s: number) => ((status = s), res), json: () => res };
    limiter({ ip, query, socket: { remoteAddress: ip } } as any, res, () => {});
    return status;
  };

  it("counts every address of one merchant together, and leaves requests with no key to the other limits", () => {
    const limit = createRateLimiter({ windowMs: 1000, max: 2, now: () => 0, keyOf: (req) => (req.query as any).client_id });
    const statuses = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((ip) => statusOf(limit, ip, { client_id: "shop" }));
    assert.deepEqual(statuses, [200, 200, 429]);
    for (let i = 0; i < 4; i++) assert.equal(statusOf(limit, "4.4.4.4", {}), 200, "no merchant named: not this limiter's business");
    assert.equal(statusOf(limit, "1.1.1.1", { client_id: "other" }), 200);
  });
});
