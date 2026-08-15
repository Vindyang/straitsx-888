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

/** api-contracts.md §5 GET /receipt/:requestId (C13). */
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

/** api-contracts.md §5 GET /window/:mandateId (C14). */
export async function getWindowUsage(
  mandateId: string,
  windowSeconds: number,
  maxPerWindow: string,
): Promise<WindowUsage> {
  const res = await call(`/window/${mandateId}?windowSeconds=${windowSeconds}&maxPerWindow=${maxPerWindow}`);
  if (!res.ok) throw new Error(`ledger getWindowUsage ${res.status}`);
  return res.json() as Promise<WindowUsage>;
}
