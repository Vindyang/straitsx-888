import { NextResponse } from "next/server";

/**
 * Server-route proxy: the browser never calls agent-orchestrator directly, so
 * the internal token never reaches the client (docs/conventions.md §3, "the
 * browser never calls policy-service or ledger-service directly").
 */
const AGENT_ORCHESTRATOR_URL = process.env["AGENT_ORCHESTRATOR_URL"] ?? "http://localhost:4005";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

export async function POST(request: Request) {
  const body: unknown = await request.json();
  const res = await fetch(`${AGENT_ORCHESTRATOR_URL}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json();
  return NextResponse.json(data, { status: res.status });
}
