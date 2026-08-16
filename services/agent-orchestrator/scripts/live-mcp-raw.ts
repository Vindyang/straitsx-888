/**
 * Diagnostic-only: print the RAW, unfiltered get_card_sandbox tool result
 * text from the live sandbox so mcp-result-filter.ts can be corrected to
 * match reality rather than the docs' worked example. Never wire this into
 * anything that runs automatically — it deliberately bypasses the C3 filter.
 */

import { McpSseClient } from "../src/card-gateway/mcp-client";

const TEST_WALLET = "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7";

async function main() {
  const client = new McpSseClient();
  try {
    await client.initialize();
    const toolResult = await client.callTool("get_card_sandbox", {
      wallet_address: TEST_WALLET,
      cardholder_name: "Live MCP Raw Check",
      amount_sgd: 5,
    });
    console.log("RAW tool result (full JSON-RPC result object):");
    console.log(JSON.stringify(toolResult, null, 2));
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
