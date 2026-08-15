import { refuse, type CheckContext, type CheckFailure } from "./types.js";

/**
 * B15 — THE IMPORTANT ONE. Defeats a compromised agent substituting a different challenge (a
 * spoofed cardapi URL or a constructed challenge naming an attacker address). A product page
 * cannot rewrite the MCP response; it can only make the agent ask for a different payment, and
 * this is what catches that. `detail` must name both addresses — the refusal panel shows it.
 */
export function check4_recipient_pinned(ctx: CheckContext): CheckFailure | null {
  if (ctx.challenge.payTo.toLowerCase() !== ctx.mandate.settlementRecipient.toLowerCase()) {
    return refuse(
      "check4_recipient_pinned",
      `challenge.payTo ${ctx.challenge.payTo} != mandate.settlementRecipient ${ctx.mandate.settlementRecipient}`,
    );
  }
  return null;
}
