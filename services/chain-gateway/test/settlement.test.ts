/**
 * A8's Done-when: "a deliberately mismatched `expect` returns ok: false. This
 * is what makes the receipt trustworthy rather than decorative."
 *
 * These test `findMatchingTransfer` directly — the log-matching logic is the
 * whole point of the endpoint, and it is pure.
 */

import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toHex, pad } from "viem";
import { findMatchingTransfer } from "../src/routes/settlement";

const XSGD = "0xd769410dc8772695a7f55a304d2125320a65c2a5";
const OTHER_TOKEN = "0xb2F85b7AB3c2b6f62DF06dE6aE7D09c010a5096E";
const PAY_TO = "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const PAYER = "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7";

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

function transferLog(opts: {
  token: string;
  from?: string;
  to: string;
  value: bigint;
  logIndex?: number;
}) {
  return {
    address: opts.token,
    topics: [
      TRANSFER_TOPIC,
      pad(opts.from ?? (PAYER as `0x${string}`), { size: 32 }),
      pad(opts.to as `0x${string}`, { size: 32 }),
    ] as readonly string[],
    data: encodeAbiParameters([{ type: "uint256" }], [opts.value]),
    logIndex: opts.logIndex ?? 0,
  };
}

const EXPECT = { asset: XSGD, to: PAY_TO, amount: "5000000" };

describe("findMatchingTransfer", () => {
  it("matches a correct Transfer log", () => {
    const logs = [transferLog({ token: XSGD, to: PAY_TO, value: 5_000_000n, logIndex: 2 })];
    expect(findMatchingTransfer(logs, EXPECT)).toEqual({ logIndex: 2 });
  });

  it("returns null when the recipient differs — the substituted-payee case", () => {
    const logs = [transferLog({ token: XSGD, to: ATTACKER, value: 5_000_000n })];
    expect(findMatchingTransfer(logs, EXPECT)).toBeNull();
  });

  it("returns null when the amount differs", () => {
    const logs = [transferLog({ token: XSGD, to: PAY_TO, value: 4_999_999n })];
    expect(findMatchingTransfer(logs, EXPECT)).toBeNull();
  });

  it("returns null when the asset differs — right amount, wrong token", () => {
    const logs = [transferLog({ token: OTHER_TOKEN, to: PAY_TO, value: 5_000_000n })];
    expect(findMatchingTransfer(logs, EXPECT)).toBeNull();
  });

  it("returns null for a receipt with no logs at all", () => {
    expect(findMatchingTransfer([], EXPECT)).toBeNull();
  });

  /**
   * The reason all three fields must match on ONE log. Here the asset matches on
   * log 0, the recipient on log 1 and the amount on log 2 — nothing settled what
   * we asked for, and a per-field scan across logs would wrongly pass.
   */
  it("does not match fields spread across different logs", () => {
    const logs = [
      transferLog({ token: XSGD, to: ATTACKER, value: 1n, logIndex: 0 }),
      transferLog({ token: OTHER_TOKEN, to: PAY_TO, value: 1n, logIndex: 1 }),
      transferLog({ token: OTHER_TOKEN, to: ATTACKER, value: 5_000_000n, logIndex: 2 }),
    ];
    expect(findMatchingTransfer(logs, EXPECT)).toBeNull();
  });

  it("finds the match among unrelated logs and reports its logIndex", () => {
    const logs = [
      transferLog({ token: OTHER_TOKEN, to: ATTACKER, value: 999n, logIndex: 0 }),
      { address: XSGD, topics: [keccak256(toHex("Approval(address,address,uint256)"))], data: "0x", logIndex: 1 },
      transferLog({ token: XSGD, to: PAY_TO, value: 5_000_000n, logIndex: 2 }),
    ];
    expect(findMatchingTransfer(logs, EXPECT)).toEqual({ logIndex: 2 });
  });

  it("compares addresses case-insensitively (§0: compare lowercased)", () => {
    const logs = [
      transferLog({ token: XSGD.toUpperCase().replace("0X", "0x"), to: PAY_TO.toLowerCase(), value: 5_000_000n }),
    ];
    expect(findMatchingTransfer(logs, EXPECT)).toEqual({ logIndex: 0 });
  });

  it("compares amounts numerically, not as strings", () => {
    const logs = [transferLog({ token: XSGD, to: PAY_TO, value: 5_000_000n })];
    expect(findMatchingTransfer(logs, { ...EXPECT, amount: "05000000" })).toEqual({
      logIndex: 0,
    });
  });

  /** 6 decimals, not 18. An 18-decimal encoding of "5 XSGD" is 10^12 too big. */
  it("rejects an 18-decimal encoding of the same nominal amount", () => {
    const logs = [
      transferLog({ token: XSGD, to: PAY_TO, value: 5_000_000_000_000_000_000n }),
    ];
    expect(findMatchingTransfer(logs, EXPECT)).toBeNull();
  });

  it("ignores logs that are not decodable as Transfer", () => {
    const logs = [
      { address: XSGD, topics: ["0xdeadbeef"], data: "0x1234", logIndex: 0 },
      transferLog({ token: XSGD, to: PAY_TO, value: 5_000_000n, logIndex: 1 }),
    ];
    expect(findMatchingTransfer(logs, EXPECT)).toEqual({ logIndex: 1 });
  });
});
