import { NextResponse } from "next/server";
import { getRun } from "../../../../lib/orchestrator";

export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const run = await getRun(requestId);
  if (!run) {
    return NextResponse.json({ error: { message: `no run for ${requestId}` } }, { status: 404 });
  }
  return NextResponse.json(run);
}
