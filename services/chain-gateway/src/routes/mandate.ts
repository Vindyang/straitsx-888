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
import {
  AppError,
  ErrorCode,
  MANDATE_REGISTRY_ABI,
  parseChainId,
  parseMandateId,
  requireRegistryAddress,
  toChecksum,
  type MandateReadResponse,
} from "@straitsx/contracts";
import { getPublicClient, withRpc } from "../chain";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
      // Throws RegistryNotDeployedError (an AppError -> 400
      // CHAIN_NOT_CONFIGURED) when the address is null. Refuse, never default.
      const registryAddress = requireRegistryAddress(chainId) as `0x${string}`;
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
        owner: toChecksum(owner), // EIP-55 checksummed in JSON (§0)
        policyHash: policyHash.toLowerCase(),
        expiresAt: Number(expiresAt),
        revoked,
        readAtBlock: Number(blockNumber),
      };
    },
  );
}
