/**
 * The §0 conventions, tested once. These were previously inlined per route and
 * had already drifted (mandateId lowercased, txHash not) — the drift is the
 * reason this module exists, so it gets its own tests.
 */

import { describe, expect, it } from "vitest";
import {
  AppError,
  CARDAPI_PRODUCTION_ISSUE_CARD,
  ErrorCode,
  MCP_SSE_PRODUCTION,
  isoSeconds,
  parseAddress,
  parseBytes32,
  parseChainId,
  parseMandateId,
  parseTxHash,
  parseUint,
  refuseIfNull,
  requireObject,
  toChecksum,
} from "../src/index";

const ADDR = "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7";
const B32 = `0x${"a".repeat(64)}`;

describe("parseAddress", () => {
  it("accepts a checksummed address and lowercases it (§0: compare lowercased)", () => {
    expect(parseAddress(ADDR)).toBe(ADDR.toLowerCase());
  });

  it.each([
    ["too short", "0x1234"],
    ["no 0x prefix", "9f6B4A5DE73CE365238F27236ea04A747E691bF7"],
    ["not hex", `0x${"z".repeat(40)}`],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, input) => {
    expect(() => parseAddress(input)).toThrow(AppError);
  });

  it("names the field in the message so a judge can read the refusal", () => {
    expect(() => parseAddress("nope", "expect.to")).toThrow(/expect\.to/);
  });
});

describe("parseBytes32 / parseMandateId / parseTxHash", () => {
  it("lowercases, so mandateId and txHash no longer disagree", () => {
    const upper = `0x${"A".repeat(64)}`;
    expect(parseMandateId(upper)).toBe(B32);
    expect(parseTxHash(upper)).toBe(B32);
    expect(parseBytes32(upper)).toBe(B32);
  });

  it("rejects a 20-byte value", () => {
    expect(() => parseMandateId(ADDR)).toThrow(AppError);
  });
});

describe("parseUint", () => {
  it("accepts a base-unit decimal string", () => {
    expect(parseUint("5000000")).toBe("5000000");
  });

  /** §0: money is "never a JSON number — 2^53 and float rounding both bite". */
  it("rejects a JSON number even when it is the right value", () => {
    expect(() => parseUint(5000000)).toThrow(/base-unit decimal string/);
  });

  it.each([["negative", "-1"], ["decimal", "5.0"], ["empty", ""], ["hex", "0x5"]])(
    "rejects %s",
    (_label, input) => {
      expect(() => parseUint(input)).toThrow(AppError);
    },
  );
});

describe("parseChainId", () => {
  it.each([[43113], [43114]])("accepts %i", (id) => {
    expect(parseChainId(id)).toBe(id);
    expect(parseChainId(String(id))).toBe(id);
  });

  it("rejects mainnet ethereum with UNSUPPORTED_CHAIN", () => {
    try {
      parseChainId(1);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCode.UNSUPPORTED_CHAIN);
      expect((err as AppError).statusCode).toBe(400);
    }
  });

  it("rejects a missing chainId", () => {
    expect(() => parseChainId(undefined)).toThrow(AppError);
    expect(() => parseChainId("")).toThrow(AppError);
  });
});

describe("requireObject", () => {
  it("rejects an array — JSON arrays are not bodies", () => {
    expect(() => requireObject([])).toThrow(AppError);
  });

  it("rejects null", () => {
    expect(() => requireObject(null)).toThrow(AppError);
  });
});

describe("refuseIfNull", () => {
  /** §0: "Any code path that reads a null here must refuse, never default." */
  it("refuses on null rather than substituting a default", () => {
    try {
      refuseIfNull(null, ErrorCode.CHAIN_NOT_CONFIGURED, "mainnet version not fetched");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCode.CHAIN_NOT_CONFIGURED);
    }
  });

  it("passes a real value through", () => {
    expect(refuseIfNull("2", ErrorCode.CHAIN_NOT_CONFIGURED, "x")).toBe("2");
  });
});

describe("isoSeconds", () => {
  /** §3 sample is "2026-08-15T05:46:23Z" — no milliseconds. */
  it("emits whole seconds with a Z suffix", () => {
    expect(isoSeconds(Date.UTC(2026, 7, 15, 5, 46, 23, 456))).toBe(
      "2026-08-15T05:46:23Z",
    );
  });
});

describe("toChecksum", () => {
  it("restores EIP-55 casing for JSON output (§0)", () => {
    expect(toChecksum(ADDR.toLowerCase())).toBe(ADDR);
  });
});

describe("production endpoints", () => {
  /**
   * These were previously guessed by substituting "sandbox" -> "production",
   * which is the defaulting §0 forbids. Production is also an open PERMISSION
   * question (§19.7), not merely an unknown URL. A18 resolves it.
   */
  it("are null, not derived from the sandbox URLs", () => {
    expect(CARDAPI_PRODUCTION_ISSUE_CARD).toBeNull();
    expect(MCP_SSE_PRODUCTION).toBeNull();
  });
});
