import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import type { Mandate } from "@straitsx/contracts";
import { getOnChainMandate } from "../../../lib/chain-gateway";
import { buildCreateMandateTx } from "../../../lib/mandate-tx";
import { listTrackedMandates, stageMandate } from "../../../lib/mandate-store";
import { getPolicy } from "../../../lib/policy";

/** api-contracts.md §9 GET /api/mandates — list + on-chain live state (C11). */
export async function GET() {
  const rows = await Promise.all(
    listTrackedMandates().map(async ({ mandate, confirmed, stagedAt }) => {
      const [onChain, policyRecord] = confirmed
        ? await Promise.all([
            getOnChainMandate(mandate.mandateId, mandate.chainId).catch(() => null),
            getPolicy(mandate.mandateId).catch(() => null),
          ])
        : [null, null];
      return { mandate, confirmed, stagedAt, onChain, inSync: policyRecord?.inSync ?? null };
    }),
  );
  return NextResponse.json(rows);
}

type CreateMandateBody = Omit<Mandate, "mandateId" | "policyVersion" | "revoked">;

/** api-contracts.md §9 POST /api/mandates — build an unsigned createMandate tx (C11). */
export async function POST(request: Request) {
  const body = (await request.json()) as CreateMandateBody;
  const mandateId = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const mandate: Mandate = { ...body, mandateId, revoked: false, policyVersion: 1 };

  let built: ReturnType<typeof buildCreateMandateTx>;
  try {
    built = buildCreateMandateTx(mandate);
  } catch (err) {
    return NextResponse.json({ error: { message: err instanceof Error ? err.message : String(err) } }, { status: 400 });
  }

  stageMandate(mandate);
  return NextResponse.json({ mandateId, policyHash: built.policyHash, unsignedTx: built.unsignedTx });
}
