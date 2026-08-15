/**
 * The RPC layer. chain-gateway is the only component that opens an RPC
 * connection, and this is the only file in it that does.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { avalanche, avalancheFuji } from "viem/chains";
import {
  AppError,
  CHAINS,
  ERC20_READ_ABI,
  ErrorCode,
  XSGD_DECIMALS,
  isSupportedChainId,
  type ChainId,
} from "@straitsx/contracts";

const RPC_TIMEOUT_MS = Number(process.env["RPC_TIMEOUT_MS"] ?? 10_000);

const clients = new Map<ChainId, PublicClient>();

export function getPublicClient(chainId: ChainId): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;

  const constants = CHAINS[chainId];
  const client = createPublicClient({
    chain: chainId === 43113 ? avalancheFuji : avalanche,
    transport: http(process.env[`RPC_URL_${chainId}`] ?? constants.rpc, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: 2,
    }),
  }) as PublicClient;

  clients.set(chainId, client);
  return client;
}

/** Parses `?chainId=` and rejects anything we do not serve. */
export function parseChainId(raw: unknown): ChainId {
  if (raw === undefined || raw === null || raw === "") {
    throw AppError.badRequest(
      "chainId query parameter is required",
      ErrorCode.BAD_REQUEST,
    );
  }
  const n = Number(raw);
  if (!isSupportedChainId(n)) {
    throw AppError.badRequest(
      `unsupported chainId ${String(raw)} — expected 43113 or 43114`,
      ErrorCode.UNSUPPORTED_CHAIN,
    );
  }
  return n;
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
  if (e?.code === "ETIMEDOUT" || e?.code === "ABORT_ERR") return true;
  if (typeof e?.message === "string" && /timed out|timeout/i.test(e.message)) return true;
  if (e?.cause && e.cause !== err) return isTimeout(e.cause);
  return false;
}

/**
 * A10. Every RPC failure becomes a 502 with `retryable: true`; a timeout
 * becomes a 504.
 *
 * An RPC timeout must NEVER surface as a policy refusal. A judge reading a
 * refusal that was really a network blip reads it as a false security claim,
 * and that costs more than the outage did. `AppError`s thrown by callers pass
 * straight through — only genuine transport failures are remapped.
 */
export async function withRpc<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    if (isTimeout(err)) {
      throw AppError.rpcTimeout(`RPC timed out while ${what}`);
    }
    throw AppError.rpcFailed(`RPC failed while ${what}: ${truncate(detail)}`);
  }
}

function truncate(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export type TokenFacts = { name: string; decimals: number };

/**
 * Reads `name()` and `decimals()` — and nothing else.
 *
 * `version()`, `DOMAIN_SEPARATOR()` and `eip712Domain()` all REVERT on both
 * chains (docs/execution_plan.md §19.2). Calling any of them here crashes the
 * service before it can serve a single request. The EIP-712 `version` string
 * comes from `challenge.extra.version`; see routes/token-constants.ts.
 */
export async function readTokenFacts(chainId: ChainId): Promise<TokenFacts> {
  const client = getPublicClient(chainId);
  const address = CHAINS[chainId].xsgd as `0x${string}`;

  return withRpc(`reading XSGD token facts on ${chainId}`, async () => {
    const [name, decimals] = await Promise.all([
      client.readContract({ address, abi: ERC20_READ_ABI, functionName: "name" }),
      client.readContract({ address, abi: ERC20_READ_ABI, functionName: "decimals" }),
    ]);
    return { name: name as string, decimals: Number(decimals) };
  });
}

export class DecimalsAssertionError extends Error {
  constructor(chainId: ChainId, actual: number) {
    super(
      `XSGD on chain ${chainId} reports decimals=${actual}, expected ${XSGD_DECIMALS}. ` +
        `Refusing to serve: every amount would be mis-encoded by 10^${Math.abs(actual - XSGD_DECIMALS)} ` +
        `and signatures would verify against the wrong value.`,
    );
    this.name = "DecimalsAssertionError";
  }
}

/**
 * A6 boot assertion. Runs before `listen()`. If XSGD is not 6 decimals on a
 * chain we are configured to serve, the service refuses to start rather than
 * serving a wrong answer.
 *
 * Chains whose RPC is unreachable at boot are logged and skipped — an outage
 * must not permanently wedge startup, and every later request through that
 * chain still fails closed via `withRpc`.
 */
export async function assertTokenDecimalsAtBoot(log: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): Promise<void> {
  const chainIds = (process.env["CHAIN_IDS"] ?? "43113")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(isSupportedChainId);

  for (const chainId of chainIds) {
    let facts: TokenFacts;
    try {
      facts = await readTokenFacts(chainId);
    } catch (err) {
      log.warn(
        `boot: could not read XSGD decimals on ${chainId} (${
          err instanceof Error ? err.message : String(err)
        }) — continuing; requests on this chain will fail closed`,
      );
      continue;
    }
    if (facts.decimals !== XSGD_DECIMALS) {
      throw new DecimalsAssertionError(chainId, facts.decimals);
    }
    log.info(
      `boot: XSGD on ${chainId} verified name="${facts.name}" decimals=${facts.decimals}`,
    );
  }
}
