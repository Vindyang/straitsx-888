import "server-only";

const LEDGER_URL = process.env["LEDGER_URL"] ?? "http://localhost:4001";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${LEDGER_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN, ...init?.headers },
  });
}

export type Receipt = {
  requestId: string;
  mandateId: string;
  policyHash: string | null;
  intent: string;
  challenge: { payTo: string; asset: string; chainId: number; amount: string } | null;
  authorization: { validAfter: number | null; validBefore: number | null; nonce: string } | null;
  settlementTx: string | null;
  blockNumber: number | null;
  cardOpaqueId: string | null;
  decision: string | null;
  decidedAt: string | null;
  spendLeg:
    | { status: "observed"; merchantDomain: string; orderTotal: string; proof: "none" }
    | { status: "absent"; proof: "none" };
};

/** api-contracts.md §9 GET /receipt/:requestId (C13). */
export async function getReceipt(requestId: string): Promise<Receipt | null> {
  const res = await call(`/receipt/${requestId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ledger getReceipt ${res.status}`);
  return res.json() as Promise<Receipt>;
}

export type WindowUsage = {
  mandateId: string;
  windowSeconds: number;
  windowStartedAt: string;
  spent: string;
  cardCount: number;
  remaining?: string;
};

/** api-contracts.md §9 GET /window/:mandateId (C14). */
export async function getWindowUsage(
  mandateId: string,
  windowSeconds: number,
  maxPerWindow: string,
): Promise<WindowUsage> {
  const res = await call(`/window/${mandateId}?windowSeconds=${windowSeconds}&maxPerWindow=${maxPerWindow}`);
  if (!res.ok) throw new Error(`ledger getWindowUsage ${res.status}`);
  return res.json() as Promise<WindowUsage>;
}

/** Read-only intent view as served by ledger-service's GET /intents (api-contracts.md §5). */
export type IntentView = {
  requestId: string;
  mandateId: string;
  agentId: string;
  instruction: string;
  instructionHash: string;
  createdAt: string;
  state: "INTENT_CREATED" | "CHALLENGE_ATTACHED" | "NONCE_RESERVED" | "SIGNED" | "SETTLED" | "CAPTURED";
  decision?: "signed" | "refused" | "escalated";
  decidedAt?: string;
  check?: string;
  detail?: string;
  policyHash?: string;
  merchantDomain?: string;
  challenge?: { payTo: string; asset: string; chainId: number; amount: string };
  nonce?: string;
  nonceReserved?: boolean;
  settlement?: { settlementTx: string; blockNumber: number; cardOpaqueId: string };
  spend?: { merchantDomain: string; orderTotal: string; itemSku: string; orderId: string; observedAt: string };
  capture?: { orderId: string; capturedAt: string; settlementTx: string; blockNumber: number };
};

export type LedgerAppendEvent = {
  seq: number;
  kind: string;
  at: string;
  requestId?: string;
  mandateId?: string;
  state?: string;
  intent?: IntentView;
  detail?: Record<string, unknown>;
};

export type LedgerSnapshot = { intents: IntentView[] };

/** GET /intents — full append-only ledger, newest first, view-shaped. */
export async function listLedgerIntents(): Promise<IntentView[]> {
  const res = await call("/intents");
  if (!res.ok) throw new Error(`ledger listIntents ${res.status}`);
  const body = (await res.json()) as LedgerSnapshot;
  return body.intents;
}