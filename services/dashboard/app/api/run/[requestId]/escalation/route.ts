import { NextResponse } from "next/server";

const ORCHESTRATOR_URL = process.env["AGENT_ORCHESTRATOR_URL"] ?? "http://localhost:4005";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const response = await fetch(`${ORCHESTRATOR_URL}/run/${requestId}/escalation`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify(await request.json()),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
