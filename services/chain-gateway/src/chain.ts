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
  envNumber,
  isSupportedChainId,
  type ChainId,
} from "@straitsx/contracts";

// envNumber throws on a non-numeric value. `Number(process.env[...] ?? 10_000)`
// silently yielded NaN, which viem treats as "no timeout" — a misconfigured
// env var would have removed the timeout rather than failing loudly.
const RPC_TIMEOUT_MS = envNumber("RPC_TIMEOUT_MS", 10_000);

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

/**
 * A6: "Assert `decimals === 6` at boot; refuse to serve if not."
 *
 * Extends AppError (500, NOT retryable) so the same assertion serves both the
 * boot check and the per-cold-read re-check in routes/token-constants.ts. It
 * was previously two types with near-identical messages, and the read path
 * mis-reported it as `RPC_FAILED` with `retryable: true` — retrying a wrong
 * `decimals` never fixes it, and a retryable flag invites Owner B to loop.
 */
export class DecimalsAssertionError extends AppError {
  constructor(chainId: ChainId, actual: number) {
    super(
      500,
      ErrorCode.TOKEN_DECIMALS_INVALID,
      `XSGD on chain ${chainId} reports decimals=${actual}, expected ${XSGD_DECIMALS}. ` +
        `Refusing to serve: every amount would be mis-encoded by 10^${Math.abs(actual - XSGD_DECIMALS)} ` +
        `and signatures would verify against the wrong value.`,
      false,
    );
    this.name = "DecimalsAssertionError";
  }
}

/** The one place the invariant is enforced. Callers pass what they read. */
export function assertDecimals(chainId: ChainId, actual: number): void {
  if (actual !== XSGD_DECIMALS) throw new DecimalsAssertionError(chainId, actual);
}

export function configuredChainIds(): ChainId[] {
  return (process.env["CHAIN_IDS"] ?? "43113")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(isSupportedChainId);
}

/**
 * A6 boot assertion. Runs before `listen()` and REFUSES TO START on failure.
 *
 * An earlier version logged a warning and continued when the RPC read failed,
 * which meant the assertion could be skipped entirely by a network blip — the
 * service would then serve `/token/constants` from a chain it had never
 * verified. A6 says refuse, so it refuses.
 *
 * The read is retried first, because a single transient failure is not evidence
 * that the token is wrong. Only a persistent failure — or a real mismatch —
 * stops the boot.
 */
export async function assertTokenDecimalsAtBoot(
  log: { info: (msg: string) => void; warn: (msg: string) => void },
  attempts = 3,
): Promise<void> {
  for (const chainId of configuredChainIds()) {
    let facts: TokenFacts | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        facts = await readTokenFacts(chainId);
        break;
      } catch (err) {
        lastError = err;
        log.warn(
          `boot: XSGD read on ${chainId} failed (attempt ${attempt}/${attempts}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!facts) {
      throw new Error(
        `boot: could not verify XSGD decimals on chain ${chainId} after ${attempts} attempts — ` +
          `refusing to start rather than serving an unverified chain. ` +
          `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }

    assertDecimals(chainId, facts.decimals);
    log.info(
      `boot: XSGD on ${chainId} verified name="${facts.name}" decimals=${facts.decimals}`,
    );
  }
}
