import { refuse, type CheckFailure } from "./types.js";

/**
 * B11 — runs before ctx is assembled: no on-chain read, no policy load. Short-circuits the
 * common orphan-signature case as cheaply as possible.
 */
export function precondition_intent_exists(intentRecord: unknown): CheckFailure | null {
  if (!intentRecord) {
    return refuse("precondition_intent_exists", "no intent record exists for this requestId");
  }
  return null;
}
