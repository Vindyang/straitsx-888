const AGENT_ORCHESTRATOR_URL = process.env["AGENT_ORCHESTRATOR_URL"] ?? "http://localhost:4005";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

/** Streams agent-orchestrator's SSE run events straight through to the browser. */
export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const upstream = await fetch(`${AGENT_ORCHESTRATOR_URL}/run/${requestId}/events`, {
    headers: { "x-internal-token": INTERNAL_TOKEN },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
