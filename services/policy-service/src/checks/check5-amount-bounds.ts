import { refuse, type CheckContext, type CheckFailure } from "./types.js";

// cardapi enforces 5-30 SGD; these are protocol constants, not ops config. 6 decimals.
const MIN_AMOUNT_BASE_UNITS = 5_000_000n;
const HARD_CAP_BASE_UNITS = 30_000_000n;

/**
 * B16 — first clause is the security boundary (amount within [5, min(maxPerCard, 30)] XSGD);
 * second clause is a consistency check (challenge.amount == what the agent requested), not a
 * security boundary — it catches a mid-flight rewrite, not a malicious agent.
 */
export function check5_amount_bounds(ctx: CheckContext): CheckFailure | null {
  const amount = BigInt(ctx.challenge.amount);
  const maxPerCard = BigInt(ctx.mandate.maxPerCard);
  const ceiling = maxPerCard < HARD_CAP_BASE_UNITS ? maxPerCard : HARD_CAP_BASE_UNITS;

  if (amount < MIN_AMOUNT_BASE_UNITS || amount > ceiling) {
    return refuse(
      "check5_amount_bounds",
      `challenge.amount ${amount} outside bounds [${MIN_AMOUNT_BASE_UNITS}, ${ceiling}]`,
    );
  }
  if (ctx.challenge.amount !== ctx.requestedAmount) {
    return refuse(
      "check5_amount_bounds",
      `challenge.amount ${ctx.challenge.amount} != requestedAmount ${ctx.requestedAmount}`,
    );
  }
  return null;
}
