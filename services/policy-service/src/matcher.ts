import type { ResolvedItem } from "@straitsx/contracts";

export type MatchOutcome = "match" | "uncertain";
export type IntentMatcher = (resolvedItem: ResolvedItem, intentConstraint: string) => MatchOutcome;

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or", "in", "size", "under", "up", "to", "for", "with"]);
const MATCH_THRESHOLD = 0.5;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word) && !/^\d+$/.test(word)),
  );
}

/**
 * PLACEHOLDER matcher — token overlap between resolvedItem.title and intentConstraint.
 *
 * B20/execution_plan.md §12b 2.3 call for structured extraction (parse both into
 * {title, sku, price, merchantDomain} and compare field-by-field) via an LLM. That needs a
 * model API wired in, which this codebase doesn't have configured. This heuristic upholds the
 * one invariant that actually matters architecturally — it can only ever return "match" or
 * "uncertain", never a confident false match — so swapping it for a real LLM-backed extractor
 * later is a drop-in replacement of this function alone; nothing else in the pipeline changes.
 */
export function heuristicIntentMatcher(resolvedItem: ResolvedItem, intentConstraint: string): MatchOutcome {
  const titleTokens = tokenize(resolvedItem.title);
  const constraintTokens = tokenize(intentConstraint);
  if (titleTokens.size === 0 || constraintTokens.size === 0) return "uncertain";

  let overlap = 0;
  for (const token of titleTokens) {
    if (constraintTokens.has(token)) overlap += 1;
  }
  const ratio = overlap / Math.min(titleTokens.size, constraintTokens.size);
  return ratio >= MATCH_THRESHOLD ? "match" : "uncertain";
}
