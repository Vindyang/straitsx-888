import { NextResponse } from "next/server";
import { listRuns } from "../../../lib/orchestrator";

/** api-contracts.md §9 GET /api/runs — run list + refusal panel backing (C12). */
export async function GET() {
  const runs = await listRuns();
  return NextResponse.json(runs);
}
