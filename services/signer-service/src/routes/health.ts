/**
 * `GET /health` — the custody proof, exposed (api-contracts.md §4).
 *
 * `derivedAddress` is the address main.ts derived from the KMS public key at
 * boot and asserted against `EXPECTED_SIGNER_ADDRESS`. The service refuses to
 * start on mismatch, so if this endpoint answers at all, the assertion held.
 *
 * Deliberately exempt from the internal-token check (conventions.md §3): A15's
 * isolation probe asserts the CONNECTION is refused, and a 401 would prove the
 * opposite — that the port was reachable and we merely declined to answer.
 */

import type { FastifyInstance } from "fastify";
import type { Address } from "viem";

export type HealthDeps = {
  signerAddress: Address;
  kmsKeyId: string | undefined;
  chainId: number;
};

/**
 * Mask a KMS key id/ARN so only the trailing four chars survive. The full key
 * id must never appear in a response or a log line
 * (docs/execution_plan.md §18, conventions.md §3).
 */
export function maskKmsKeyId(keyId: string | undefined): string | null {
  if (!keyId) return null;
  return `arn:aws:kms:…:key/****${keyId.slice(-4)}`;
}

export function registerHealthRoute(
  app: FastifyInstance,
  deps: HealthDeps,
): void {
  app.get("/health", async () => ({
    ok: true,
    derivedAddress: deps.signerAddress,
    kmsKeyId: maskKmsKeyId(deps.kmsKeyId),
    chainId: deps.chainId,
  }));
}
