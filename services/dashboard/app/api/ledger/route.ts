import { listLedgerIntents } from "@/lib/ledger";

/** GET /api/ledger — snapshot backing for the transparency page. */
export async function GET() {
  try {
    const intents = await listLedgerIntents();
    return Response.json({ intents });
  } catch (error) {
    return Response.json({ intents: [], error: error instanceof Error ? error.message : "ledger unreachable" }, { status: 503 });
  }
}