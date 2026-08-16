import { NextResponse } from "next/server";
import { buildRevokeTx } from "../../../../lib/chain-gateway";

/** api-contracts.md §9 POST /api/revoke/:mandateId — build an unsigned revoke tx (C11). */
export async function POST(request: Request, { params }: { params: Promise<{ mandateId: string }> }) {
  const { mandateId } = await params;
  const { chainId, from } = (await request.json()) as { chainId: number; from: string };
  try {
    const unsignedTx = await buildRevokeTx({ mandateId, chainId, from });
    return NextResponse.json({ unsignedTx });
  } catch (err) {
    return NextResponse.json({ error: { message: err instanceof Error ? err.message : String(err) } }, { status: 502 });
  }
}
