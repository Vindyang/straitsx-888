import "server-only";
import { encodeFunctionData } from "viem";
import {
  MANDATE_REGISTRY_ABI,
  hashPolicy,
  requireRegistryAddress,
  toChecksum,
  type Hex,
  type Mandate,
} from "@straitsx/contracts";

export type UnsignedTx = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit: string;
};

/** Measured generously above the deploy suite's createMandate gas — this is a
 *  cold SSTORE plus an event, comparable in shape to chain-gateway's revoke
 *  headroom (services/chain-gateway/src/routes/build-revoke.ts). */
const CREATE_MANDATE_GAS_LIMIT = "150000";

/**
 * C11 — build an UNSIGNED createMandate transaction. Uses `hashPolicy` from
 * packages/contracts (never reimplemented — docs/conventions.md: "a
 * serialisation difference makes check 2 fail forever and look like a
 * contract bug"). The human signs this in their own wallet; this module never
 * touches a private key.
 */
export function buildCreateMandateTx(mandate: Mandate): { unsignedTx: UnsignedTx; policyHash: Hex } {
  const registryAddress = requireRegistryAddress(mandate.chainId);
  const policyHash = hashPolicy(mandate);
  const data = encodeFunctionData({
    abi: MANDATE_REGISTRY_ABI,
    functionName: "createMandate",
    args: [mandate.mandateId as `0x${string}`, policyHash, BigInt(mandate.expiresAt)],
  });
  return {
    unsignedTx: {
      to: toChecksum(registryAddress),
      data,
      value: "0",
      chainId: mandate.chainId,
      gasLimit: CREATE_MANDATE_GAS_LIMIT,
    },
    policyHash,
  };
}
