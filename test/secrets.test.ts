import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { hashSecret, newToken, openSecret, safeEqual, sealSecret, secretMatchesHash } from "../server/src/secrets.js";

describe("secrets", () => {
  it("hashes deterministically and never returns the input", () => {
    const h = hashSecret("hunter2");
    assert.equal(h, hashSecret("hunter2"));
    assert.notEqual(h, "hunter2");
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("matches the right secret and rejects wrong, empty and non-string input", () => {
    const h = hashSecret("right");
    assert.equal(secretMatchesHash("right", h), true);
    assert.equal(secretMatchesHash("wrong", h), false);
    assert.equal(secretMatchesHash("", h), false);
    assert.equal(secretMatchesHash(undefined, h), false);
    assert.equal(secretMatchesHash(42, h), false);
  });

  it("never matches against a missing or empty stored hash", () => {
    assert.equal(secretMatchesHash("anything", undefined), false);
    assert.equal(secretMatchesHash("", ""), false);
  });

  it("compares strings of different lengths without throwing", () => {
    assert.equal(safeEqual("a", "abcdef"), false);
    assert.equal(safeEqual("same", "same"), true);
    assert.equal(safeEqual("", ""), true);
  });

  it("issues url-safe, unique tokens", () => {
    const a = newToken();
    const b = newToken();
    assert.match(a, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(a, b);
  });
});

describe("sealed secrets (AES-256-GCM, AAD purpose|row)", () => {
  const key = randomBytes(32);

  it("opens what it sealed, with a fresh IV each time and no plaintext in the sealed form", () => {
    const a = sealSecret(key, "shopify-access-token", "row-1", "shpat_secret");
    const b = sealSecret(key, "shopify-access-token", "row-1", "shpat_secret");
    assert.notEqual(a, b);
    assert.match(a, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(a.includes("shpat_secret"), false);
    assert.equal(openSecret(key, "shopify-access-token", "row-1", a), "shpat_secret");
  });

  it("does not open under another row, another purpose, another key, or when tampered", () => {
    const sealed = sealSecret(key, "shopify-link-secret", "row-1", "k".repeat(64));
    const parts = sealed.split(".");
    const flipped = Buffer.from(parts[2], "base64url");
    flipped[0] ^= 1;
    for (const [k, purpose, row, value] of [
      [key, "shopify-link-secret", "row-2", sealed],
      [key, "shopify-access-token", "row-1", sealed],
      [randomBytes(32), "shopify-link-secret", "row-1", sealed],
      [key, "shopify-link-secret", "row-1", [parts[0], parts[1], flipped.toString("base64url"), parts[3]].join(".")],
      [key, "shopify-link-secret", "row-1", "v2" + sealed.slice(2)],
      [key, "shopify-link-secret", "row-1", "garbage"],
    ] as const) {
      assert.throws(
        () => openSecret(k, purpose, row, value),
        (e: Error) => /did not open/.test(e.message) && !e.message.includes("k".repeat(64)),
      );
    }
  });

  it("refuses a key that is not 32 bytes and a value with no row", () => {
    assert.throws(() => sealSecret(randomBytes(16), "shopify-access-token", "r", "x"), /32 bytes/);
    assert.throws(() => sealSecret(key, "shopify-access-token", "", "x"), /row/);
  });
});
