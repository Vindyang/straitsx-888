/**
 * C9 — before the card is auto-filled, assert the current page's domain AND
 * checkout URL match the discovered, intent-matched URL. Refuse to fill
 * otherwise. Not cryptographic: this turns the advisory `merchantAllowlist`
 * into a real enforcement point at the one layer we control, but it binds
 * only a *behaving* agent and defeats the honest-mistake case — say exactly
 * that, don't overclaim it (execution_plan.md §12).
 */

export type AssertCheckoutDomainInput = {
  currentUrl: string;
  matchedCheckoutUrl: string;
  matchedDomain: string;
  allowedHosts?: readonly string[];
  checkoutUrlPattern?: string;
};

export type AssertCheckoutDomainResult = {
  allowed: boolean;
  merchantDomain: string;
  matchedAgainst: string;
};

export function assertCheckoutDomain(input: AssertCheckoutDomainInput): AssertCheckoutDomainResult {
  const current = new URL(input.currentUrl);
  const currentDomain = current.hostname;
  const hostAllowed = (input.allowedHosts ?? [input.matchedDomain]).includes(currentDomain);
  const profileAllowed = input.checkoutUrlPattern ? new RegExp(input.checkoutUrlPattern).test(input.currentUrl) : true;
  const allowed =
    current.protocol === new URL(input.matchedCheckoutUrl).protocol &&
    currentDomain === input.matchedDomain &&
    input.currentUrl === input.matchedCheckoutUrl &&
    hostAllowed &&
    profileAllowed;
  return { allowed, merchantDomain: input.matchedDomain, matchedAgainst: input.matchedCheckoutUrl };
}
