import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashSecret, newToken, safeEqual, secretMatchesHash } from "../server/src/secrets.js";

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
