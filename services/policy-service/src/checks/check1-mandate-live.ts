import { refuse, type CheckContext, type CheckFailure } from "./types.js";

/** B12 — exists, not revoked, not expired. Never cache this: revocation must be live every call. */
export function check1_mandate_live(ctx: CheckContext): CheckFailure | null {
  if (!ctx.registry) {
    return refuse("check1_mandate_live", `mandate ${ctx.mandate.mandateId} not found on-chain`);
  }
  if (ctx.registry.revoked) {
    return refuse("check1_mandate_live", `mandate ${ctx.mandate.mandateId} is revoked on-chain`);
  }
  if (ctx.now >= ctx.registry.expiresAt) {
    return refuse(
      "check1_mandate_live",
      `mandate expired at ${ctx.registry.expiresAt}, now is ${ctx.now}`,
    );
  }
  return null;
}
