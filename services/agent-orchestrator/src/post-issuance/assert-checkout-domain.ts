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
};

export type AssertCheckoutDomainResult = {
  allowed: boolean;
  merchantDomain: string;
  matchedAgainst: string;
};

export function assertCheckoutDomain(input: AssertCheckoutDomainInput): AssertCheckoutDomainResult {
  const currentDomain = new URL(input.currentUrl).hostname;
  const allowed = currentDomain === input.matchedDomain && input.currentUrl === input.matchedCheckoutUrl;
  return { allowed, merchantDomain: input.matchedDomain, matchedAgainst: input.matchedCheckoutUrl };
}
