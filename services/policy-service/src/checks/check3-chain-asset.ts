import { refuse, type CheckContext, type CheckFailure } from "./types.js";

/** B14 — chain and asset pinned exactly (asset compared lowercased). */
export function check3_chain_asset(ctx: CheckContext): CheckFailure | null {
  if (ctx.challenge.chainId !== ctx.mandate.chainId) {
    return refuse(
      "check3_chain_asset",
      `challenge.chainId ${ctx.challenge.chainId} != mandate.chainId ${ctx.mandate.chainId}`,
    );
  }
  if (ctx.challenge.asset.toLowerCase() !== ctx.mandate.asset.toLowerCase()) {
    return refuse(
      "check3_chain_asset",
      `challenge.asset ${ctx.challenge.asset} != mandate.asset ${ctx.mandate.asset}`,
    );
  }
  return null;
}
