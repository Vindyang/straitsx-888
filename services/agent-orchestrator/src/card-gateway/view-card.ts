/**
 * C4 — call at the moment of checkout, never earlier: the returned URL is
 * one-time, and the blast radius is the seconds it stays alive. Never log,
 * persist or screenshot the iframe URL (docs/conventions.md "Never" list).
 */

import { AppError, ErrorCode } from "@straitsx/contracts";
import { McpSseClient } from "./mcp-client";
import type { ViewCardParams, ViewCardResult } from "./types";

type ViewCardToolResult = {
  iframe_url: string;
  expires_in_seconds?: number;
};

export async function viewCard(params: ViewCardParams): Promise<ViewCardResult> {
  const client = new McpSseClient();
  try {
    await client.initialize();
    const toolResult = await client.callTool("view_card_sandbox", {
      card_opaque_id: params.cardOpaqueId,
      settlement_tx: params.settlementTx,
      wallet_address: params.walletAddress,
    });
    const content = (toolResult as { content?: Array<{ type?: string; text?: string }> })?.content;
    const block = content?.find((c) => c.type === "text" && typeof c.text === "string");
    if (!block?.text) {
      throw new AppError(502, ErrorCode.MCP_RESULT_MALFORMED, "view_card_sandbox result has no text content block");
    }
    let parsed: ViewCardToolResult;
    try {
      parsed = JSON.parse(block.text) as ViewCardToolResult;
    } catch {
      throw new AppError(502, ErrorCode.MCP_RESULT_MALFORMED, "view_card_sandbox result text is not valid JSON");
    }
    return {
      iframeUrl: parsed.iframe_url,
      expiresInSeconds: parsed.expires_in_seconds ?? 60,
      singleUse: true,
    };
  } finally {
    client.close();
  }
}
