/**
 * A14 — the seven hard-invariant rail refusals, unit-tested in isolation.
 * Matches docs/owner-a-tasks.md A14 table and api-contracts.md §4.
 */

import { describe, expect, it } from "vitest";
import {
  checkRail,
  parsePinnedMandates,
  type RailConfig,
  type RailInput,
} from "../src/sign/rail";

const SIGNER = "0x9f6b4a5de73ce365238f27236ea04a747e691bf7"; // lowercased paying wallet
const RECIPIENT = "0x99a2b2962a6ac463fbe04664027fdb3f68bd4cc8"; // lowercased settlement recipient
const MANDATE_ID = `0x${"7f3a".padStart(64, "0")}`;

function makeInput(overrides: Partial<RailInput> = {}): RailInput {
  return {
    mandateId: MANDATE_ID,
    from: SIGNER,
    to: RECIPIENT,
    value: 5_000_000n,
    validAfter: 1786000000,
    validBefore: 1786000120, // 120s window
    chainId: 43113,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RailConfig> = {}): RailConfig {
  const pinned = parsePinnedMandates(
    JSON.stringify({
      [MANDATE_ID]: {
        settlementRecipient: RECIPIENT,
        hardMaxTotal: "30000000",
      },
    }),
  );
  return {
    pinned,
    signerAddress: SIGNER,
    chainId: 43113,
    hasSeenRequestId: () => false,
    ...overrides,
  };
}

describe("parsePinnedMandates", () => {
  it("loads and lowercases the map", () => {
    const map = parsePinnedMandates(
      JSON.stringify({
        [MANDATE_ID]: {
          settlementRecipient: RECIPIENT,
          hardMaxTotal: "30000000",
        },
      }),
    );
    expect(map.get(MANDATE_ID)).toEqual({
      settlementRecipient: RECIPIENT,
      hardMaxTotal: "30000000",
    });
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePinnedMandates("{not json")).toThrow(/valid JSON/);
  });

  it("throws on a malformed entry", () => {
    expect(() =>
      parsePinnedMandates(
        JSON.stringify({ [MANDATE_ID]: { hardMaxTotal: "1" } }),
      ),
    ).toThrow(/settlementRecipient or hardMaxTotal/);
  });
});

describe("the seven refusals", () => {
  it("passes a fully-valid request", () => {
    expect(checkRail(makeInput(), "req-1", makeConfig())).toEqual({ ok: true });
  });

  it("SIGNER_UNPINNED_MANDATE when mandateId is not pinned", () => {
    const res = checkRail(
      makeInput({ mandateId: `0x${"f".padStart(64, "0")}` }),
      "req-1",
      makeConfig(),
    );
    expect(res).toMatchObject({
      ok: false,
      code: "SIGNER_UNPINNED_MANDATE",
      status: 403,
    });
  });

  it("SIGNER_WRONG_RECIPIENT when message.to != pinned recipient", () => {
    const res = checkRail(
      makeInput({ to: `0x${"d".padStart(40, "0")}` }),
      "req-1",
      makeConfig(),
    );
    expect(res).toMatchObject({
      ok: false,
      code: "SIGNER_WRONG_RECIPIENT",
      status: 403,
    });
  });

  it("SIGNER_CEILING when message.value > hardMaxTotal", () => {
    const res = checkRail(
      makeInput({ value: 30_000_001n }),
      "req-1",
      makeConfig(),
    );
    expect(res).toMatchObject({
      ok: false,
      code: "SIGNER_CEILING",
      status: 403,
    });
  });

  it("SIGNER_WRONG_FROM when message.from != paying wallet", () => {
    const res = checkRail(
      makeInput({ from: `0x${"c".padStart(40, "0")}` }),
      "req-1",
      makeConfig(),
    );
    expect(res).toMatchObject({
      ok: false,
      code: "SIGNER_WRONG_FROM",
      status: 403,
    });
  });

  it("SIGNER_WRONG_CHAIN when domain.chainId != configured chain", () => {
    const res = checkRail(makeInput({ chainId: 43114 }), "req-1", makeConfig());
    expect(res).toMatchObject({
      ok: false,
      code: "SIGNER_WRONG_CHAIN",
      status: 403,
    });
  });

  it("SIGNER_WINDOW when validBefore - validAfter > 600", () => {
    const res = checkRail(
      makeInput({ validAfter: 1786000000, validBefore: 1786000601 }),
      "req-1",
      makeConfig(),
    );
    expect(res).toMatchObject({
      ok: false,
      code: "SIGNER_WINDOW",
      status: 403,
    });
  });

  it("SIGNER_REPLAY (409) when requestId was already signed", () => {
    const config = makeConfig({ hasSeenRequestId: (id) => id === "req-dup" });
    const res = checkRail(makeInput(), "req-dup", config);
    expect(res).toMatchObject({
      ok: false,
      code: "SIGNER_REPLAY",
      status: 409,
    });
  });
});
