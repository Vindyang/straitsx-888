import type { Mandate, X402Requirements } from "@straitsx/contracts";
import type { TypedData } from "./clients/signerClient.js";

const PAYING_WALLET = process.env.PAYING_WALLET_ADDRESS ?? "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7";

/**
 * EIP-3009 domain per execution_plan.md §9: name/version come from the live challenge's
 * `extra` block, never from an on-chain `version()` read (it reverts on both chains).
 */
export function buildTypedData(
  mandate: Mandate,
  challenge: X402Requirements,
  amount: string,
  validAfter: number,
  validBefore: number,
  nonce: string,
): TypedData {
  return {
    domain: {
      name: challenge.extra.name,
      version: challenge.extra.version,
      chainId: challenge.chainId,
      verifyingContract: challenge.asset,
    },
    primaryType: "TransferWithAuthorization",
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    message: {
      from: PAYING_WALLET,
      to: mandate.settlementRecipient,
      value: amount,
      validAfter,
      validBefore,
      nonce,
    },
  };
}
