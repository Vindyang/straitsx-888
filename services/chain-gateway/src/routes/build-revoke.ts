/**
 * A9 — `POST /tx/build-revoke`
 *
 * Returns an UNSIGNED transaction. chain-gateway never signs anything: the
 * human signs the revoke in their own wallet from the dashboard, which is what
 * makes "only the owner can revoke" true off-chain as well as on-chain.
 *
 * `from` is not decoration. The call is simulated as that address first, so an
 * unauthorised or already-revoked mandate fails HERE, with a named code, rather
 * than as an opaque "transaction will fail" in the wallet — the human is about
 * to hit their kill switch and deserves to know why it did not arm.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { encodeFunctionData } from "viem";
import {
  AppError,
  ErrorCode,
  MANDATE_REGISTRY_ABI,
  parseAddress,
  parseChainId,
  parseMandateId,
  requireObject,
  requireRegistryAddress,
  toChecksum,
  type BuildRevokeRequest,
  type UnsignedTx,
} from "@straitsx/contracts";
import { getPublicClient, withRpc } from "../chain";

/** `revoke` writes one bool in an already-warm slot; measured at ~62k gas in
 *  the forge suite, so 80k is generous but bounded. */
const REVOKE_GAS_LIMIT = "80000";

function parseBody(body: unknown): BuildRevokeRequest {
  const b = requireObject(body);
  return {
    mandateId: parseMandateId(b["mandateId"]),
    chainId: Number(b["chainId"]),
    from: parseAddress(b["from"], "from"),
  };
}

export function registerBuildRevokeRoute(app: FastifyInstance): void {
  app.post("/tx/build-revoke", async (req: FastifyRequest): Promise<UnsignedTx> => {
    const body = parseBody(req.body);
    const chainId = parseChainId(body.chainId);
    const mandateId = parseMandateId(body.mandateId);
    const registryAddress = requireRegistryAddress(chainId) as `0x${string}`;
    const client = getPublicClient(chainId);

    // Simulate as `from`. The registry reverts with NotOwner for a non-owner
    // (and for an unknown id, whose owner is address(0)) and AlreadyRevoked for
    // a second revoke. Surfacing that now costs one eth_call.
    await withRpc(`simulating revoke on chain ${chainId}`, async () => {
      try {
        await client.simulateContract({
          address: registryAddress,
          abi: MANDATE_REGISTRY_ABI,
          functionName: "revoke",
          args: [mandateId],
          account: body.from as `0x${string}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/NotOwner/.test(message)) {
          throw new AppError(
            403,
            ErrorCode.FORBIDDEN,
            `${toChecksum(body.from)} does not own mandate ${mandateId} on chain ${chainId} — ` +
              `only the owner can revoke`,
          );
        }
        if (/AlreadyRevoked/.test(message)) {
          throw AppError.badRequest(
            `mandate ${mandateId} is already revoked on chain ${chainId}`,
          );
        }
        throw err; // a real RPC failure — withRpc maps it to 502/504
      }
    });

    const data = encodeFunctionData({
      abi: MANDATE_REGISTRY_ABI,
      functionName: "revoke",
      args: [mandateId],
    });

    return {
      to: toChecksum(registryAddress),
      data,
      value: "0",
      chainId,
      gasLimit: REVOKE_GAS_LIMIT,
    };
  });
}
