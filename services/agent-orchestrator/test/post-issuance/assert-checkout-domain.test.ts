import { describe, expect, it } from "vitest";
import { assertCheckoutDomain } from "../../src/post-issuance/assert-checkout-domain";

const MATCHED_CHECKOUT_URL = "https://shop.example/checkout/xyz";
const MATCHED_DOMAIN = "shop.example";

describe("assertCheckoutDomain (C9)", () => {
  it("allows a page that matches the discovered checkout URL exactly", () => {
    const result = assertCheckoutDomain({
      currentUrl: MATCHED_CHECKOUT_URL,
      matchedCheckoutUrl: MATCHED_CHECKOUT_URL,
      matchedDomain: MATCHED_DOMAIN,
    });
    expect(result.allowed).toBe(true);
  });

  it("refuses a different domain even with the same path", () => {
    const result = assertCheckoutDomain({
      currentUrl: "https://attacker.example/checkout/xyz",
      matchedCheckoutUrl: MATCHED_CHECKOUT_URL,
      matchedDomain: MATCHED_DOMAIN,
    });
    expect(result.allowed).toBe(false);
  });

  it("refuses the same domain but a different checkout path", () => {
    const result = assertCheckoutDomain({
      currentUrl: "https://shop.example/checkout/some-other-order",
      matchedCheckoutUrl: MATCHED_CHECKOUT_URL,
      matchedDomain: MATCHED_DOMAIN,
    });
    expect(result.allowed).toBe(false);
  });

  it("refuses a lookalike subdomain", () => {
    const result = assertCheckoutDomain({
      currentUrl: "https://shop.example.attacker.com/checkout/xyz",
      matchedCheckoutUrl: MATCHED_CHECKOUT_URL,
      matchedDomain: MATCHED_DOMAIN,
    });
    expect(result.allowed).toBe(false);
  });

  it("always reports the matched domain and URL back, even on refusal", () => {
    const result = assertCheckoutDomain({
      currentUrl: "https://attacker.example/checkout/xyz",
      matchedCheckoutUrl: MATCHED_CHECKOUT_URL,
      matchedDomain: MATCHED_DOMAIN,
    });
    expect(result.merchantDomain).toBe(MATCHED_DOMAIN);
    expect(result.matchedAgainst).toBe(MATCHED_CHECKOUT_URL);
  });
});
