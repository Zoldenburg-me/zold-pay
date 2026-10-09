import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";
const { assertConfigSane, CONFIG } = await import("../server/src/config.js");

const prod = () => ({
  ...CONFIG,
  production: true,
  publicOrigin: "https://app.zold.app",
  coreApiUrl: "https://core.internal.zold.app",
  trustedProxyHops: 1,
  allowDevShortcuts: false,
  subjectSecret: "x".repeat(32),
});

describe("assertConfigSane", () => {
  it("accepts a complete production configuration", () => {
    assert.doesNotThrow(() => assertConfigSane(prod()));
  });

  it("refuses to start without the payer-subject secret", () => {
    assert.throws(() => assertConfigSane({ ...prod(), subjectSecret: "" }), /CHECKOUT_SUBJECT_SECRET/);
  });

  it("in production, requires an https public origin", () => {
    assert.throws(() => assertConfigSane({ ...prod(), publicOrigin: "http://app.zold.app" }), /https/);
    assert.throws(() => assertConfigSane({ ...prod(), publicOrigin: "https://localhost:3100" }), /localhost/);
  });

  it("in production, requires an explicit proxy hop count", () => {
    assert.throws(() => assertConfigSane({ ...prod(), trustedProxyHops: undefined }), /TRUSTED_PROXY_HOPS/);
    assert.throws(() => assertConfigSane({ ...prod(), trustedProxyHops: -1 }), /TRUSTED_PROXY_HOPS/);
  });

  it("in production, refuses dev shortcuts and a short subject secret", () => {
    assert.throws(() => assertConfigSane({ ...prod(), allowDevShortcuts: true }), /ALLOW_DEV_SHORTCUTS/);
    assert.throws(() => assertConfigSane({ ...prod(), subjectSecret: "short" }), /CHECKOUT_SUBJECT_SECRET/);
  });

  it("requires the account-creation link to be an http(s) URL", () => {
    assert.throws(() => assertConfigSane({ ...prod(), appUrl: "javascript:alert(1)" }), /ZOLD_APP_URL/);
    assert.throws(() => assertConfigSane({ ...prod(), appUrl: "not a url" }), /ZOLD_APP_URL/);
    assert.doesNotThrow(() => assertConfigSane({ ...prod(), appUrl: "https://app.zold.app" }));
  });

  it("outside production, still refuses dev shortcuts against a non-loopback core", () => {
    const cfg = { ...CONFIG, production: false, subjectSecret: "x", allowDevShortcuts: true, coreApiUrl: "https://core.example" };
    assert.throws(() => assertConfigSane(cfg), /loopback/);
  });

  it("refuses a hosted-looking origin when NODE_ENV is neither production nor development", () => {
    const cfg = {
      ...CONFIG, production: false, environment: "unset" as const, subjectSecret: "x", allowDevShortcuts: false,
      publicOrigin: "https://pay.example.com", coreApiUrl: "http://127.0.0.1:3000",
    };
    assert.throws(() => assertConfigSane(cfg), /NODE_ENV/);
    assert.doesNotThrow(() => assertConfigSane({ ...cfg, environment: "development" as const }));
  });

  it("refuses malformed numeric settings instead of silently turning a limit off", () => {
    const entry = pathToFileURL(path.join(ROOT, "server/src/config.ts")).href;
    for (const [name, value] of [
      ["RATE_LIMIT_GENERAL", "abc"], ["RATE_LIMIT_CREDENTIAL", "0"], ["CHECKOUT_MAX_AMOUNT_EUR", "NaN"],
      ["TRUSTED_PROXY_HOPS", "-1"], ["TRUSTED_PROXY_HOPS", "1.5"],
    ]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(entry)})`], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, [name]: value },
      });
      assert.notEqual(r.status, 0, `${name}=${value} must stop the service from starting`);
      assert.match(r.stderr, new RegExp(name), `${name}=${value}`);
    }
  });
});
