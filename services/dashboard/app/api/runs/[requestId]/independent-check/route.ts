import { NextResponse } from "next/server";
import { getRun } from "../../../../../lib/orchestrator";

/**
 * C15 — an INDEPENDENT server-side re-fetch of the page discovery originally
 * read, deliberately via a different code path than the agent's own
 * discoverProduct() Playwright pass (execution_plan.md §12b 2.3: "never
 * render the agent's resolvedItem as ground truth — the independent fetch is
 * the real control"). This is a plain `fetch()` + light attribute extraction,
 * not a hardened scraper — it exists to demonstrate the pattern (a second,
 * separate read), not to defeat an adversarial page swap between discovery
 * time and escalation time, which these static fixtures don't model anyway.
 */
function extractProductAttributes(html: string): { title?: string; sku?: string; price?: string } {
  const tagMatch = html.match(/<div[^>]*data-product[^>]*>/);
  if (!tagMatch) return {};
  const tag = tagMatch[0];
  const attr = (name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  return { title: attr("data-title"), sku: attr("data-sku"), price: attr("data-price") };
}

export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const run = await getRun(requestId);
  if (!run) {
    return NextResponse.json({ error: { message: `no run for ${requestId}` } }, { status: 404 });
  }

  const productUrl = run.meta.productUrl;
  const res = await fetch(productUrl, { cache: "no-store" });
  const html = await res.text();

  return NextResponse.json({
    productUrl,
    independentlyFetched: extractProductAttributes(html),
    agentResolved: run.resolvedItem ?? null,
  });
}
