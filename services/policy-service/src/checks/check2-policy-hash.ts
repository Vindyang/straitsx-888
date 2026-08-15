import { hashPolicy } from "@straitsx/contracts";
import { refuse, type CheckContext, type CheckFailure } from "./types.js";

/**
 * B13 — defeats a tampered local policy copy, including a tampered intentConstraint (hashed
 * per packages/contracts/mandate.ts). If `registry` is absent, check 1 already refused for
 * that; skip here to avoid a confusing second refusal on the same root cause.
 */
export function check2_policy_hash(ctx: CheckContext): CheckFailure | null {
  if (!ctx.registry) return null;
  const localHash = hashPolicy(ctx.mandate);
  if (localHash.toLowerCase() !== ctx.registry.policyHash.toLowerCase()) {
    return refuse(
      "check2_policy_hash",
      `local policyHash ${localHash} != on-chain policyHash ${ctx.registry.policyHash}`,
    );
  }
  return null;
}
