/**
 * A7 — `GET /mandate/:mandateId?chainId=43113`
 *
 * Reads the registry through the published ABI. `owner == address(0)` is the
 * contract's unknown-id sentinel and maps to 404 MANDATE_NOT_FOUND.
 *
 * `readAtBlock` is in the response because Owner B's check 1 must never cache
 * revocation state — demo Run 3 depends on a revoke landing within one block,
 * and the block number is how a judge sees the read was fresh. There is no
 * cache in this file, deliberately.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { getAddress } from "viem";
import {
  AppError,
  ErrorCode,
  MANDATE_REGISTRY_ABI,
  RegistryNotDeployedError,
  requireRegistryAddress,
  type MandateReadResponse,
} from "@straitsx/contracts";
import { getPublicClient, parseChainId, withRpc } from "../chain";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** bytes32: `0x` + 64 hex. */
export function parseMandateId(raw: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw AppError.badRequest(
      `mandateId must be 0x-prefixed 32-byte hex, got "${raw}"`,
    );
  }
  return raw.toLowerCase() as `0x${string}`;
}

/** A null address in registry.json must REFUSE, never default to something. */
export function resolveRegistryAddress(chainId: 43113 | 43114): `0x${string}` {
  try {
    return requireRegistryAddress(chainId) as `0x${string}`;
  } catch (err) {
    if (err instanceof RegistryNotDeployedError) {
      throw AppError.badRequest(err.message, ErrorCode.CHAIN_NOT_CONFIGURED);
    }
    throw err;
  }
}

export function registerMandateRoute(app: FastifyInstance): void {
  app.get(
    "/mandate/:mandateId",
    async (
      req: FastifyRequest<{
        Params: { mandateId: string };
        Querystring: { chainId?: string };
      }>,
    ): Promise<MandateReadResponse> => {
      const chainId = parseChainId(req.query.chainId);
      const mandateId = parseMandateId(req.params.mandateId);
      const registryAddress = resolveRegistryAddress(chainId);
      const client = getPublicClient(chainId);

      const [result, blockNumber] = await withRpc(
        `reading mandate on chain ${chainId}`,
        () =>
          Promise.all([
            client.readContract({
              address: registryAddress,
              abi: MANDATE_REGISTRY_ABI,
              functionName: "get",
              args: [mandateId],
            }) as Promise<readonly [string, string, bigint, boolean]>,
            client.getBlockNumber(),
          ]),
      );

      const [owner, policyHash, expiresAt, revoked] = result;

      if (owner.toLowerCase() === ZERO_ADDRESS) {
        throw AppError.notFound(
          ErrorCode.MANDATE_NOT_FOUND,
          `no mandate ${mandateId} on chain ${chainId}`,
        );
      }

      return {
        mandateId,
        owner: getAddress(owner), // EIP-55 checksummed in JSON (§0)
        policyHash: policyHash.toLowerCase(),
        expiresAt: Number(expiresAt),
        revoked,
        readAtBlock: Number(blockNumber),
      };
    },
  );
}
