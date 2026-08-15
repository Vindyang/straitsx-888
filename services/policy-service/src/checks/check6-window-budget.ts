import { escalate, type CheckContext, type CheckFailure } from "./types.js";

/**
 * B17 — the one check that escalates instead of refusing. A budget-only failure must never
 * come back as `refused` — that path escalates to the human.
 */
export function check6_window_budget(ctx: CheckContext): CheckFailure | null {
  const spent = BigInt(ctx.windowUsage.spent);
  const amount = BigInt(ctx.challenge.amount);
  const maxPerWindow = BigInt(ctx.mandate.maxPerWindow);

  if (spent + amount > maxPerWindow) {
    return escalate(
      "check6_window_budget",
      "WINDOW_BUDGET_EXCEEDED",
      `spent ${spent} + amount ${amount} > maxPerWindow ${maxPerWindow}`,
    );
  }
  if (ctx.windowUsage.cardCount >= ctx.mandate.maxCardsPerWindow) {
    return escalate(
      "check6_window_budget",
      "WINDOW_BUDGET_EXCEEDED",
      `cardCount ${ctx.windowUsage.cardCount} >= maxCardsPerWindow ${ctx.mandate.maxCardsPerWindow}`,
    );
  }
  return null;
}
