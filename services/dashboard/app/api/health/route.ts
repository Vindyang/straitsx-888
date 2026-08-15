import { NextResponse } from "next/server";

const AGENT_ORCHESTRATOR_URL = process.env["AGENT_ORCHESTRATOR_URL"] ?? "http://localhost:4005";

export async function GET() {
  try {
    const res = await fetch(`${AGENT_ORCHESTRATOR_URL}/health`, { cache: "no-store" });
    return NextResponse.json({ reachable: res.ok });
  } catch {
    return NextResponse.json({ reachable: false });
  }
}
