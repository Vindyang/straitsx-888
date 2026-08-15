import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { runCheckout } from "../../src/checkout/checkout-worker";
import { getMerchantProfile } from "../../src/checkout/merchant-profiles";

function fakeBrowser(startUrl: string) {
  let currentUrl = startUrl;
  const values: Record<string, string> = {
    "[data-order-total]": "15000000", "[data-order-sku]": "BTL-500-SS",
    "[data-order-id]": "SO-99213", "[data-order-timestamp]": "2026-08-15T00:00:00Z",
  };
  const locator = (selector: string) => ({
    first() { return this; },
    async getAttribute(name: string) { return name === "data-value" ? null : null; },
    async textContent() { return values[selector] ?? ""; },
    async fill(_value: string) {},
    async click() { currentUrl = "http://localhost:4010/confirmation/xyz"; },
    async evaluate(callback: (element: unknown) => void) { callback({ remove() {} }); },
  });
  const page = {
    async goto(url: string) { currentUrl = url; }, url: () => currentUrl,
    locator, async evaluate() {}, async waitForLoadState() {},
    frameLocator: () => ({ locator: (selector: string) => ({ inputValue: async () => selector.includes("expiry") ? "12/30" : selector.includes("cvc") ? "123" : "4111111111111111" }) }),
  };
  return { newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} } as unknown as Browser;
}

const base = {
  requestId: "request-1", profile: getMerchantProfile("local-fixture"),
  resolvedItem: { title: "Bottle", sku: "BTL-500-SS", price: "15000000", merchantDomain: "localhost", checkoutUrl: "http://localhost:4010/checkout/xyz" },
  cardOpaqueId: "card", settlementTx: "0xtx", walletAddress: "0x1111111111111111111111111111111111111111",
};

describe("isolated checkout worker", () => {
  it("requests a single-use view only after URL checks and extracts confirmation evidence", async () => {
    const viewCard = vi.fn(async () => ({ iframeUrl: "https://card.straitsx.ai/sandbox/view/one-time/x", expiresInSeconds: 60, singleUse: true as const }));
    const spend = await runCheckout({ ...base, viewCard, launchBrowser: async () => fakeBrowser(base.resolvedItem.checkoutUrl) });
    expect(viewCard).toHaveBeenCalledTimes(1);
    expect(spend).toEqual(expect.objectContaining({ merchantDomain: "localhost", orderTotal: "15000000", itemSku: "BTL-500-SS", orderId: "SO-99213", proof: "none" }));
  });

  it("refuses a path mismatch before requesting card details", async () => {
    const viewCard = vi.fn();
    await expect(runCheckout({ ...base, resolvedItem: { ...base.resolvedItem, checkoutUrl: "http://localhost:4010/not-allowed" }, viewCard, launchBrowser: async () => fakeBrowser("http://localhost:4010/not-allowed") })).rejects.toThrow(/profile/);
    expect(viewCard).not.toHaveBeenCalled();
  });
});
