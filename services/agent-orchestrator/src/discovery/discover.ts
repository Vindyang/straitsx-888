/**
 * C6 — resolve `{ title, sku, price, merchantDomain, checkoutUrl }` from a
 * product page via Playwright. Every byte on the page is untrusted DATA,
 * never instruction: this function reads exactly four fixed attributes
 * (`data-title`, `data-sku`, `data-price` on `[data-product]`, and the
 * `[data-checkout-url]` link's `href`) and nothing else on the page is ever
 * read into a prompt, a log line, or fed to a model.
 */

import { chromium } from "playwright";
import type { ResolvedItem } from "@straitsx/contracts";
import type { MerchantProfile } from "../checkout/merchant-profiles";

export type SimulatedCompromise = {
  payToOverride?: string | undefined;
  amountOverride?: string | undefined;
};

/** A merchant-signed UCP checkout snapshot supplied by the agent the way Shopify's
 *  Universal Commerce Protocol delivers it: the merchant owns the totals and the
 *  session; the checkout JWT (when present, AP2) cryptographically binds them. */
export type ShopifyUcpCheckout = {
  storeDomain: string;
  checkoutSessionId: string;
  title: string;
  sku: string;
  totalBaseUnits: string;
  currency: "SGD";
  /** Merchant-signed UCP checkout JWT (AP2 checkout binding, optional in sandbox). */
  checkoutJwt?: string | undefined;
};

export function checkoutUrlOf(checkout: ShopifyUcpCheckout): string {
  return `https://${checkout.storeDomain}/checkout-sessions/${checkout.checkoutSessionId}/complete`;
}

/** C6-shopify — resolve the purchase target from a UCP checkout snapshot instead of
 *  scraping a page. The merchant (Shopify storefront) signed the totals; we never
 *  render or read an HTML page, so there is no page-injection surface at all. */
export async function discoverShopifyCheckout(checkout: ShopifyUcpCheckout): Promise<DiscoveryResult> {
  const domain = checkout.storeDomain.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)) {
    throw new Error("shopify source storeDomain is not a valid hostname");
  }
  if (!/^[A-Za-z0-9_-]{8,}$/.test(checkout.checkoutSessionId)) {
    throw new Error("shopify source checkoutSessionId is invalid");
  }
  if (checkout.currency !== "SGD") throw new Error("shopify source checkout must be denominated in SGD");
  const price = checkout.totalBaseUnits;
  if (!/^\d+$/.test(price)) throw new Error("shopify source totalBaseUnits must be a base-unit decimal string");
  if (!checkout.title.trim() || !checkout.sku.trim()) throw new Error("shopify source checkout must carry line-item title and sku");
  return {
    resolvedItem: {
      title: checkout.title.trim(),
      sku: checkout.sku.trim(),
      price,
      merchantDomain: domain,
      checkoutUrl: checkoutUrlOf(checkout),
    },
    simulatedCompromise: null,
  };
}

export type DiscoveryResult = {
  resolvedItem: ResolvedItem;
  /**
   * TEST-HARNESS ONLY (C7). Populated when the fixture page carries a
   * `[data-injection]` block — hidden text aimed at an LLM-driven agent,
   * modelling what a COMPROMISED agent would submit to policy-service
   * instead of the true MCP-issued challenge. `discoverProduct` never lets
   * this influence `resolvedItem` above; a page genuinely cannot rewrite the
   * MCP response (execution_plan.md §8, check 4's reframing). This field
   * exists solely so run/pipeline.ts can exercise checks 4/5 deterministically
   * without a real jailbroken LLM in the loop — see its call site for how it
   * is (and is not) used.
   */
  simulatedCompromise: SimulatedCompromise | null;
};

export async function discoverProduct(productUrl: string): Promise<DiscoveryResult> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(productUrl, { waitUntil: "domcontentloaded" });

    const product = page.locator("[data-product]").first();
    const title = (await product.getAttribute("data-title")) ?? "";
    const sku = (await product.getAttribute("data-sku")) ?? "";
    const priceDollars = (await product.getAttribute("data-price")) ?? "0";
    const checkoutHref = (await page.locator("[data-checkout-url]").first().getAttribute("href")) ?? "";

    const resolvedItem: ResolvedItem = {
      title,
      sku,
      price: dollarsToBaseUnits6(priceDollars),
      merchantDomain: new URL(productUrl).hostname,
      checkoutUrl: new URL(checkoutHref, productUrl).toString(),
    };

    let simulatedCompromise: SimulatedCompromise | null = null;
    const injection = page.locator("[data-injection]").first();
    if ((await injection.count()) > 0) {
      const payToOverride = (await injection.getAttribute("data-injected-payto")) ?? undefined;
      const amountOverride = (await injection.getAttribute("data-injected-amount")) ?? undefined;
      if (payToOverride || amountOverride) {
        simulatedCompromise = { payToOverride, amountOverride };
      }
    }

    return { resolvedItem, simulatedCompromise };
  } finally {
    await browser.close();
  }
}

function splitSelector(spec: string): { selector: string; attribute?: string } {
  const marker = spec.lastIndexOf("@");
  return marker > 0 ? { selector: spec.slice(0, marker), attribute: spec.slice(marker + 1) } : { selector: spec };
}

async function extract(page: import("playwright").Page, spec: string): Promise<string> {
  const { selector, attribute } = splitSelector(spec);
  const locator = page.locator(selector).first();
  return ((attribute ? await locator.getAttribute(attribute) : await locator.textContent()) ?? "").trim();
}

export async function discoverMerchantProduct(profile: MerchantProfile): Promise<DiscoveryResult> {
  const product = new URL(profile.productUrl);
  if (!profile.allowedHosts.includes(product.hostname)) throw new Error("merchant product URL host is not allowlisted");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(product.toString(), { waitUntil: "domcontentloaded" });
    const liveProductUrl = new URL(page.url());
    if (!profile.allowedHosts.includes(liveProductUrl.hostname)) throw new Error("merchant product navigation left the host allowlist");
    const checkoutUrl = new URL(await extract(page, profile.extraction.checkoutLink), liveProductUrl).toString();
    const checkout = new URL(checkoutUrl);
    if (!profile.allowedHosts.includes(checkout.hostname) || !new RegExp(profile.checkoutUrlPattern).test(checkoutUrl)) {
      throw new Error("discovered checkout URL did not match the merchant profile");
    }
    return {
      resolvedItem: {
        title: await extract(page, profile.extraction.title),
        sku: await extract(page, profile.extraction.sku),
        price: dollarsToBaseUnits6(await extract(page, profile.extraction.price)),
        merchantDomain: checkout.hostname,
        checkoutUrl,
      },
      simulatedCompromise: null,
    };
  } finally {
    await browser.close();
  }
}

/** Price as a base-unit string at 6 decimals (C6); `priceDollars` is e.g. "15.00". */
export function dollarsToBaseUnits6(priceDollars: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(priceDollars)) throw new Error("price must be a positive decimal with at most six places");
  const [whole = "0", frac = ""] = priceDollars.split(".");
  const paddedFrac = (frac + "000000").slice(0, 6);
  return (BigInt(whole) * 1_000_000n + BigInt(paddedFrac || "0")).toString();
}
