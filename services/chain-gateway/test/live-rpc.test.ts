/**
 * Live-chain integration. Opt-in with `LIVE_RPC=1 pnpm test` so CI stays green
 * when Fuji is having a bad day — but run it before every checkpoint, because
 * it is the only thing that proves the facts in execution_plan.md §19.2 are
 * still true. The Fuji XSGD contract is an UPGRADEABLE PROXY; its
 * implementation can change under us mid-event.
 */

import { describe, expect, it } from "vitest";
import {
  CHAINS,
  XSGD_DECIMALS,
  getRegistryAddress,
  toChecksum,
} from "@straitsx/contracts";
import { buildApp } from "../src/app";
import { readTokenFacts } from "../src/chain";
import { clearTokenConstantsCache, getTokenConstants } from "../src/routes/token-constants";

const live = process.env["LIVE_RPC"] === "1";

describe.skipIf(!live)("live Fuji RPC (43113)", () => {
  it("XSGD reports name=XSGD and decimals=6", async () => {
    const facts = await readTokenFacts(43113);
    expect(facts.name).toBe("XSGD");
    expect(facts.decimals).toBe(XSGD_DECIMALS);
  }, 30_000);

  it("GET /token/constants returns version: null, never a guess", async () => {
    clearTokenConstantsCache();
    const constants = await getTokenConstants(43113);

    expect(constants.chainId).toBe(43113);
    // EIP-55 checksummed in JSON (§0). The raw constant is lowercase — as it
    // came off the 402 — so the route normalises rather than echoing it, and
    // the same field cannot change casing depending on the chain.
    expect(constants.address).toBe(toChecksum(CHAINS[43113].xsgd));
    expect(constants.address.toLowerCase()).toBe(CHAINS[43113].xsgd);
    expect(constants.name).toBe("XSGD");
    expect(constants.decimals).toBe(6);
    // version() reverts on both chains. null here is correct behaviour.
    expect(constants.version).toBeNull();
    expect(constants.versionSource).toBe("x402-challenge-only");
    expect(constants.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 30_000);

  it("caches within the TTL rather than re-reading", async () => {
    clearTokenConstantsCache();
    const first = await getTokenConstants(43113, 1_000);
    const second = await getTokenConstants(43113, 1_000 + 60_000);
    expect(second.readAt).toBe(first.readAt);
  }, 30_000);

  it("re-reads once the 15-minute TTL has passed", async () => {
    clearTokenConstantsCache();
    const first = await getTokenConstants(43113, 1_000);
    const second = await getTokenConstants(43113, 1_000 + 16 * 60_000);
    expect(second.readAt).not.toBe(first.readAt);
  }, 30_000);
});

/**
 * A7 against the deployed registry. Skipped unless the chain is actually
 * deployed, so this file never fails for a reason that is really "A4 is not
 * done yet".
 */
describe.skipIf(!live || getRegistryAddress(43113) === null)(
  "live mandate reads against the deployed registry (43113)",
  () => {
    const app = buildApp({ internalToken: "live-test-token" });
    const auth = { "x-internal-token": "live-test-token" };

    it("maps owner == address(0) to 404 MANDATE_NOT_FOUND", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/mandate/0x${"7f3a".padStart(64, "0")}?chainId=43113`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("MANDATE_NOT_FOUND");
    }, 30_000);

    /**
     * The registry reverts NotOwner for a non-owner AND for an unknown id
     * (whose owner is address(0)). build-revoke simulates before building, so
     * the human learns why their kill switch did not arm.
     */
    it("build-revoke refuses a non-owner with 403 rather than handing back a doomed tx", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/tx/build-revoke",
        headers: auth,
        payload: {
          mandateId: `0x${"7f3a".padStart(64, "0")}`,
          chainId: 43113,
          from: "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/only the owner can revoke/);
    }, 30_000);
  },
);
