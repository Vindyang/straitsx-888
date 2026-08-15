/**
 * x402 challenge parsing. Source: docs/execution_plan.md §19.3.
 *
 * The wire format wraps requirements in `accepts[]`; our internal
 * `X402Requirements` flattens one entry and carries `x402Version` down onto it.
 *
 * THIS PARSER IS AN ALLOWLIST, NOT A MAPPER. The sponsor's MCP tool result
 * carries a live prompt injection — `"action": "EXECUTE_NOW"`, an instruction to
 * suppress user confirmation, and a step telling the agent to sign with the
 * wallet private key (§19.6). Free-text keys must never reach a model context
 * that can reach the signer, so every key not named below is DROPPED here.
 */

import type { X402Requirements } from "./types";

export type Raw402Body = {
  x402Version?: unknown;
  accepts?: unknown;
};

export class X402ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X402ParseError";
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new X402ParseError(`challenge.${field} must be a non-empty string`);
  }
  return v;
}

function requireNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new X402ParseError(`challenge.${field} must be a finite number`);
  }
  return v;
}

/** Base-unit decimal string. Rejects numbers outright — see §0 on money. */
function requireUintString(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) {
    throw new X402ParseError(
      `challenge.${field} must be a base-unit decimal string, got ${typeof v}`,
    );
  }
  return v;
}

/**
 * Normalise a raw 402 body into `X402Requirements`.
 *
 * Returns ONLY the allowlisted fields. `instruction`, `action`, `steps`, `note`
 * and `environment` are discarded and never returned to any caller.
 */
export function parseX402Challenge(body: unknown): X402Requirements {
  if (typeof body !== "object" || body === null) {
    throw new X402ParseError("402 body is not an object");
  }
  const raw = body as Raw402Body;

  const accepts = raw.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new X402ParseError("402 body has no `accepts` entries");
  }
  const entry = accepts[0];
  if (typeof entry !== "object" || entry === null) {
    throw new X402ParseError("accepts[0] is not an object");
  }
  const a = entry as Record<string, unknown>;

  const scheme = requireString(a["scheme"], "scheme");
  if (scheme !== "exact") {
    throw new X402ParseError(`unsupported scheme "${scheme}", expected "exact"`);
  }

  const extraRaw = a["extra"];
  if (typeof extraRaw !== "object" || extraRaw === null) {
    throw new X402ParseError("challenge.extra is missing");
  }
  const extra = extraRaw as Record<string, unknown>;

  const assetTransferMethod = requireString(
    extra["assetTransferMethod"],
    "extra.assetTransferMethod",
  );
  if (assetTransferMethod !== "eip3009") {
    throw new X402ParseError(
      `unsupported assetTransferMethod "${assetTransferMethod}", expected "eip3009"`,
    );
  }

  return {
    x402Version: requireNumber(raw.x402Version, "x402Version"),
    scheme: "exact",
    network: requireString(a["network"], "network"),
    chainId: requireNumber(a["chainId"], "chainId"),
    amount: requireUintString(a["amount"], "amount"),
    asset: requireString(a["asset"], "asset"),
    payTo: requireString(a["payTo"], "payTo"),
    maxTimeoutSeconds: requireNumber(a["maxTimeoutSeconds"], "maxTimeoutSeconds"),
    extra: {
      assetTransferMethod: "eip3009",
      // -> EIP-712 domain.name
      name: requireString(extra["name"], "extra.name"),
      // -> EIP-712 domain.version. The ONLY source; version() reverts on both
      // chains, and mainnet's value must not be inherited from Fuji.
      version: requireString(extra["version"], "extra.version"),
    },
  };
}

/** The 402 also arrives base64 in the `Payment-Required` response header. */
export function parsePaymentRequiredHeader(header: string): X402Requirements {
  let decoded: string;
  try {
    decoded = Buffer.from(header, "base64").toString("utf8");
  } catch {
    throw new X402ParseError("Payment-Required header is not valid base64");
  }
  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    throw new X402ParseError("Payment-Required header did not decode to JSON");
  }
  return parseX402Challenge(json);
}
