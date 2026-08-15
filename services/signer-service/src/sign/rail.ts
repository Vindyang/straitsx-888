/**
 * A14 — the signer hard-invariant rail. Seven refusals, none of them policy.
 *
 * The signer holds an immutable `mandateId → { settlementRecipient, hardMaxTotal }`
 * map loaded from env at boot, NEVER from the request. These refusals are fixed
 * invariants, not judgements — the signer stays "deliberately dumb" while
 * ceasing to be suicidal. They hold even if policy-service is fully compromised
 * (docs/execution_plan.md §12b 2.2).
 */

import {
  AppError,
  ErrorCode,
  MAX_AUTH_WINDOW_SECONDS,
  type Hex,
  type PinnedMandate,
} from "@straitsx/contracts";

/** Everything the rail needs from a parsed sign request, already normalised to
 *  lowercase for comparison (§0: addresses compared lowercased). */
export type RailInput = {
  mandateId: Hex;
  from: Hex;
  to: Hex;
  value: bigint;
  validAfter: number;
  validBefore: number;
  chainId: number;
};

export type RailConfig = {
  pinned: ReadonlyMap<string, PinnedMandate>;
  /** The configured paying wallet (EXPECTED_SIGNER_ADDRESS), lowercased. */
  signerAddress: Hex;
  /** The chain this signer is allowed to sign for. */
  chainId: number;
  /** Replay guard — requestIds already signed. Injected so the check is pure. */
  hasSeenRequestId: (requestId: string) => boolean;
};

export type RailResult =
  | { ok: true }
  | { ok: false; code: string; message: string; status: 403 | 409 };

/** Parse the pinned-mandate env JSON into a Map. Invalid JSON or shape throws at
 *  boot, before any signing path is reachable. */
export function parsePinnedMandates(
  raw: string | undefined,
): Map<string, PinnedMandate> {
  const pinned = new Map<string, PinnedMandate>();
  if (!raw) return pinned;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PINNED_MANDATES is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PINNED_MANDATES must be a JSON object");
  }

  for (const [mandateId, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const entry = value as Partial<PinnedMandate> | undefined;
    if (
      typeof entry?.settlementRecipient !== "string" ||
      typeof entry?.hardMaxTotal !== "string"
    ) {
      throw new Error(
        `PINNED_MANDATES entry "${mandateId}" is missing settlementRecipient or hardMaxTotal`,
      );
    }
    pinned.set(mandateId.toLowerCase(), {
      settlementRecipient: entry.settlementRecipient.toLowerCase() as Hex,
      hardMaxTotal: entry.hardMaxTotal,
    });
  }
  return pinned;
}

/** Compare two base-unit decimal strings as BigInt (never as JS numbers). */
function parseUintAsBigInt(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      `hardMaxTotal must be a base-unit decimal string, got "${value}"`,
    );
  }
  return BigInt(value);
}

/**
 * Run the seven refusals. Returns the first failure, or `{ ok: true }`. Order
 * matches the api-contracts.md §4 table and the ErrorCode declarations.
 */
export function checkRail(
  input: RailInput,
  requestId: string,
  config: RailConfig,
): RailResult {
  const entry = config.pinned.get(input.mandateId);
  if (!entry) {
    return {
      ok: false,
      code: ErrorCode.SIGNER_UNPINNED_MANDATE,
      message: "mandateId is not in the pinned map",
      status: 403,
    };
  }

  if (input.to !== entry.settlementRecipient) {
    return {
      ok: false,
      code: ErrorCode.SIGNER_WRONG_RECIPIENT,
      message: "message.to != pinned settlementRecipient",
      status: 403,
    };
  }

  const hardMax = parseUintAsBigInt(entry.hardMaxTotal);
  if (input.value > hardMax) {
    return {
      ok: false,
      code: ErrorCode.SIGNER_CEILING,
      message: "message.value exceeds pinned hardMaxTotal",
      status: 403,
    };
  }

  if (input.from !== config.signerAddress) {
    return {
      ok: false,
      code: ErrorCode.SIGNER_WRONG_FROM,
      message: "message.from != configured paying wallet",
      status: 403,
    };
  }

  if (input.chainId !== config.chainId) {
    return {
      ok: false,
      code: ErrorCode.SIGNER_WRONG_CHAIN,
      message: "domain.chainId != configured chain",
      status: 403,
    };
  }

  if (input.validBefore - input.validAfter > MAX_AUTH_WINDOW_SECONDS) {
    return {
      ok: false,
      code: ErrorCode.SIGNER_WINDOW,
      message: `validBefore - validAfter exceeds ${MAX_AUTH_WINDOW_SECONDS}s`,
      status: 403,
    };
  }

  if (config.hasSeenRequestId(requestId)) {
    return {
      ok: false,
      code: ErrorCode.SIGNER_REPLAY,
      message: "requestId already signed",
      status: 409,
    };
  }

  return { ok: true };
}

/** Throw the rail refusal as an AppError in the standard envelope. */
export function throwRailRefusal(
  result: Extract<RailResult, { ok: false }>,
): never {
  throw AppError.signerRefusal(
    result.code as Parameters<typeof AppError.signerRefusal>[0],
    result.message,
  );
}
