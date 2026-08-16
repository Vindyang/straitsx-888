const CHAIN_GATEWAY_URL = process.env["CHAIN_GATEWAY_URL"] ?? "http://localhost:4004";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

export type SettlementConfirmResult = {
  ok: boolean;
  blockNumber: number;
  confirmations: number;
  transferMatched: boolean;
  logIndex: number | null;
};

/** api-contracts.md §3 `POST /settlement/confirm` — verify settlement independently
 *  rather than trusting the cardapi's own claim of success. */
export async function confirmSettlement(entry: {
  txHash: string;
  chainId: number;
  expect: { asset: string; to: string; amount: string };
}): Promise<SettlementConfirmResult> {
  const res = await fetch(`${CHAIN_GATEWAY_URL}/settlement/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error(`chain-gateway confirmSettlement ${res.status}`);
  return res.json() as Promise<SettlementConfirmResult>;
}
