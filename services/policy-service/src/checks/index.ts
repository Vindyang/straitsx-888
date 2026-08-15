import { check1_mandate_live } from "./check1-mandate-live.js";
import { check2_policy_hash } from "./check2-policy-hash.js";
import { check3_chain_asset } from "./check3-chain-asset.js";
import { check4_recipient_pinned } from "./check4-recipient-pinned.js";
import { check5_amount_bounds } from "./check5-amount-bounds.js";
import { check6_window_budget } from "./check6-window-budget.js";
import { check7_validity_sane } from "./check7-validity-sane.js";
import { check8_intent_bound } from "./check8-intent-bound.js";
import type { CheckFn } from "./types.js";

export * from "./types.js";
export { precondition_intent_exists } from "./precondition.js";
export { check9_intent_match, type Check9Context, type Check9Result } from "./check9-intent-match.js";
export {
  check1_mandate_live,
  check2_policy_hash,
  check3_chain_asset,
  check4_recipient_pinned,
  check5_amount_bounds,
  check6_window_budget,
  check7_validity_sane,
  check8_intent_bound,
};

/**
 * Cheapest and most damning first (B10). Note: api-contracts.md §6's `checksPassed` example
 * array uses shortened names (`check4_recipient`, `check5_amount`, ...) that don't match its
 * own "canonical names and order" table just above it. This uses the canonical table's names
 * throughout — flag to the team if the shortened form was actually intended.
 */
export const CHECKS: ReadonlyArray<readonly [string, CheckFn]> = [
  ["check1_mandate_live", check1_mandate_live],
  ["check2_policy_hash", check2_policy_hash],
  ["check3_chain_asset", check3_chain_asset],
  ["check4_recipient_pinned", check4_recipient_pinned],
  ["check5_amount_bounds", check5_amount_bounds],
  ["check6_window_budget", check6_window_budget],
  ["check7_validity_sane", check7_validity_sane],
  ["check8_intent_bound", check8_intent_bound],
];

export const CHECK_INDEX: Readonly<Record<string, number>> = {
  precondition_intent_exists: 0,
  check1_mandate_live: 1,
  check2_policy_hash: 2,
  check3_chain_asset: 3,
  check4_recipient_pinned: 4,
  check5_amount_bounds: 5,
  check6_window_budget: 6,
  check7_validity_sane: 7,
  check8_intent_bound: 8,
};

export const HUMAN_EXPLANATIONS: Readonly<Record<string, string>> = {
  precondition_intent_exists:
    "No record of this purchase request exists. Nothing was signed and no money moved.",
  check1_mandate_live:
    "This mandate is not currently active — it may be revoked or expired. Nothing was signed and no money moved.",
  check2_policy_hash:
    "The stored purchase policy no longer matches what was authorised on-chain. Nothing was signed and no money moved.",
  check3_chain_asset:
    "The payment requirements name a different network or token than this mandate allows. Nothing was signed and no money moved.",
  check4_recipient_pinned:
    "The payment was addressed to an account this mandate does not recognise. Nothing was signed and no money moved.",
  check5_amount_bounds:
    "The requested amount falls outside what this mandate permits. Nothing was signed and no money moved.",
  check7_validity_sane:
    "The signature validity window computed for this payment was longer than allowed. Nothing was signed and no money moved.",
  check8_intent_bound:
    "This payment request has no verified purchase instruction behind it. Nothing was signed and no money moved.",
};
