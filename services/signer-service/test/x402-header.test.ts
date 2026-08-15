/**
 * The `PAYMENT-SIGNATURE` header format — pinned against the x402 `exact`
 * scheme for EVM (specs/schemes/exact/scheme_exact_evm.md).
 *
 * WHY THIS FILE EXISTS. The header previously carried
 * `base64(JSON(typedData))` — the EIP-712 domain, types and message, and NO
 * SIGNATURE AT ALL. A facilitator receiving that cannot settle anything. The
 * only assertion guarding it was `typeof body.header === "string"`, which that
 * bug passed happily. The symptom would have been a 402 that never clears,
 * looking exactly like a wrong-domain bug (owner-a-tasks.md A13) — hours spent
 * on the domain assertion while the header was the problem.
 *
 * These tests decode the base64 and assert the actual structure, so the format
 * cannot silently regress again.
 */

import { describe, expect, it } from "vitest";
import { hexToBytes } from "viem";
import { buildLocalKeySource } from "../src/keys/local-key-source";
import { deriveAddressFromSpki } from "../src/keys/derive-address";
import {
  buildTransferWithAuthorizationTypedData,
  digestTypedData,
} from "../src/sign/typed-data";
import {
  buildX402Header,
  packSignature65,
  signDigestWithKeySource,
} from "../src/sign/pipeline";

const PRIVATE_KEY = `0x${"1".padStart(64, "0")}` as `0x${string}`;

const AUTHORIZATION = {
  from: "0x0f6ddd6fc1fb06b3e91a77cb1597acac8a037ca7" as `0x${string}`,
  to: "0x99a2b2962a6ac463fbe04664027fdb3f68bd4cc8" as `0x${string}`,
  value: "5000000",
  validAfter: "1786000000",
  validBefore: "1786000120",
  nonce: `0x${"9c1f".padStart(64, "0")}` as `0x${string}`,
};

const RESOURCE = "https://card.straitsx.ai/sandbox/cardapi/issue_card";

/** The `accepts[]` entry from the live Fuji sandbox challenge (2026-08-15). */
const ACCEPTED = {
  scheme: "exact" as const,
  network: "eip155:43113",
  chainId: 43113,
  amount: "5000000",
  asset: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
  payTo: "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8",
  maxTimeoutSeconds: 300,
  extra: {
    assetTransferMethod: "eip3009" as const,
    name: "XSGD",
    version: "2",
  },
};

const HEADER_INPUT = {
  x402Version: 1,
  resource: RESOURCE,
  accepted: ACCEPTED,
  authorization: AUTHORIZATION,
};

function decode(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

describe("packSignature65", () => {
  it("packs r, s, v into a 65-byte 0x hex string", () => {
    const packed = packSignature65({
      v: 28,
      r: `0x${"a".repeat(64)}`,
      s: `0x${"b".repeat(64)}`,
    });
    expect(packed).toBe(`0x${"a".repeat(64)}${"b".repeat(64)}1c`);
    // 2 for "0x" + 130 hex chars = 65 bytes.
    expect(hexToBytes(packed).length).toBe(65);
  });

  it("keeps v as the trailing byte in 27/28 form, not 0/1", () => {
    // The token contract's ecrecover expects the Ethereum wire form. Emitting
    // 0/1 here produces a signature that recovers a different address.
    expect(packSignature65({ v: 27, r: "0x1", s: "0x2" }).slice(-2)).toBe("1b");
    expect(packSignature65({ v: 28, r: "0x1", s: "0x2" }).slice(-2)).toBe("1c");
  });

  it("left-pads short r and s to a full 32 bytes each", () => {
    // A small r would otherwise shorten the string and shift v out of place.
    const packed = packSignature65({ v: 27, r: "0x01", s: "0x02" });
    expect(hexToBytes(packed).length).toBe(65);
    expect(packed).toBe(`0x${"0".repeat(63)}1${"0".repeat(63)}21b`);
  });
});

describe("buildX402Header", () => {
  const header = buildX402Header(HEADER_INPUT, {
    v: 28,
    r: `0x${"a".repeat(64)}`,
    s: `0x${"b".repeat(64)}`,
  });
  const decoded = decode(header) as {
    x402Version: number;
    resource: string;
    accepted: Record<string, unknown>;
    payload: { signature: string; authorization: Record<string, unknown> };
    extensions: Record<string, unknown>;
  };

  it("is base64 of the x402 V2 envelope", () => {
    // { x402Version, resource, accepted, payload, extensions } — confirmed
    // against the live facilitator at checkpoint 2 (settlement 0xe6dcb85e…).
    expect(Object.keys(decoded).sort()).toEqual([
      "accepted",
      "extensions",
      "payload",
      "resource",
      "x402Version",
    ]);
    expect(decoded.x402Version).toBe(1);
    expect(decoded.resource).toBe(RESOURCE);
  });

  it("CARRIES `accepted` — without it the facilitator cannot read the amount", () => {
    // The v1 envelope { x402Version, scheme, network, payload } was rejected
    // with `cannot parse payment amount: invalid atomic amount ""`. So were
    // `paymentRequirements` and `accepts` (plural). The key is `accepted`.
    expect(decoded.accepted).toBeDefined();
    expect(decoded.accepted["amount"]).toBe("5000000");
    // CAIP-2, observed live. "avalanche-fuji" was the original guess and wrong.
    expect(decoded.accepted["network"]).toBe("eip155:43113");
    expect(decoded.accepted["payTo"]).toBe(ACCEPTED.payTo);
  });

  it("CARRIES THE SIGNATURE — the bug this file was written for", () => {
    expect(decoded.payload.signature).toBe(
      `0x${"a".repeat(64)}${"b".repeat(64)}1c`,
    );
    expect(hexToBytes(decoded.payload.signature as `0x${string}`).length).toBe(
      65,
    );
  });

  it("carries the six EIP-3009 authorization fields", () => {
    expect(Object.keys(decoded.payload.authorization).sort()).toEqual([
      "from",
      "nonce",
      "to",
      "validAfter",
      "validBefore",
      "value",
    ]);
  });

  it("encodes value, validAfter and validBefore as STRINGS, not numbers", () => {
    // The spec example carries "10000" / "1740672089" / "1740672154". JSON
    // numbers here are a shape mismatch a facilitator rejects without saying why.
    const a = decoded.payload.authorization;
    expect(typeof a["value"]).toBe("string");
    expect(typeof a["validAfter"]).toBe("string");
    expect(typeof a["validBefore"]).toBe("string");
  });

  it("does NOT leak the EIP-712 types or domain into the header", () => {
    // Those belong to the digest, not the payment payload. Their presence was
    // the signature of the old bug.
    expect(decoded).not.toHaveProperty("types");
    expect(decoded).not.toHaveProperty("domain");
    expect(decoded).not.toHaveProperty("primaryType");
    expect(decoded.payload).not.toHaveProperty("message");
  });
});

describe("end-to-end through the signing pipeline", () => {
  it("produces a header whose signature matches the returned { v, r, s }", async () => {
    const source = buildLocalKeySource(PRIVATE_KEY);
    const derivedAddress = deriveAddressFromSpki(
      await source.getPublicKeyDer(),
    );

    const typedData = buildTransferWithAuthorizationTypedData({
      from: AUTHORIZATION.from,
      to: AUTHORIZATION.to,
      value: AUTHORIZATION.value,
      validAfter: Number(AUTHORIZATION.validAfter),
      validBefore: Number(AUTHORIZATION.validBefore),
      nonce: AUTHORIZATION.nonce,
      domain: {
        name: "XSGD",
        version: "2",
        chainId: 43113,
        verifyingContract: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
      },
    });

    const result = await signDigestWithKeySource(
      source,
      hexToBytes(digestTypedData(typedData)),
      derivedAddress,
      HEADER_INPUT,
    );

    const decoded = decode(result.header) as {
      payload: { signature: string };
    };
    // The two representations must agree: the header is the only thing sent to
    // cardapi, and `signature` is what Owner B logs on the receipt.
    expect(decoded.payload.signature).toBe(packSignature65(result.signature));
  });
});
