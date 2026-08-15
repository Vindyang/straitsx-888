/**
 * Verified constants. Source: docs/api-contracts.md §0 and docs/execution_plan.md §19.
 *
 * `mainnet.settlementRecipient` and `mainnet.eip712Version` are NULL until the
 * production 402 is fetched (§19.7). Any code path that reads a null here must
 * REFUSE, never default. In particular: do not inherit `version: "2"` from Fuji.
 */

import type { Address, ChainId } from "./types";

export type ChainConstants = {
  chainId: ChainId;
  rpc: string;
  xsgd: Address;
  /** null on mainnet until the production 402 is fetched. */
  settlementRecipient: Address | null;
  eip712Name: string;
  /** null on mainnet — must NOT be inherited from Fuji. */
  eip712Version: string | null;
  explorerTxBase: string;
};

export const FUJI: ChainConstants = {
  chainId: 43113,
  rpc: "https://api.avax-test.network/ext/bc/C/rpc",
  xsgd: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
  settlementRecipient: "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8",
  eip712Name: "XSGD",
  eip712Version: "2",
  explorerTxBase: "https://testnet.snowtrace.io/tx/",
};

export const MAINNET: ChainConstants = {
  chainId: 43114,
  rpc: "https://api.avax.network/ext/bc/C/rpc",
  xsgd: "0xb2F85b7AB3c2b6f62DF06dE6aE7D09c010a5096E",
  settlementRecipient: null,
  eip712Version: null,
  eip712Name: "XSGD",
  explorerTxBase: "https://snowtrace.io/tx/",
};

export const CHAINS: Record<ChainId, ChainConstants> = {
  43113: FUJI,
  43114: MAINNET,
};

export const SUPPORTED_CHAIN_IDS: readonly ChainId[] = [43113, 43114];

export function isSupportedChainId(v: unknown): v is ChainId {
  return v === 43113 || v === 43114;
}

/**
 * XSGD is 6 decimals on BOTH chains. Never assume 18 — an 18-decimal assumption
 * mis-encodes every amount by 10^12 and the signature then verifies against the
 * wrong value, silently. Asserted at chain-gateway boot (A6).
 */
export const XSGD_DECIMALS = 6;

/**
 * The signer's hard ceiling on the authorization window, in seconds.
 * `validBefore - validAfter > 600` is refused (SIGNER_WINDOW). A long window is
 * a signed cheque left lying around.
 */
export const MAX_AUTH_WINDOW_SECONDS = 600;

export const CARDAPI_SANDBOX_ISSUE_CARD =
  "https://card.straitsx.ai/sandbox/cardapi/issue_card";
export const CARDAPI_PRODUCTION_ISSUE_CARD =
  "https://card.straitsx.ai/production/cardapi/issue_card";
export const MCP_SSE_SANDBOX = "https://card.straitsx.ai/sandbox/sse";
export const MCP_SSE_PRODUCTION = "https://card.straitsx.ai/production/sse";

/**
 * The wallet the organisers funded with 30 XSGD on both chains
 * (docs/execution_plan.md §19.5). It is an EOA whose key lives in a wallet app,
 * NOT in KMS.
 *
 * It is NOT the paying wallet at runtime — see docs/adr/0001-kms-custody.md.
 * A freshly created KMS key derives its own address, so the signer asserts
 * against `EXPECTED_SIGNER_ADDRESS` from env instead. This constant is kept
 * only as the documented origin of the funds and the source of the transfer.
 */
export const FUNDING_ORIGIN_WALLET: Address =
  "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7";

export const SERVICE_PORTS = {
  ledger: 4001,
  policy: 4002,
  /** policy-service ONLY — enforced at the network layer, proven by A15. */
  signer: 4003,
  chainGateway: 4004,
  agentOrchestrator: 4005,
  dashboard: 3000,
} as const;
