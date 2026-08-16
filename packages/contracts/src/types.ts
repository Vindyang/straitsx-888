/**
 * Shared wire types. Copied from docs/api-contracts.md §1 — do not drift.
 *
 * Conventions (§0), applied everywhere:
 *   - Money is a base-unit decimal STRING. Never a JSON number: 2^53 and float
 *     rounding both bite. `"5000000"` is 5 XSGD at 6 decimals.
 *   - Addresses are EIP-55 checksummed in JSON, but always COMPARED LOWERCASED.
 *   - Hex is `0x`-prefixed lowercase, even length.
 *   - Chain time is unix seconds (number). Log time is an ISO-8601 UTC string.
 */

/** "0x" + 40 hex, EIP-55 checksummed. */
export type Address = string;
/** "0x" + even-length lowercase hex. */
export type Hex = string;
/** Base-unit decimal string. */
export type Uint = string;

export type ChainId = 43113 | 43114;

/** Parsed from the cardapi 402. One entry of `accepts`, normalised. */
export type X402Requirements = {
  x402Version: number; // 1
  scheme: "exact";
  network: string; // "eip155:43113"
  chainId: number; // 43113
  amount: Uint; // "5000000"
  asset: Address; // XSGD contract
  payTo: Address; // StraitsX receiver
  maxTimeoutSeconds: number; // 300
  extra: {
    assetTransferMethod: "eip3009";
    name: string; // "XSGD" -> EIP-712 domain.name
    version: string; // "2"    -> EIP-712 domain.version
  };
};

export type Mandate = {
  mandateId: Hex; // bytes32
  owner: Address; // human; only address that can revoke
  agentId: string;
  chainId: ChainId;
  asset: Address;
  settlementRecipient: Address;
  maxPerCard: Uint;
  maxPerWindow: Uint;
  maxCardsPerWindow: number;
  windowSeconds: number;
  maxAuthValiditySeconds: number;
  expiresAt: number; // unix seconds
  revoked: boolean;
  // api-contracts.md §1 omits this field; execution_plan.md §7's full schema requires it
  // and owner-b-tasks.md B2/B13 requires it be hashed. Included per the latter — a tampered
  // intentConstraint must fail check 2.
  intentConstraint: string;
  merchantAllowlist: string[]; // ADVISORY — binds only a behaving agent
  policyVersion: number;
};

export type Decision =
  | {
      status: "signed";
      header: string;
      nonce: Hex;
      validAfter: number;
      validBefore: number;
    }
  | { status: "refused"; check: string; detail: string }
  | { status: "escalated"; approvalUrl: string; expiresAt: number };

/**
 * EIP-712 typed data for EIP-3009 TransferWithAuthorization.
 *
 * The 402 contains NEITHER `validAfter` NOR `validBefore` — only
 * `maxTimeoutSeconds`. The validity window is ours to choose, bounded by
 * `min(mandate.maxAuthValiditySeconds, challenge.maxTimeoutSeconds)`.
 * See docs/api-contracts.md §1 and docs/execution_plan.md §19.3.
 */
export type TransferWithAuthorizationTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  primaryType: "TransferWithAuthorization";
  types: {
    TransferWithAuthorization: ReadonlyArray<{ name: string; type: string }>;
  };
  message: {
    from: Address;
    to: Address;
    value: Uint;
    validAfter: number;
    validBefore: number;
    nonce: Hex;
  };
};

/** Request body of signer-service `POST /sign`.
 *
 * NOTE: `mandateId` is a TOP-LEVEL SIBLING of `typedData`. The JSON example in
 * api-contracts.md §4 omits it; the line below the refusal table adds it
 * ("`POST /sign` therefore also takes `mandateId` alongside `typedData`").
 * The rail cannot work without it. */
/**
 * One entry of the challenge's `accepts[]` — the requirement the client chose
 * to satisfy. Goes into the x402 v2 payment payload as `accepted`, and the
 * facilitator reads `accepted.amount` to learn what is being paid.
 *
 * Confirmed live at checkpoint 2 (2026-08-15): omitting it produces
 * `cannot parse payment amount: invalid atomic amount ""`, because the server
 * has nowhere else to read the amount from.
 */
export type X402Accepted = Omit<X402Requirements, "x402Version">;

export type SignRequest = {
  requestId: string; // UUIDv4, idempotency key across every service
  mandateId: Hex;
  typedData: TransferWithAuthorizationTypedData;
  /**
   * The challenge entry being satisfied, passed straight through from the 402.
   * REQUIRED: without it the emitted header cannot be settled.
   */
  accepted: X402Accepted;
  /** The resource being paid for — the cardapi URL from the challenge. */
  resource: string;
};

export type SignResponse = {
  requestId: string;
  /** base64 PAYMENT-SIGNATURE value, ready to send verbatim. */
  header: string;
  signature: { v: number; r: Hex; s: Hex };
  signerAddress: Address;
  signedAt: string; // ISO-8601 UTC
};

/** One entry of the signer's immutable pinned map, loaded from env at boot. */
export type PinnedMandate = {
  settlementRecipient: Address;
  hardMaxTotal: Uint;
};

// ---------------------------------------------------------------------------
// chain-gateway response shapes (api-contracts.md §3)
// ---------------------------------------------------------------------------

export type TokenConstants = {
  chainId: number;
  address: Address;
  name: string;
  decimals: number;
  /** ALWAYS null. `version()` reverts on both chains; callers take it from
   *  `challenge.extra.version`. Returning null is correct, not a failure. */
  version: null;
  versionSource: "x402-challenge-only";
  readAt: string;
};

export type MandateReadResponse = {
  mandateId: Hex;
  owner: Address;
  policyHash: Hex;
  expiresAt: number;
  revoked: boolean;
  readAtBlock: number;
};

export type SettlementConfirmRequest = {
  txHash: Hex;
  chainId: number;
  expect: { asset: Address; to: Address; amount: Uint };
};

export type SettlementConfirmResponse = {
  ok: boolean;
  blockNumber: number;
  confirmations: number;
  transferMatched: boolean;
  logIndex: number | null;
};

export type BalanceResponse = {
  address: Address;
  xsgd: Uint;
  xsgdFormatted: string;
  avaxWei: Uint;
};

export type BuildRevokeRequest = {
  mandateId: Hex;
  chainId: number;
  from: Address;
};

/** Unsigned. chain-gateway never signs — the human signs in their own wallet. */
export type UnsignedTx = {
  to: Address;
  data: Hex;
  value: Uint;
  chainId: number;
  gasLimit: Uint;
};
