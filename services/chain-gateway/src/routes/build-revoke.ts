/**
 * A9 — `POST /tx/build-revoke`
 *
 * Returns an UNSIGNED transaction. chain-gateway never signs anything: the
 * human signs the revoke in their own wallet from the dashboard, which is what
 * makes "only the owner can revoke" true off-chain as well as on-chain.
 *
 * `from` is echoed back for the wallet to check, and used to simulate the call
 * so an unauthorised revoke fails HERE rather than as an opaque wallet error.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { encodeFunctionData, getAddress } from "viem";
import {
  AppError,
  MANDATE_REGISTRY_ABI,
  type BuildRevokeRequest,
  type UnsignedTx,
} from "@straitsx/contracts";
import { parseChainId } from "../chain";
import { parseMandateId, resolveRegistryAddress } from "./mandate";
import { parseAddress } from "./balance";

/** Generous but bounded. `revoke` writes one bool in an already-warm slot;
 *  measured at ~62k in the forge suite. */
const REVOKE_GAS_LIMIT = "80000";

function parseBody(body: unknown): BuildRevokeRequest {
  if (typeof body !== "object" || body === null) {
    throw AppError.badRequest("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b["mandateId"] !== "string") {
    throw AppError.badRequest("mandateId is required");
  }
  return {
    mandateId: b["mandateId"],
    chainId: Number(b["chainId"]),
    from: parseAddress(b["from"]),
  };
}

export function registerBuildRevokeRoute(app: FastifyInstance): void {
  app.post("/tx/build-revoke", async (req: FastifyRequest): Promise<UnsignedTx> => {
    const body = parseBody(req.body);
    const chainId = parseChainId(body.chainId);
    const mandateId = parseMandateId(body.mandateId);
    const registryAddress = resolveRegistryAddress(chainId);

    const data = encodeFunctionData({
      abi: MANDATE_REGISTRY_ABI,
      functionName: "revoke",
      args: [mandateId],
    });

    return {
      to: getAddress(registryAddress),
      data,
      value: "0",
      chainId,
      gasLimit: REVOKE_GAS_LIMIT,
    };
  });
}
