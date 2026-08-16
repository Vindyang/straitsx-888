/** Checked-in, non-secret merchant automation configuration. */
export type MerchantProfile = {
  profileId: string;
  productUrl: string;
  allowedHosts: readonly string[];
  checkoutUrlPattern: string;
  extraction: {
    title: string;
    sku: string;
    price: string;
    checkoutLink: string;
  };
  cardIframe: { number: string; expiry: string; cvc: string };
  cardFields: { number: string; expiry: string; cvc: string };
  submit: string;
  confirmation: { merchantDomain?: string; orderTotal: string; itemSku: string; orderId: string; timestamp?: string };
};

const fixtureBaseUrl = process.env["FIXTURE_BASE_URL"] ?? "http://localhost:4010";

export const MERCHANT_PROFILES: Readonly<Record<string, MerchantProfile>> = {
  "local-fixture": {
    profileId: "local-fixture",
    productUrl: `${fixtureBaseUrl}/fixtures/clean`,
    allowedHosts: [new URL(fixtureBaseUrl).hostname],
    checkoutUrlPattern: `^${fixtureBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/checkout/xyz$`,
    extraction: {
      title: "[data-product]@data-title",
      sku: "[data-product]@data-sku",
      price: "[data-product]@data-price",
      checkoutLink: "[data-checkout-url]@href",
    },
    cardIframe: { number: "[data-card-number]", expiry: "[data-card-expiry]", cvc: "[data-card-cvc]" },
    cardFields: { number: "[name=cardNumber]", expiry: "[name=cardExpiry]", cvc: "[name=cardCvc]" },
    submit: "[data-submit-order]",
    confirmation: {
      merchantDomain: "[data-merchant-domain]",
      orderTotal: "[data-order-total]",
      itemSku: "[data-order-sku]",
      orderId: "[data-order-id]",
      timestamp: "[data-order-timestamp]",
    },
  },
};

export function getMerchantProfile(profileId: string): MerchantProfile {
  const profile = MERCHANT_PROFILES[profileId];
  if (!profile) throw new Error(`unknown merchant profile ${profileId}`);
  return profile;
}
