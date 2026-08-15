import { NextResponse } from "next/server";
import { getOnChainMandate } from "../../../../lib/chain-gateway";
import { getTrackedMandate } from "../../../../lib/mandate-store";
import { getPolicy } from "../../../../lib/policy";

export async function GET(_request: Request, { params }: { params: Promise<{ mandateId: string }> }) {
  const { mandateId } = await params;
  const tracked = getTrackedMandate(mandateId);
  if (!tracked) {
    return NextResponse.json({ error: { message: `no mandate staged for ${mandateId}` } }, { status: 404 });
  }
  const [onChain, policyRecord] = await Promise.all([
    getOnChainMandate(mandateId, tracked.mandate.chainId).catch(() => null),
    getPolicy(mandateId).catch(() => null),
  ]);
  return NextResponse.json({
    mandateId,
    mandate: tracked.mandate,
    confirmed: tracked.confirmed,
    onChain,
    policyRecord,
  });
}
