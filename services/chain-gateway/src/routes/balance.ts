/**
 * A9 — `GET /balance?address=0x…&chainId=43113`
 *
 * XSGD via `balanceOf`, AVAX via `eth_getBalance`, both as base-unit strings.
 * `xsgdFormatted` is a convenience for the dashboard only — never compare on it.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { getAddress } from "viem";
import {
  AppError,
  CHAINS,
  ERC20_READ_ABI,
  XSGD_DECIMALS,
  type BalanceResponse,
} from "@straitsx/contracts";
import { getPublicClient, parseChainId, withRpc } from "../chain";

export function parseAddress(raw: unknown): `0x${string}` {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw AppError.badRequest(
      `address must be 0x-prefixed 20-byte hex, got "${String(raw)}"`,
    );
  }
  return raw as `0x${string}`;
}

/**
 * Base units -> a fixed-point decimal string, exactly `decimals` places.
 *
 * Deliberately integer-only: routing this through Number would lose precision
 * above 2^53 and is the same class of bug as putting money in a JSON number.
 */
export function formatUnits(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const body = decimals === 0 ? whole : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

export function registerBalanceRoute(app: FastifyInstance): void {
  app.get(
    "/balance",
    async (
      req: FastifyRequest<{ Querystring: { address?: string; chainId?: string } }>,
    ): Promise<BalanceResponse> => {
      const chainId = parseChainId(req.query.chainId);
      const address = parseAddress(req.query.address);
      const client = getPublicClient(chainId);
      const xsgdAddress = CHAINS[chainId].xsgd as `0x${string}`;

      const [xsgd, avaxWei] = await withRpc(
        `reading balances on chain ${chainId}`,
        () =>
          Promise.all([
            client.readContract({
              address: xsgdAddress,
              abi: ERC20_READ_ABI,
              functionName: "balanceOf",
              args: [address],
            }) as Promise<bigint>,
            client.getBalance({ address }),
          ]),
      );

      return {
        address: getAddress(address),
        xsgd: xsgd.toString(),
        xsgdFormatted: formatUnits(xsgd, XSGD_DECIMALS),
        avaxWei: avaxWei.toString(),
      };
    },
  );
}
