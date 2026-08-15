import { refuse, type CheckContext, type CheckFailure } from "./types.js";

/** B19 — no orphan signatures: the intent must strictly predate the challenge it's paired with. */
export function check8_intent_bound(ctx: CheckContext): CheckFailure | null {
  if (!ctx.challengeAttachedAt) {
    return refuse("check8_intent_bound", "no challenge is attached to this intent");
  }
  if (Date.parse(ctx.intentCreatedAt) >= Date.parse(ctx.challengeAttachedAt)) {
    return refuse(
      "check8_intent_bound",
      `intent.createdAt ${ctx.intentCreatedAt} is not strictly before challengeAttachedAt ${ctx.challengeAttachedAt}`,
    );
  }
  return null;
}
