const LEDGER_URL = process.env["LEDGER_URL"] ?? "http://localhost:4001";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

/** Streams ledger-service's live SSE feed (api-contracts.md §5) straight through to the browser. */
export async function GET() {
  const upstream = await fetch(`${LEDGER_URL}/ledger/events`, {
    headers: { "x-internal-token": INTERNAL_TOKEN },
  });
  if (!upstream.ok) {
    return Response.json({ error: `ledger feed unavailable (${upstream.status})` }, { status: upstream.status });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}