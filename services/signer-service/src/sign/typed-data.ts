/**
 * A12 — EIP-3009 typed data + EIP-712 digest, with the challenge-vs-config
 * assertion that is the load-bearing domain guard.
 *
 * Domain fields (docs/execution_plan.md §9): `name` ← challenge.extra.name,
 * `version` ← challenge.extra.version, `chainId` ← challenge.chainId,
 * `verifyingContract` ← challenge.asset. `version()` is NOT readable on-chain on
 * either chain, so the 402's `extra` block is the only source — never a
 * hardcoded constant, never inherited from Fuji.
 */

import { hashTypedData, type Hex as ViemHex } from "viem";
import {
  AppError,
  ErrorCode,
  type Hex,
  type TransferWithAuthorizationTypedData,
} from "@straitsx/contracts";

/** The expected on-chain constants a live challenge must match (A12 + §19.4).
 *  A mismatch is SIGNER_DOMAIN_MISMATCH — either a chain misconfiguration or an
 *  attack, never silently accepted. */
export type ExpectedDomain = {
  chainId: number;
  asset: Hex; // verifyingContract, lowercased
  name: string;
  version: string;
};

export type BuildTypedDataInput = {
  from: Hex;
  to: Hex;
  value: string; // base-unit decimal string at 6 decimals
  validAfter: number;
  validBefore: number;
  nonce: Hex; // bytes32
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Hex;
  };
};

/**
 * Assert the live challenge's domain matches the expected constants and refuse
 * on mismatch. The wallet is chain-independent (§19.5), so a wrong chainId or
 * asset will NOT surface as a wallet error — this assertion is the only guard.
 */
export function assertDomainMatches(
  domain: BuildTypedDataInput["domain"],
  expected: ExpectedDomain,
): void {
  const verifyingContract = domain.verifyingContract.toLowerCase() as Hex;
  if (
    domain.chainId !== expected.chainId ||
    verifyingContract !== expected.asset.toLowerCase() ||
    domain.name !== expected.name ||
    domain.version !== expected.version
  ) {
    throw AppError.signerRefusal(
      ErrorCode.SIGNER_DOMAIN_MISMATCH,
      `challenge domain does not match configured chain constants (chainId ${domain.chainId}, ` +
        `verifyingContract ${verifyingContract}, name ${domain.name}, version ${domain.version})`,
    );
  }
}

/**
 * Build the canonical `TransferWithAuthorization` typed data. `value` stays a
 * base-unit decimal string; it is converted to BigInt only when the digest is
 * computed (money is never a JSON number — api-contracts.md §0).
 */
export function buildTransferWithAuthorizationTypedData(
  input: BuildTypedDataInput,
): TransferWithAuthorizationTypedData {
  return {
    domain: {
      name: input.domain.name,
      version: input.domain.version,
      chainId: input.domain.chainId,
      verifyingContract: input.domain.verifyingContract.toLowerCase() as Hex,
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
      from: input.from.toLowerCase() as Hex,
      to: input.to.toLowerCase() as Hex,
      value: input.value,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: input.nonce,
    },
  };
}

/**
 * Compute the EIP-712 digest for the typed data. This is the 32-byte value KMS
 * signs (MessageType DIGEST). It is `keccak256("\x19\x01" ‖ domainSeparator ‖
 * hashStruct(message))`, produced by viem `hashTypedData`.
 */
export function digestTypedData(
  typedData: TransferWithAuthorizationTypedData,
): ViemHex {
  return hashTypedData(typedData as Parameters<typeof hashTypedData>[0]);
}
