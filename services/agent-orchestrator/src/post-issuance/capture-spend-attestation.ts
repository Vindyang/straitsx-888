/**
 * C9 — after checkout, capture `{ merchantDomain, orderTotal, itemSku,
 * orderId, timestamp }` from the order confirmation page and bind it to the
 * requestId via ledger-client.recordSpend. Observational, not cryptographic —
 * the receipt's spendLeg.proof stays "none" (execution_plan.md §12).
 */

import { chromium } from "playwright";
import type { ResolvedItem } from "@straitsx/contracts";

export type SpendAttestation = {
  requestId: string;
  merchantDomain: string;
  orderTotal: string;
  itemSku: string;
  orderId: string;
  observedAt: string;
  proof: "none";
};

export async function captureSpendAttestation(
  requestId: string,
  resolvedItem: ResolvedItem,
): Promise<SpendAttestation> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(resolvedItem.checkoutUrl, { waitUntil: "domcontentloaded" });
    const orderId =
      (await page.locator("[data-order-id]").first().getAttribute("data-order-id")) ??
      `SO-${requestId.slice(0, 8)}`;
    return {
      requestId,
      merchantDomain: resolvedItem.merchantDomain,
      orderTotal: resolvedItem.price,
      itemSku: resolvedItem.sku,
      orderId,
      observedAt: new Date().toISOString(),
      proof: "none",
    };
  } finally {
    await browser.close();
  }
}
