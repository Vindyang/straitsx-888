import type { Address, Uint } from "./mandate.js";

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
    version: string; // "2"   -> EIP-712 domain.version
  };
};
