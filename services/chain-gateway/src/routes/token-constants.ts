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
  AppError,
  CHAINS,
  ErrorCode,
  XSGD_DECIMALS,
  type ChainId,
  type TokenConstants,
} from "@straitsx/contracts";
import { parseChainId, readTokenFacts } from "../chain";

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
  if (facts.decimals !== XSGD_DECIMALS) {
    throw new AppError(
      502,
      ErrorCode.RPC_FAILED,
      `XSGD on chain ${chainId} reports decimals=${facts.decimals}, expected ${XSGD_DECIMALS}`,
    );
  }

  const value: TokenConstants = {
    chainId,
    address: CHAINS[chainId].xsgd,
    name: facts.name,
    decimals: facts.decimals,
    version: null,
    versionSource: "x402-challenge-only",
    readAt: new Date(now).toISOString(),
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
