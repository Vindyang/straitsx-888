/**
 * C2/C4 — request a card challenge. Two distinct steps, verified live against
 * the real sandbox (2026-08-15):
 *
 *  1. MCP `get_card_sandbox` returns only a `cardapiUrl` (plus an injection
 *     payload this module never touches beyond mcp-result-filter.ts) — it
 *     does NOT hand back payment terms. See mcp-result-filter.ts for the
 *     verified live shape and why the docs' original worked example was
 *     wrong about this.
 *  2. The actual x402 challenge comes from an ordinary HTTP exchange: POST to
 *     `cardapiUrl` with no signature, get a 402 back, and parse its body with
 *     `parseX402Challenge` — already an allowlist parser in
 *     packages/contracts/src/x402.ts, reused here rather than duplicated.
 *
 * Validates inputs before calling (execution_plan.md's exactly-two-tools
 * table: name 2-26 chars, amount 5-30 SGD).
 */

import { keccak256, toBytes } from "viem";
import { AppError, ErrorCode, parseX402Challenge, type X402Requirements } from "@straitsx/contracts";
import { McpSseClient } from "./mcp-client";
import { filterMcpCardResult } from "./mcp-result-filter";
import type { GetCardParams, GetCardResult } from "./types";

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 26;
const AMOUNT_MIN_SGD = 5;
const AMOUNT_MAX_SGD = 30;

function validateParams(params: GetCardParams): void {
  const { cardholderName, amountSgd } = params;
  if (cardholderName.length < NAME_MIN_LENGTH || cardholderName.length > NAME_MAX_LENGTH) {
    throw AppError.badRequest(
      `cardholderName must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters, got ${cardholderName.length}`,
    );
  }
  if (amountSgd < AMOUNT_MIN_SGD || amountSgd > AMOUNT_MAX_SGD) {
    throw AppError.badRequest(`amountSgd must be ${AMOUNT_MIN_SGD}-${AMOUNT_MAX_SGD}, got ${amountSgd}`);
  }
}

/** The sandbox returns one text content block whose body is the JSON payload
 *  (execution_plan.md §5). */
function extractToolResultText(toolResult: unknown): string {
  const content = (toolResult as { content?: Array<{ type?: string; text?: string }> })?.content;
  const block = content?.find((c) => c.type === "text" && typeof c.text === "string");
  if (!block?.text) {
    throw new AppError(502, ErrorCode.MCP_RESULT_MALFORMED, "mcp tool result has no text content block");
  }
  return block.text;
}

export async function getCard(params: GetCardParams): Promise<GetCardResult> {
  validateParams(params);

  const client = new McpSseClient();
  let cardapiUrl: string;
  let rawToolResultHash: `0x${string}`;
  try {
    await client.initialize();
    const toolResult = await client.callTool("get_card_sandbox", {
      wallet_address: params.walletAddress,
      cardholder_name: params.cardholderName,
      amount_sgd: params.amountSgd,
    });
    const rawText = extractToolResultText(toolResult);
    // Kept for the receipt. The raw text itself is discarded the instant
    // filterMcpCardResult() below has extracted the allowlisted field.
    rawToolResultHash = keccak256(toBytes(rawText));

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new AppError(502, ErrorCode.MCP_RESULT_MALFORMED, "mcp tool result text is not valid JSON");
    }

    // C3 — the ONLY point the raw, untrusted MCP body is touched. The
    // injection payload (if any) never reaches this line's return value or
    // anything downstream of it.
    cardapiUrl = filterMcpCardResult(parsed).cardapiUrl;
  } finally {
    client.close();
  }

  // The real challenge comes from an ordinary, ourselves-initiated HTTP 402 —
  // a ground-truth exchange with StraitsX's own server, not MCP-mediated, and
  // parsed by the existing allowlist parser (never re-derived from the MCP body).
  const primingRes = await fetch(cardapiUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cardholder_name: params.cardholderName, amount_sgd: params.amountSgd }),
  });
  if (primingRes.status !== 402) {
    throw new AppError(
      502,
      ErrorCode.CARDAPI_FAILED,
      `expected 402 from cardapi priming request, got ${primingRes.status}`,
    );
  }
  const challenge: X402Requirements = parseX402Challenge(await primingRes.json());

  return { cardapiUrl, challenge, rawToolResultHash };
}
