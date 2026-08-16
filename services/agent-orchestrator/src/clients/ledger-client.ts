import type { X402Requirements } from "@straitsx/contracts";

const LEDGER_URL = process.env["LEDGER_URL"] ?? "http://localhost:4001";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${LEDGER_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL_TOKEN,
      ...init?.headers,
    },
  });
}

/** B3, called BEFORE the challenge is fetched — check 8 depends on this ordering. */
export async function createIntent(entry: {
  requestId: string;
  mandateId: string;
  agentId: string;
  instruction: string;
  createdAt: string;
}): Promise<{ requestId: string; state: string; instructionHash: string }> {
  const res = await call("/intent", { method: "POST", body: JSON.stringify(entry) });
  // 409 INTENT_EXISTS is idempotent-safe: requestId is minted once per run, so a
  // second attempt here means a retried request, not a real collision.
  if (!res.ok && res.status !== 409) {
    throw new Error(`ledger createIntent ${res.status}`);
  }
  return res.json() as Promise<{ requestId: string; state: string; instructionHash: string }>;
}

export async function attachChallenge(
  requestId: string,
  challenge: X402Requirements,
): Promise<{ requestId: string; state: string; attachedAt: string }> {
  const res = await call(`/intent/${requestId}/challenge`, {
    method: "POST",
    body: JSON.stringify({ challenge }),
  });
  if (!res.ok) throw new Error(`ledger attachChallenge ${res.status}`);
  return res.json() as Promise<{ requestId: string; state: string; attachedAt: string }>;
}

export async function recordSettlement(entry: {
  requestId: string;
  settlementTx: string;
  blockNumber: number;
  cardOpaqueId: string;
  rawToolResultHash?: `0x${string}`;
}): Promise<{ requestId: string; state: string; settlementTx: string }> {
  const { requestId, ...body } = entry;
  const res = await call(`/intent/${requestId}/settlement`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`ledger recordSettlement ${res.status}`);
  return res.json() as Promise<{ requestId: string; state: string; settlementTx: string }>;
}

export async function recordSpend(entry: {
  requestId: string;
  merchantDomain: string;
  orderTotal: string;
  itemSku: string;
  orderId: string;
  observedAt: string;
  proof?: "none" | "ucp";
}): Promise<{ recorded: boolean; spendLeg: { status: string; proof: string } }> {
  const { requestId, ...body } = entry;
  const res = await call(`/intent/${requestId}/spend`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`ledger recordSpend ${res.status}`);
  return res.json() as Promise<{ recorded: boolean; spendLeg: { status: string; proof: string } }>;
}

/** Capture-time settlement finalization — recorded only after the on-chain transfer
 *  was independently verified (SETTLEMENT_FINALIZED). */
export async function recordCapture(entry: {
  requestId: string;
  orderId: string;
  capturedAt: string;
  settlementTx: string;
  blockNumber: number;
}): Promise<{ requestId: string; state: string; orderId: string; settlementTx: string }> {
  const { requestId, ...body } = entry;
  const res = await call(`/intent/${requestId}/capture`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`ledger recordCapture ${res.status}`);
  return res.json() as Promise<{ requestId: string; state: string; orderId: string; settlementTx: string }>;
}
