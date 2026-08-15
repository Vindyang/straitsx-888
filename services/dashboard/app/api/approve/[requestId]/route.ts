import { NextResponse } from "next/server";
import { resolveEscalation } from "../../../../lib/policy";

/** api-contracts.md §9 POST /api/approve/:requestId — resolve an escalation (C15). */
export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const body = (await request.json()) as {
    decision: "approve" | "deny";
    approvedBy?: string;
    standingApproval?: { scope: "once" | "merchant-window" };
  };
  const result = await resolveEscalation(requestId, body);
  return NextResponse.json(result);
}
