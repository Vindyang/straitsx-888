import { describe, expect, it } from "vitest";
import { formatUnits as viemFormatUnits } from "viem";
import { formatUnits } from "../src/routes/balance";

/**
 * 6 decimals, not 18. An 18-decimal assumption mis-encodes by 10^12 and the
 * signature then verifies against the wrong value — silently.
 */
describe("formatUnits", () => {
  it("formats 30 XSGD", () => {
    expect(formatUnits(30_000_000n, 6)).toBe("30.000000");
  });

  it("formats 5 XSGD — the minimum card amount", () => {
    expect(formatUnits(5_000_000n, 6)).toBe("5.000000");
  });

  it("keeps leading zeros in the fraction", () => {
    expect(formatUnits(1n, 6)).toBe("0.000001");
  });

  it("formats zero", () => {
    expect(formatUnits(0n, 6)).toBe("0.000000");
  });

  it("handles values above Number.MAX_SAFE_INTEGER without precision loss", () => {
    const huge = 123456789012345678901234567890n;
    expect(formatUnits(huge, 6)).toBe("123456789012345678901234.567890");
  });

  it("formats 18-decimal AVAX wei too", () => {
    expect(formatUnits(1_000_000_000_000_000n, 18)).toBe("0.001000000000000000");
  });

  it("supports 0 decimals", () => {
    expect(formatUnits(42n, 0)).toBe("42");
  });

  /**
   * Why this is not viem's formatUnits, which a reviewer flagged as duplication.
   * viem TRIMS trailing zeros; §3 pins xsgdFormatted to a fixed 6dp
   * ("30.000000"). Fixed width is the point — a money column should not jitter
   * between "30" and "29.999999". This test fails the day viem changes, which
   * is exactly when we would want to know.
   */
  it("differs from viem formatUnits, deliberately: fixed width vs trimmed", () => {
    expect(viemFormatUnits(30_000_000n, 6)).toBe("30");
    expect(formatUnits(30_000_000n, 6)).toBe("30.000000");
  });
});
