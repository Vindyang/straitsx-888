import { NextResponse } from "next/server";

const AGENT_ORCHESTRATOR_URL = process.env["AGENT_ORCHESTRATOR_URL"] ?? "http://localhost:4005";

export async function GET() {
  try {
    const res = await fetch(`${AGENT_ORCHESTRATOR_URL}/health`, { cache: "no-store" });
    return NextResponse.json(
      { ok: res.ok, orchestrator: res.ok ? "reachable" : "unreachable" },
      { status: res.ok ? 200 : 503 },
    );
  } catch {
    return NextResponse.json({ ok: false, orchestrator: "unreachable" }, { status: 503 });
  }
}
