import { refuse, type CheckContext, type CheckFailure } from "./types.js";

/**
 * B18 — we compute this window, we do not read it (the 402 has no validAfter/validBefore).
 * `maxSaneValiditySeconds` should come from Owner A's measured 202->settlement latency
 * (checkpoint 2), not a guess — it lives on ctx so this stays a pure function meanwhile.
 */
export function check7_validity_sane(ctx: CheckContext): CheckFailure | null {
  const window = Math.min(ctx.mandate.maxAuthValiditySeconds, ctx.challenge.maxTimeoutSeconds);
  if (window > ctx.maxSaneValiditySeconds) {
    return refuse(
      "check7_validity_sane",
      `computed window ${window}s exceeds sane ceiling ${ctx.maxSaneValiditySeconds}s`,
    );
  }
  return null;
}
