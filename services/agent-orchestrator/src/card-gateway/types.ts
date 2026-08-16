import type { Address, X402Requirements } from "@straitsx/contracts";

export type GetCardParams = {
  walletAddress: Address;
  cardholderName: string;
  amountSgd: number;
};

export type GetCardResult = {
  cardapiUrl: string;
  challenge: X402Requirements;
  /** keccak256 of the raw, untrusted MCP tool result text. Kept for the
   *  receipt; the body itself is discarded immediately after filtering
   *  (never forwarded — see mcp-result-filter.ts). */
  rawToolResultHash: `0x${string}`;
};

export type PayAndIssueParams = {
  cardapiUrl: string;
  header: string;
  amountSgd: number;
  cardholderName: string;
};

export type PayAndIssueResult =
  | { ok: true; cardOpaqueId: string; settlementTx: string; issuedAt: string }
  | { ok: false; status: 402; challenge: X402Requirements };

export type ViewCardParams = {
  cardOpaqueId: string;
  settlementTx: string;
  walletAddress: Address;
};

export type ViewCardResult = {
  iframeUrl: string;
  expiresInSeconds: number;
  singleUse: true;
};
