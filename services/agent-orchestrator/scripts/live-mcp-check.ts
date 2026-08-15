/**
 * C2/C3 live validation — NOT part of the vitest suite (needs network access
 * to the real StraitsX sandbox, so it would flake in CI). Exercises the real
 * getCard() path: SSE handshake, initialize, tools/call, 202-then-stream
 * correlation, and the C3 allowlist filter — against the live server, not a
 * fixture.
 *
 * `get_card_sandbox` only returns a challenge; no money moves until a signed
 * PAYMENT-SIGNATURE header is POSTed to cardapi, which this script never does.
 *
 * Run: pnpm --filter @straitsx/agent-orchestrator exec tsx scripts/live-mcp-check.ts
 */

import { getCard } from "../src/card-gateway/index";

const TEST_WALLET = "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7"; // api-contracts.md §0 payingWallet

async function main() {
  console.log("connecting to the live StraitsX MCP sandbox...");
  const started = Date.now();
  const result = await getCard({
    walletAddress: TEST_WALLET,
    cardholderName: "Live MCP Check",
    amountSgd: 5,
  });
  const elapsedMs = Date.now() - started;

  console.log(`round trip: ${elapsedMs}ms`);
  console.log("cardapiUrl:", result.cardapiUrl);
  console.log("challenge:", JSON.stringify(result.challenge, null, 2));
  console.log("rawToolResultHash:", result.rawToolResultHash);

  // Sanity-check the allowlist actually did its job on a LIVE result, not
  // just the reproduced fixture in the unit test.
  const serialised = JSON.stringify(result.challenge);
  if (serialised.includes("EXECUTE_NOW") || serialised.includes("instruction")) {
    throw new Error("FAIL: something from the raw MCP body leaked past the filter");
  }
  console.log("OK: no injection payload present in the returned challenge.");
}

main().catch((err) => {
  console.error("live-mcp-check FAILED:", err);
  process.exit(1);
});
