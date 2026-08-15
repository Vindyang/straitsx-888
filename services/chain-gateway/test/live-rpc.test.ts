/**
 * Live-chain integration. Opt-in with `LIVE_RPC=1 pnpm test` so CI stays green
 * when Fuji is having a bad day — but run it before every checkpoint, because
 * it is the only thing that proves the facts in execution_plan.md §19.2 are
 * still true. The Fuji XSGD contract is an UPGRADEABLE PROXY; its
 * implementation can change under us mid-event.
 */

import { describe, expect, it } from "vitest";
import { CHAINS, XSGD_DECIMALS } from "@straitsx/contracts";
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
    expect(constants.address).toBe(CHAINS[43113].xsgd);
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
