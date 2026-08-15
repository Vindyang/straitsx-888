import { NextResponse } from "next/server";
import { getTrackedMandate, markConfirmed } from "../../../../../lib/mandate-store";
import { putPolicy } from "../../../../../lib/policy";

/**
 * Called AFTER the browser's wallet has mined the createMandate transaction.
 * Only then does the policy body get PUT to policy-service — its PUT handler
 * checks the proposed hash against the on-chain policyHash and 409s
 * (POLICY_HASH_DRIFT) if the mandate isn't live yet, so calling this before
 * confirmation on-chain would fail by design, not by accident.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ mandateId: string }> }) {
  const { mandateId } = await params;
  const tracked = getTrackedMandate(mandateId);
  if (!tracked) {
    return NextResponse.json({ error: { message: `no staged mandate ${mandateId}` } }, { status: 404 });
  }

  const result = await putPolicy(mandateId, tracked.mandate);
  if (!result.ok) {
    return NextResponse.json({ error: { code: result.code, message: result.message } }, { status: result.status });
  }
  markConfirmed(mandateId);
  return NextResponse.json(result);
}
