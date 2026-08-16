import { NextResponse } from "next/server";
import { getWindowUsage } from "../../../../lib/ledger";
import { getPolicy } from "../../../../lib/policy";

/** api-contracts.md §9 GET /api/window/:mandateId — running spend meter (C14). */
export async function GET(_request: Request, { params }: { params: Promise<{ mandateId: string }> }) {
  const { mandateId } = await params;
  const policyRecord = await getPolicy(mandateId);
  if (!policyRecord) {
    return NextResponse.json({ error: { message: `no policy on file for ${mandateId}` } }, { status: 404 });
  }
  const usage = await getWindowUsage(mandateId, policyRecord.policy.windowSeconds, policyRecord.policy.maxPerWindow);
  return NextResponse.json({
    ...usage,
    maxPerWindow: policyRecord.policy.maxPerWindow,
    maxCardsPerWindow: policyRecord.policy.maxCardsPerWindow,
  });
}
