/**
 * A6 — `GET /token/constants?chainId=43113`
 *
 * ⚠️ DO NOT CALL `version()`. It reverts on both chains, as do
 * `DOMAIN_SEPARATOR()` and `eip712Domain()` (docs/execution_plan.md §19.2). The
 * original spec said "read name(), version() and decimals() at startup" — that
 * spec crashes the service before it can serve anything. It was corrected in §9.
 *
 * `version` is therefore ALWAYS null here. That is correct behaviour, not a
 * failure. Callers take `version` from `challenge.extra.version`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CHAINS,
  isoSeconds,
  parseChainId,
  toChecksum,
  type ChainId,
  type TokenConstants,
} from "@straitsx/contracts";
import { assertDecimals, readTokenFacts } from "../chain";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes, per A6

type CacheEntry = { value: TokenConstants; expiresAt: number };
const cache = new Map<ChainId, CacheEntry>();

/** Exposed for tests. */
export function clearTokenConstantsCache(): void {
  cache.clear();
}

export async function getTokenConstants(
  chainId: ChainId,
  now: number = Date.now(),
): Promise<TokenConstants> {
  const hit = cache.get(chainId);
  if (hit && hit.expiresAt > now) return hit.value;

  const facts = await readTokenFacts(chainId);

  // Same assertion as boot, re-checked on every cold read: the Fuji contract is
  // an upgradeable proxy, so the implementation can change under us mid-event
  // (§19.2). Do not trust a value cached before an upgrade.
  assertDecimals(chainId, facts.decimals);

  const value: TokenConstants = {
    chainId,
    // §0: EIP-55 checksummed in JSON. The raw constants are mixed — Fuji's is
    // lowercase (as it came off the 402), mainnet's is checksummed — so the
    // same field would otherwise change casing with the chain.
    address: toChecksum(CHAINS[chainId].xsgd),
    name: facts.name,
    decimals: facts.decimals,
    version: null,
    versionSource: "x402-challenge-only",
    // Whole seconds, matching the §3 sample "2026-08-15T05:46:23Z".
    readAt: isoSeconds(now),
  };

  cache.set(chainId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

export function registerTokenConstantsRoute(app: FastifyInstance): void {
  app.get(
    "/token/constants",
    async (req: FastifyRequest<{ Querystring: { chainId?: string } }>) => {
      const chainId = parseChainId(req.query.chainId);
      return getTokenConstants(chainId);
    },
  );
}
