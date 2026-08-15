/**
 * A8 — `POST /settlement/confirm`
 *
 * This is what makes the receipt trustworthy rather than decorative.
 *
 * A `status: 1` receipt only proves a transaction did not revert. It does NOT
 * prove that the asset we expected moved, in the amount we expected, to the
 * recipient we expected. So we decode the `Transfer` log and match
 * `{ asset, to, amount }` against `expect` — a receipt whose log does not match
 * returns `ok: false, transferMatched: false`.
 *
 * Done when: a deliberately mismatched `expect` returns ok: false.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { decodeEventLog, getAddress } from "viem";
import {
  AppError,
  ERC20_TRANSFER_EVENT_ABI,
  ErrorCode,
  type SettlementConfirmRequest,
  type SettlementConfirmResponse,
} from "@straitsx/contracts";
import { getPublicClient, parseChainId, withRpc } from "../chain";

function parseBody(body: unknown): SettlementConfirmRequest {
  if (typeof body !== "object" || body === null) {
    throw AppError.badRequest("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const txHash = b["txHash"];
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw AppError.badRequest("txHash must be 0x-prefixed 32-byte hex");
  }

  const expectRaw = b["expect"];
  if (typeof expectRaw !== "object" || expectRaw === null) {
    throw AppError.badRequest("expect is required");
  }
  const e = expectRaw as Record<string, unknown>;

  for (const field of ["asset", "to"] as const) {
    if (typeof e[field] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(e[field] as string)) {
      throw AppError.badRequest(`expect.${field} must be a 20-byte hex address`);
    }
  }
  // Money is a base-unit decimal string, never a JSON number (§0).
  if (typeof e["amount"] !== "string" || !/^[0-9]+$/.test(e["amount"])) {
    throw AppError.badRequest(
      "expect.amount must be a base-unit decimal string, e.g. \"5000000\"",
    );
  }

  return {
    txHash,
    chainId: Number(b["chainId"]),
    expect: {
      asset: e["asset"] as string,
      to: e["to"] as string,
      amount: e["amount"],
    },
  };
}

export function registerSettlementRoute(app: FastifyInstance): void {
  app.post(
    "/settlement/confirm",
    async (req: FastifyRequest): Promise<SettlementConfirmResponse> => {
      const body = parseBody(req.body);
      const chainId = parseChainId(body.chainId);
      const client = getPublicClient(chainId);

      const receipt = await withRpc(`fetching receipt on chain ${chainId}`, async () => {
        try {
          return await client.getTransactionReceipt({
            hash: body.txHash as `0x${string}`,
          });
        } catch (err) {
          // viem throws TransactionReceiptNotFoundError for an unmined or
          // unknown hash. That is a 404, not an RPC outage — do not let it
          // become a 502 and read as "the chain is down".
          const name = (err as { name?: string }).name;
          if (name === "TransactionReceiptNotFoundError") {
            throw AppError.notFound(
              ErrorCode.TX_NOT_FOUND,
              `no receipt for ${body.txHash} on chain ${chainId} — not mined, or wrong chain`,
            );
          }
          throw err;
        }
      });

      const currentBlock = await withRpc("reading head block", () =>
        client.getBlockNumber(),
      );

      const blockNumber = Number(receipt.blockNumber);
      const confirmations = Math.max(
        0,
        Number(currentBlock - receipt.blockNumber) + 1,
      );

      const match = findMatchingTransfer(receipt.logs, body.expect);

      return {
        // A reverted tx can never have settled, and a status:1 tx whose log
        // does not match did not settle what we asked for. Both are ok: false.
        ok: receipt.status === "success" && match !== null,
        blockNumber,
        confirmations,
        transferMatched: match !== null,
        logIndex: match?.logIndex ?? null,
      };
    },
  );
}

type LogLike = {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex: number | null;
};

/**
 * Finds a `Transfer` log matching all three of `{ asset, to, amount }`.
 *
 * All three must match on the SAME log. Matching them across different logs
 * would let a transaction that moves the right amount of the wrong token to the
 * right address pass as settled.
 *
 * Addresses compare lowercased (§0); amount compares as BigInt so "5000000" and
 * "05000000" are the same number rather than different strings.
 */
export function findMatchingTransfer(
  logs: readonly LogLike[],
  expect: { asset: string; to: string; amount: string },
): { logIndex: number } | null {
  const wantAsset = expect.asset.toLowerCase();
  const wantTo = expect.to.toLowerCase();
  const wantAmount = BigInt(expect.amount);

  for (const log of logs) {
    if (log.address.toLowerCase() !== wantAsset) continue;

    let decoded: { args: { to?: string; value?: bigint } };
    try {
      decoded = decodeEventLog({
        abi: ERC20_TRANSFER_EVENT_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      }) as unknown as { args: { to?: string; value?: bigint } };
    } catch {
      // Not a Transfer — the token emits other events too. Keep looking.
      continue;
    }

    const { to, value } = decoded.args;
    if (typeof to !== "string" || typeof value !== "bigint") continue;
    if (to.toLowerCase() !== wantTo) continue;
    if (value !== wantAmount) continue;

    return { logIndex: log.logIndex ?? 0 };
  }

  return null;
}

/** Exported for the dashboard link in the receipt. */
export function checksum(address: string): string {
  return getAddress(address);
}
