import type { ResolvedItem } from "@straitsx/contracts";
import { heuristicIntentMatcher, type IntentMatcher } from "../matcher.js";

export type Check9Context = {
  resolvedItem: ResolvedItem;
  intentConstraint: string;
  merchantAllowlist: string[];
  hasStandingApproval: boolean;
};

/**
 * The type itself enforces the invariant from B20/execution_plan.md §12b 2.3: this function
 * has exactly two possible returns — `null` (match, proceed to sign) or an escalation. There
 * is no `refuse` branch it could reach for, even by mistake — checks 1-8 stay the only
 * deterministic, hard-refusing gates. A bypassed matcher degrades to more human
 * interruptions, never more money moved.
 */
export type Check9Result = {
  outcome: "escalate";
  check: "check9_intent_match";
  reason: "INTENT_MISMATCH";
  detail: string;
} | null;

/** B20 — the escalation gate. `matcher` is swappable; see matcher.ts for why it's a heuristic today. */
export function check9_intent_match(ctx: Check9Context, matcher: IntentMatcher = heuristicIntentMatcher): Check9Result {
  if (ctx.hasStandingApproval) return null;

  const allowlisted =
    ctx.merchantAllowlist.length === 0 ||
    ctx.merchantAllowlist.some((domain) => domain.toLowerCase() === ctx.resolvedItem.merchantDomain.toLowerCase());
  if (!allowlisted) {
    return {
      outcome: "escalate",
      check: "check9_intent_match",
      reason: "INTENT_MISMATCH",
      detail: `resolvedItem.merchantDomain ${ctx.resolvedItem.merchantDomain} is not in merchantAllowlist`,
    };
  }

  const outcome = matcher(ctx.resolvedItem, ctx.intentConstraint);
  if (outcome === "uncertain") {
    return {
      outcome: "escalate",
      check: "check9_intent_match",
      reason: "INTENT_MISMATCH",
      detail: `resolvedItem "${ctx.resolvedItem.title}" does not confidently match intentConstraint "${ctx.intentConstraint}"`,
    };
  }
  return null;
}
