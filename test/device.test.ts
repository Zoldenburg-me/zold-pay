import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hashTypedData, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Browser globals device.js expects. localStorage is the only real stand-in;
// WebCrypto, atob and btoa come from node.
const slots = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => slots.get(k) ?? null,
  setItem: (k: string, v: string) => slots.set(k, v),
  removeItem: (k: string) => slots.delete(k),
};
(globalThis as any).window = {};

const setNavigator = (value: unknown) =>
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });

const dev: any = await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/device.js"));

const TYPED_DATA = {
  domain: { name: "TransF Safe Transfer", version: "1", chainId: 31337, verifyingContract: "0x1111111111111111111111111111111111111111" },
  types: {
    PaymentAuthorization: [
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
      { name: "transferId", type: "bytes32" },
      { name: "destination", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "PaymentAuthorization",
  message: {
    account: "0x1111111111111111111111111111111111111111",
    amount: "100000000000000000000",
    to: "0x2222222222222222222222222222222222222222",
    transferId: `0x${"ab".repeat(32)}`,
    destination: `0x${"cd".repeat(32)}`,
    deadline: 1790000000,
  },
} as const;

const viemDigest = hashTypedData({
  ...(TYPED_DATA as any),
  message: { ...TYPED_DATA.message, amount: 100000000000000000000n, deadline: 1790000000n },
});

describe("device key: EIP-712 and signing (no PRF authenticator)", () => {
  it("computes the digest byte for byte like viem", () => {
    assert.equal(`0x${Buffer.from(dev.eip712Digest(TYPED_DATA)).toString("hex")}`, viemDigest);
  });

  it("mints an unprotected key when there is no PRF, and says so", async () => {
    const { address, protection } = await dev.createKey(null);
    assert.equal(protection, "none");
    assert.match(address, /^0x[0-9a-f]{40}$/);
  });

  it("signs so that the signature recovers to the device address", async () => {
    const address = await dev.deviceAddress(null);
    const sig = await dev.signTypedData(TYPED_DATA, null);
    assert.equal((await recoverAddress({ hash: viemDigest, signature: sig })).toLowerCase(), address);
  });
});

describe("device key: passkey-wrapped at rest (PRF)", () => {
  const PRF = new Uint8Array(32).fill(7);
  const priv = `0x${"11".repeat(32)}`;

  it("round-trips with the same secret and never stores the key in the clear", async () => {
    const blob = await dev.wrapKey(priv, PRF);
    assert.equal(blob.protection, "prf");
    assert.equal(blob.key, undefined);
    assert.equal(JSON.stringify(blob).includes("11".repeat(32)), false);
    assert.equal(await dev.unwrapKey(blob, PRF), priv);
  });

  it("refuses a different secret and uses a fresh IV each time", async () => {
    const a = await dev.wrapKey(priv, PRF);
    const b = await dev.wrapKey(priv, PRF);
    assert.notEqual(a.iv, b.iv);
    await assert.rejects(() => dev.unwrapKey(a, new Uint8Array(32).fill(9)));
  });

  it("will not sign while locked, but still reports the cached address", async () => {
    slots.set("zold-device-key", JSON.stringify({
      ...(await dev.wrapKey(priv, PRF)),
      address: privateKeyToAccount(priv as `0x${string}`).address.toLowerCase(),
    }));
    setNavigator(undefined);
    await assert.rejects(() => dev.signTypedData(TYPED_DATA, "cred"), /passkey is needed/);
    assert.equal(await dev.deviceAddress("cred"), privateKeyToAccount(priv as `0x${string}`).address.toLowerCase());
  });
});

describe("passkeyAssertion", () => {
  const buf = (...bytes: number[]) => new Uint8Array(bytes).buffer;
  let asked: any;
  before(() => {
    setNavigator({
      credentials: {
        get: async (opts: unknown) => {
          asked = opts;
          return { response: { authenticatorData: buf(1, 2), clientDataJSON: buf(3), signature: buf(4, 5, 6) } };
        },
      },
    });
  });

  it("asks the authenticator for a user-verified assertion on exactly the issued credential", async () => {
    const out = await dev.passkeyAssertion({ challenge: "AQID", credentialId: "BAUG" });
    assert.equal(asked.publicKey.userVerification, "required");
    assert.deepEqual([...new Uint8Array(asked.publicKey.challenge)], [1, 2, 3]);
    assert.deepEqual([...new Uint8Array(asked.publicKey.allowCredentials[0].id)], [4, 5, 6]);
    assert.equal(asked.publicKey.allowCredentials.length, 1);
    assert.deepEqual(out, { credentialId: "BAUG", authenticatorData: "AQI", clientDataJSON: "Aw", signature: "BAUG" });
  });

  it("returns undefined when the server issued nothing to approve", async () => {
    assert.equal(await dev.passkeyAssertion(undefined), undefined);
    assert.equal(await dev.passkeyAssertion({ credentialId: "x" }), undefined);
    assert.equal(await dev.passkeyAssertion({ challenge: "x" }), undefined);
  });
});
