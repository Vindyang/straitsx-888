/**
 * DER codec + low-s normalisation tests (A13). Pure, offline, no network.
 */

import { describe, expect, it } from "vitest";
import {
  SECP256K1_ORDER,
  SECP256K1_HALF_ORDER,
  encodeSignatureDer,
  isHighS,
  normaliseS,
  parseSignatureDer,
} from "../src/keys/der";

const R = 0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80n;
const S_LOW =
  0x0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9n;

describe("encodeSignatureDer / parseSignatureDer", () => {
  it("round-trips r and s", () => {
    const der = encodeSignatureDer(R, S_LOW);
    expect(parseSignatureDer(der)).toEqual({ r: R, s: S_LOW });
  });

  it("handles an r with a leading zero byte (top bit set)", () => {
    // r with the top bit of the most-significant byte set forces a 0x00 prefix.
    const rTopBit = 0x80n << 248n;
    const der = encodeSignatureDer(rTopBit, S_LOW);
    expect(parseSignatureDer(der)).toEqual({ r: rTopBit, s: S_LOW });
  });

  it("rejects a DER that is not a SEQUENCE", () => {
    expect(() => parseSignatureDer(new Uint8Array([0x02, 0x00]))).toThrow(
      /SEQUENCE/,
    );
  });

  it("rejects out-of-range s (>= n) at encode time", () => {
    expect(() => encodeSignatureDer(R, SECP256K1_ORDER)).toThrow(
      /out of range/,
    );
  });
});

describe("normaliseS / isHighS", () => {
  it("leaves a low s unchanged", () => {
    expect(isHighS(S_LOW)).toBe(false);
    expect(normaliseS(S_LOW)).toBe(S_LOW);
  });

  it("flips a high s to n - s", () => {
    const sHigh = SECP256K1_HALF_ORDER + 1n;
    expect(isHighS(sHigh)).toBe(true);
    expect(normaliseS(sHigh)).toBe(SECP256K1_ORDER - sHigh);
  });

  it("treats exactly n/2 as low (boundary inclusive)", () => {
    expect(isHighS(SECP256K1_HALF_ORDER)).toBe(false);
    expect(normaliseS(SECP256K1_HALF_ORDER)).toBe(SECP256K1_HALF_ORDER);
  });
});
