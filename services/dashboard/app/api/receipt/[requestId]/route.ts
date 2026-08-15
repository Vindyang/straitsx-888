import { NextResponse } from "next/server";
import { getReceipt } from "../../../../lib/ledger";

/** api-contracts.md §9 GET /api/receipt/:requestId (C13). */
export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const receipt = await getReceipt(requestId);
  if (!receipt) {
    return NextResponse.json({ error: { message: `no receipt for ${requestId}` } }, { status: 404 });
  }
  return NextResponse.json(receipt);
}
