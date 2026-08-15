/**
 * The §0 conventions, implemented ONCE.
 *
 * These were previously inlined per route — the address regex in three files,
 * the bytes32 regex in two, the money regex in two — and had already drifted:
 * `mandateId` was lowercased per §0 "hex lowercase", `txHash` was not. §0 is a
 * shared convention, so it gets a shared implementation. Nobody reimplements it.
 *
 * Every validator throws `AppError` (400), so a failure lands in the standard
 * error envelope rather than escaping as a 500.
 */

import { getAddress } from "viem";
import { AppError, ErrorCode, type ErrorCodeValue } from "./errors";
import { isSupportedChainId } from "./constants";
import type { ChainId } from "./types";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^[0-9]+$/;

/** `0x` + 40 hex, normalised to lowercase for comparison (§0: compare lowercased). */
export function parseAddress(raw: unknown, field = "address"): `0x${string}` {
  if (typeof raw !== "string" || !ADDRESS_RE.test(raw)) {
    throw AppError.badRequest(
      `${field} must be a 0x-prefixed 20-byte hex address, got "${String(raw)}"`,
    );
  }
  return raw.toLowerCase() as `0x${string}`;
}

/** EIP-55 checksummed, for JSON responses (§0: checksummed in JSON). */
export function toChecksum(raw: string): `0x${string}` {
  return getAddress(raw as `0x${string}`);
}

/** bytes32: `0x` + 64 hex, lowercased (§0: hex 0x-prefixed lowercase). */
export function parseBytes32(raw: unknown, field = "value"): `0x${string}` {
  if (typeof raw !== "string" || !BYTES32_RE.test(raw)) {
    throw AppError.badRequest(
      `${field} must be 0x-prefixed 32-byte hex, got "${String(raw)}"`,
    );
  }
  return raw.toLowerCase() as `0x${string}`;
}

export const parseMandateId = (raw: unknown) => parseBytes32(raw, "mandateId");
export const parseTxHash = (raw: unknown) => parseBytes32(raw, "txHash");

/**
 * Base-unit decimal string. Rejects JSON numbers outright: §0 says money is
 * "never a JSON number — 2^53 and float rounding both bite".
 */
export function parseUint(raw: unknown, field = "amount"): string {
  if (typeof raw !== "string" || !UINT_RE.test(raw)) {
    throw AppError.badRequest(
      `${field} must be a base-unit decimal string (e.g. "5000000"), got ${typeof raw}`,
    );
  }
  return raw;
}

export function parseChainId(raw: unknown): ChainId {
  if (raw === undefined || raw === null || raw === "") {
    throw AppError.badRequest("chainId is required");
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

export function requireObject(
  body: unknown,
  what = "body",
): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw AppError.badRequest(`${what} must be a JSON object`);
  }
  return body as Record<string, unknown>;
}

/**
 * A value the spec leaves null until a fact is fetched — mainnet's
 * `settlementRecipient` and `eip712Version`, a registry address before deploy.
 *
 * §0: "Any code path that reads a null here must refuse, never default."
 */
export function refuseIfNull<T>(
  value: T | null | undefined,
  code: ErrorCodeValue,
  message: string,
): T {
  if (value === null || value === undefined) {
    throw AppError.badRequest(message, code);
  }
  return value;
}

/** ISO-8601 UTC to whole seconds, matching the §3 samples ("2026-08-15T05:46:23Z"). */
export function isoSeconds(ms: number = Date.now()): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}
