import { NextResponse } from "next/server";

const AGENT_ORCHESTRATOR_URL = process.env["AGENT_ORCHESTRATOR_URL"] ?? "http://localhost:4005";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "";

export async function GET() {
  try {
    const response = await fetch(`${AGENT_ORCHESTRATOR_URL}/ready`, {
      cache: "no-store",
      headers: INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : undefined,
      signal: AbortSignal.timeout(4_000),
    });
    const body: unknown = await response.json();
    return NextResponse.json(body, { status: response.status });
  } catch {
    return NextResponse.json(
      {
        ready: false,
        dependencies: { ledger: "unavailable", policy: "unavailable", chainGateway: "unavailable" },
      },
      { status: 503 },
    );
  }
}
