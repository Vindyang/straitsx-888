/**
 * A11 custody move — build the UNSIGNED XSGD transfer from the funding wallet
 * to the KMS-derived signing address.
 *
 *   pnpm tsx scripts/move-xsgd.ts --chain 43113 --to 0xYourDerivedAddress
 *
 * THIS SCRIPT NEVER SIGNS AND NEVER BROADCASTS. It takes no private key and
 * has nowhere to put one. It prints an unsigned transaction that you paste
 * into your own wallet app, which is the same rule chain-gateway follows for
 * revokes (docs/api-contracts.md §3: "Unsigned. chain-gateway never signs — the
 * human signs in their wallet from the dashboard").
 *
 * That is not ceremony. The funding wallet's key lives in a wallet app, and the
 * entire claim of this project is that a raw private key never enters the repo,
 * an env file, or an agent's context. A script that accepted one to save you a
 * copy-paste would undo the thing the KMS key exists to prove.
 *
 * FUJI FIRST. Run 43113, watch it settle, and only then consider 43114. The
 * same address holds 30 XSGD on both chains (execution_plan.md §19.5), so a
 * mistake made once is a mistake you are about to make twice.
 */

// Imported from the specific modules rather than the barrel: index.ts re-exports
// http.ts, which pulls in fastify. A CLI has no business loading a web framework.
import {
  CHAINS,
  FUNDING_ORIGIN_WALLET,
  XSGD_DECIMALS,
  isSupportedChainId,
} from "../packages/contracts/src/constants";
import { parseAddress, toChecksum } from "../packages/contracts/src/validation";

function fail(message: string): never {
  console.error(`move-xsgd: ${message}`);
  process.exit(1);
}

// --- arguments ----------------------------------------------------------------

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

const rawChain = arg("chain") ?? "43113";
const chainId = Number(rawChain);
if (!isSupportedChainId(chainId)) {
  fail(`--chain must be 43113 (Fuji) or 43114 (mainnet), got ${rawChain}`);
}

const rawTo = arg("to");
if (!rawTo) {
  fail(
    "--to <address> is required — the KMS-derived address from scripts/setup-kms.sh " +
      "(it is also EXPECTED_SIGNER_ADDRESS in .env)",
  );
}

let to: string;
try {
  to = parseAddress(rawTo, "--to");
} catch {
  fail(`--to is not a valid address: ${rawTo}`);
}

// 30 XSGD at 6 decimals. Base-unit decimal string, never a JSON number (§0).
const rawAmount = arg("amount") ?? "30000000";
if (!/^[0-9]+$/.test(rawAmount)) {
  fail(`--amount must be a base-unit decimal string, got ${rawAmount}`);
}
const amount = BigInt(rawAmount);
if (amount === 0n) fail("--amount must be greater than zero");

// The whole point of the move is to fund a DIFFERENT address. Sending to the
// origin is a no-op that costs gas and looks, in a block explorer, exactly like
// a successful custody move.
if (to.toLowerCase() === FUNDING_ORIGIN_WALLET.toLowerCase()) {
  fail(
    "--to is the funding wallet itself — that moves nothing. Pass the " +
      "KMS-derived address (EXPECTED_SIGNER_ADDRESS), not the origin.",
  );
}

// --- calldata -----------------------------------------------------------------

/**
 * `transfer(address,uint256)` — selector 0xa9059cbb, then two 32-byte static
 * words. Hand-encoded rather than pulled from the shared ABI on purpose:
 * packages/contracts/src/abi.ts is deliberately scoped to "only what
 * chain-gateway is allowed to call", and chain-gateway must never be able to
 * move tokens. Adding `transfer` there to save four lines here would hand that
 * capability to the one service whose whole contract is that it cannot sign.
 */
const TRANSFER_SELECTOR = "a9059cbb";

function pad32(hexNoPrefix: string): string {
  if (hexNoPrefix.length > 64) throw new Error("value too wide for a 32-byte word");
  return hexNoPrefix.padStart(64, "0");
}

const data =
  `0x${TRANSFER_SELECTOR}` +
  pad32(to.toLowerCase().replace(/^0x/, "")) +
  pad32(amount.toString(16));

const chain = CHAINS[chainId];
const xsgd = toChecksum(chain.xsgd);

// --- preflight: can the source wallet actually cover this? ----------------------

/**
 * Read `balanceOf(FUNDING_ORIGIN_WALLET)` before building anything.
 *
 * Without this the script happily emits a transaction the wallet cannot cover:
 * the ERC-20 transfer reverts on chain, gas is spent, and the failure reads as
 * a wallet or network problem rather than "there is nothing to move". That is
 * exactly what happened once the custody move had already been completed and
 * the script was re-run out of habit.
 *
 * A direct read is used rather than chain-gateway because this is a standalone
 * CLI that must work whether or not any service is running.
 */
const rpcUrl = process.env[`RPC_URL_${chainId}`] ?? chain.rpc;
const balanceHex = await fetch(rpcUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      {
        to: chain.xsgd,
        data: `0x70a08231${FUNDING_ORIGIN_WALLET.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`,
      },
      "latest",
    ],
  }),
})
  .then((r) => r.json() as Promise<{ result?: string; error?: unknown }>)
  .catch(() => ({ result: undefined, error: "rpc unreachable" }));

if (typeof balanceHex.result !== "string") {
  console.error(
    `move-xsgd: WARNING could not read the source balance (${JSON.stringify(balanceHex.error)}).\n` +
      `  Proceeding, but verify in your wallet that the balance covers the transfer.\n`,
  );
} else {
  const balance = BigInt(balanceHex.result);
  const fmt = (v: bigint) =>
    `${v / 10n ** BigInt(XSGD_DECIMALS)}.${(v % 10n ** BigInt(XSGD_DECIMALS)).toString().padStart(XSGD_DECIMALS, "0")}`;

  if (balance < amount) {
    fail(
      `the funding wallet cannot cover this transfer.\n\n` +
        `    have  ${fmt(balance)} XSGD  at ${toChecksum(FUNDING_ORIGIN_WALLET)}\n` +
        `    want  ${fmt(amount)} XSGD\n\n` +
        `  Signing this would revert on chain and waste gas.\n\n` +
        `  If the custody move is already done, this step is COMPLETE and there is nothing\n` +
        `  to do — check the signer address instead. Re-run this only after new funds\n` +
        `  arrive at the funding wallet, with --amount set to what actually arrived.`,
    );
  }
}

// An ERC-20 transfer into a non-zero balance is ~35k; 100k is generous and
// bounded, and your wallet will re-estimate anyway.
const GAS_LIMIT = "100000";

// --- output -------------------------------------------------------------------

const whole = amount / 10n ** BigInt(XSGD_DECIMALS);
const fraction = (amount % 10n ** BigInt(XSGD_DECIMALS))
  .toString()
  .padStart(XSGD_DECIMALS, "0");

console.log("");
console.log(`  A11 custody move — chain ${chainId} (${chainId === 43113 ? "Fuji" : "MAINNET"})`);
console.log("");
console.log(`  send      ${whole}.${fraction} XSGD`);
console.log(`  from      ${toChecksum(FUNDING_ORIGIN_WALLET)}   (your wallet app)`);
console.log(`  to        ${toChecksum(to)}   (KMS-derived signer)`);
console.log(`  token     ${xsgd}`);
console.log("");
console.log("  Unsigned transaction — paste into your wallet:");
console.log("");
console.log(JSON.stringify({ to: xsgd, data, value: "0", chainId, gasLimit: GAS_LIMIT }, null, 2));
console.log("");

if (chainId === 43114) {
  console.log("  !! MAINNET — this moves real money. Confirm the Fuji leg settled first.");
  console.log("");
}

console.log("  Before you sign, check in your wallet that it decodes as:");
console.log(`    Transfer ${whole}.${fraction} XSGD  ->  ${toChecksum(to)}`);
console.log("  If your wallet shows a different recipient or amount, STOP.");
console.log("");
console.log("  After it settles, confirm the signer sees the balance:");
console.log(`    curl "http://localhost:4004/balance?address=${toChecksum(to)}&chainId=${chainId}" \\`);
console.log(`      -H "x-internal-token: $INTERNAL_TOKEN"`);
console.log("");
