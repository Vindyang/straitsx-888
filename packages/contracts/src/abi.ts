/**
 * Minimal on-chain ABIs. Only what chain-gateway is allowed to call.
 *
 * NOTE THE ABSENCES. `version()`, `DOMAIN_SEPARATOR()` and `eip712Domain()` are
 * deliberately NOT here: all three REVERT on both Fuji and mainnet XSGD
 * (docs/execution_plan.md §19.2). A startup that calls them crashes the service
 * before it can sign anything. The EIP-712 `version` string comes from
 * `challenge.extra.version` and nowhere else.
 */

export const ERC20_READ_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** The settlement receipt check (A8) decodes this log and matches it against
 *  `expect`. A `status: 1` receipt whose log does not match returns ok: false. */
export const ERC20_TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;
