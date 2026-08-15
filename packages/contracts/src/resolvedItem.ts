import type { Uint } from "./types";

/** The agent's self-report from discovery. A starting hint only — never ground truth. */
export type ResolvedItem = {
  title: string;
  sku: string;
  price: Uint;
  merchantDomain: string;
  checkoutUrl: string;
};
