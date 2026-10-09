import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.CHECKOUT_SUBJECT_SECRET = "test-subject-secret";
const { assertConfigSane, CONFIG, devShortcutsEnabled, originIsLoopback } = await import("../server/src/config.js");

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

  // The demo merchant has a published secret and accepts any redirect URI, so it
  // must only exist where nobody else can reach it: loopback core AND loopback origin.
  describe("the demo merchant", () => {
    const dev = (over: Record<string, unknown>) => ({
      ...CONFIG, production: false, environment: "development" as const, subjectSecret: "x", allowDevShortcuts: true,
      coreApiUrl: "http://127.0.0.1:3000", publicOrigin: "http://localhost:3100", ...over,
    });

    it("is allowed on a fully local run", () => {
      assert.doesNotThrow(() => assertConfigSane(dev({})));
      assert.equal(devShortcutsEnabled(dev({})), true);
    });

    it("is refused on a hosted origin even with NODE_ENV=development and a loopback core", () => {
      const hosted = dev({ publicOrigin: "https://pay.example.com" });
      assert.throws(() => assertConfigSane(hosted), /ALLOW_DEV_SHORTCUTS.*CHECKOUT_PUBLIC_ORIGIN/s);
      assert.equal(devShortcutsEnabled(hosted), false, "never seeded, whatever the startup check says");
    });

    it("is not seeded unless asked for", () => {
      assert.equal(devShortcutsEnabled(dev({ allowDevShortcuts: false })), false);
    });

    it("recognises loopback origins in every spelling", () => {
      for (const origin of ["http://localhost:3100", "http://127.0.0.1:3100", "http://[::1]:3100"]) {
        assert.equal(originIsLoopback({ ...CONFIG, publicOrigin: origin }), true, origin);
      }
      for (const origin of ["https://pay.example.com", "https://localhost.evil.test", "not a url"]) {
        assert.equal(originIsLoopback({ ...CONFIG, publicOrigin: origin }), false, origin);
      }
    });
  });

  it("refuses a hosted-looking origin when NODE_ENV is neither production nor development", () => {
    const cfg = {
      ...CONFIG, production: false, environment: "unset" as const, subjectSecret: "x", allowDevShortcuts: false,
      publicOrigin: "https://pay.example.com", coreApiUrl: "http://127.0.0.1:3000",
    };
    assert.throws(() => assertConfigSane(cfg), /NODE_ENV/);
    assert.doesNotThrow(() => assertConfigSane({ ...cfg, environment: "development" as const }));
  });

  it("stops on a malformed .env with one line naming the file and the line, not a stack trace", () => {
    const entry = pathToFileURL(path.join(ROOT, "server/src/config.ts")).href;
    const dir = mkdtempSync(path.join(tmpdir(), "pay-config-env-"));
    const envFile = path.join(dir, "bad.env");
    writeFileSync(envFile, "OK=1\nNOT A SETTING hunter2\n");
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(entry)})`], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, CHECKOUT_ENV_FILE: envFile },
    });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /line 2: not KEY=value/);
    assert.equal(r.stderr.includes("hunter2"), false);
    assert.equal(/\n\s+at /.test(r.stderr), false, "no stack trace");
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
      assert.equal(r.stderr.includes(`"${value}"`), false, `${name}: the error names the setting, never its value`);
    }
  });
});
