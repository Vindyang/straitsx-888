/**
 * Card data exists transiently in this isolated browser process. It is never
 * returned, persisted, logged, traced, screenshotted or recorded.
 */
import { chromium, type Browser } from "playwright";
import type { Address, ResolvedItem } from "@straitsx/contracts";
import { assertCheckoutDomain } from "../post-issuance/assert-checkout-domain";
import type { ViewCardResult } from "../card-gateway/types";
import type { SpendAttestation } from "../post-issuance/capture-spend-attestation";
import type { MerchantProfile } from "./merchant-profiles";

export type CheckoutWorkerInput = {
  requestId: string;
  profile: MerchantProfile;
  resolvedItem: ResolvedItem;
  cardOpaqueId: string;
  settlementTx: string;
  walletAddress: Address;
  viewCard: (input: { cardOpaqueId: string; settlementTx: string; walletAddress: Address }) => Promise<ViewCardResult>;
  launchBrowser?: () => Promise<Browser>;
  onDomainAsserted?: () => void;
};

async function text(page: import("playwright").Page, selector: string): Promise<string> {
  const locator = page.locator(selector).first();
  return ((await locator.getAttribute("data-value")) ?? (await locator.textContent()) ?? "").trim();
}

export async function runCheckout(input: CheckoutWorkerInput): Promise<SpendAttestation> {
  const browser = await (input.launchBrowser ? input.launchBrowser() : chromium.launch());
  try {
    // No recordVideo option, no tracing, no listeners capturing console, and no screenshots.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(input.resolvedItem.checkoutUrl, { waitUntil: "domcontentloaded" });

      const actualUrl = page.url();
      const assertion = assertCheckoutDomain({
        currentUrl: actualUrl,
        matchedCheckoutUrl: input.resolvedItem.checkoutUrl,
        matchedDomain: input.resolvedItem.merchantDomain,
        allowedHosts: input.profile.allowedHosts,
        checkoutUrlPattern: input.profile.checkoutUrlPattern,
      });
      if (!assertion.allowed) throw new Error("checkout URL/domain did not match the selected merchant profile");
      input.onDomainAsserted?.();

      // The one-time URL is obtained only after the live page has passed both checks.
      const cardView = await input.viewCard({
        cardOpaqueId: input.cardOpaqueId,
        settlementTx: input.settlementTx,
        walletAddress: input.walletAddress,
      });
      await page.evaluate((iframeUrl) => {
        type ElementLike = { dataset: Record<string, string>; src: string; hidden: boolean };
        const pageDocument = (globalThis as unknown as {
          document: { createElement: (tag: string) => ElementLike; body: { appendChild: (element: ElementLike) => void } };
        }).document;
        const iframe = pageDocument.createElement("iframe");
        iframe.dataset.straitsxCard = "transient";
        iframe.src = iframeUrl;
        iframe.hidden = true;
        pageDocument.body.appendChild(iframe);
      }, cardView.iframeUrl);

      const cardFrame = page.frameLocator('iframe[data-straitsx-card="transient"]');
      let number = await cardFrame.locator(input.profile.cardIframe.number).inputValue();
      let expiry = await cardFrame.locator(input.profile.cardIframe.expiry).inputValue();
      let cvc = await cardFrame.locator(input.profile.cardIframe.cvc).inputValue();
      try {
        await page.locator(input.profile.cardFields.number).fill(number);
        await page.locator(input.profile.cardFields.expiry).fill(expiry);
        await page.locator(input.profile.cardFields.cvc).fill(cvc);
      } finally {
        number = "";
        expiry = "";
        cvc = "";
        await page.locator('iframe[data-straitsx-card="transient"]').evaluate((element) => {
          (element as unknown as { remove: () => void }).remove();
        });
      }

      await Promise.all([
        page.waitForLoadState("domcontentloaded"),
        page.locator(input.profile.submit).click(),
      ]);

      const confirmedUrl = new URL(page.url());
      if (!input.profile.allowedHosts.includes(confirmedUrl.hostname)) {
        throw new Error("confirmation page left the merchant host allowlist");
      }
      const orderTotal = await text(page, input.profile.confirmation.orderTotal);
      const itemSku = await text(page, input.profile.confirmation.itemSku);
      const orderId = await text(page, input.profile.confirmation.orderId);
      const observedAt = input.profile.confirmation.timestamp
        ? await text(page, input.profile.confirmation.timestamp)
        : new Date().toISOString();
      if (!orderTotal || !itemSku || !orderId || !observedAt) throw new Error("confirmation page omitted required evidence");
      return {
        requestId: input.requestId,
        merchantDomain: confirmedUrl.hostname,
        orderTotal,
        itemSku,
        orderId,
        observedAt,
        proof: "none",
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
