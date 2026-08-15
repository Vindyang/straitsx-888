/**
 * A4 — publish the deployed registry to `packages/contracts/registry.json`.
 *
 * Reads the ABI from the forge build output and the address + deploy block from
 * the broadcast record, so the published artefact is always GENERATED, never
 * hand-maintained. Owner B (check 1) and Owner C (dashboard) both read this
 * file; a hand-edited ABI that drifts from the deployed bytecode surfaces as an
 * RPC decode error hours later.
 *
 *   pnpm tsx scripts/sync-registry.ts 43113
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAddress } from "../packages/contracts/src/validation";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOL_ROOT = resolve(ROOT, "packages/contracts-sol");
const REGISTRY_JSON = resolve(ROOT, "packages/contracts/registry.json");
const ARTIFACT = resolve(SOL_ROOT, "out/MandateRegistry.sol/MandateRegistry.json");

const SUPPORTED = new Set(["43113", "43114"]);

function fail(message: string): never {
  console.error(`sync-registry: ${message}`);
  process.exit(1);
}

const chainId = process.argv[2];
if (!chainId || !SUPPORTED.has(chainId)) {
  fail(`usage: pnpm tsx scripts/sync-registry.ts <43113|43114>`);
}

// --- ABI, from the compiled artefact -----------------------------------------

let artifact: { abi: unknown[] };
try {
  artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: unknown[] };
} catch {
  fail(`no build artefact at ${ARTIFACT} — run \`forge build\` first`);
}
if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
  fail("build artefact has an empty abi");
}

// --- address + deploy block, from the broadcast record ------------------------

type BroadcastTx = {
  transactionType?: string;
  contractName?: string;
  contractAddress?: string;
};
type BroadcastReceipt = { blockNumber?: string };
type Broadcast = { transactions?: BroadcastTx[]; receipts?: BroadcastReceipt[] };

const broadcastPath = resolve(
  SOL_ROOT,
  `broadcast/Deploy.s.sol/${chainId}/run-latest.json`,
);

let broadcast: Broadcast;
try {
  broadcast = JSON.parse(readFileSync(broadcastPath, "utf8")) as Broadcast;
} catch {
  fail(
    `no broadcast record at ${broadcastPath} — ` +
      `deploy first with \`forge script script/Deploy.s.sol:Deploy --rpc-url <rpc> --account <keystore> --broadcast\``,
  );
}

const createIndex = (broadcast.transactions ?? []).findIndex(
  (t) => t.transactionType === "CREATE" && t.contractName === "MandateRegistry",
);
if (createIndex === -1) {
  fail("broadcast record contains no MandateRegistry CREATE transaction");
}

// Shared validator, not a fourth copy of the address regex. This is a CLI, so
// the AppError is translated into a clean exit rather than surfaced as HTTP.
let address: string;
try {
  address = parseAddress(
    broadcast.transactions?.[createIndex]?.contractAddress,
    "contractAddress",
  );
} catch {
  fail(
    `broadcast record has no valid contractAddress ` +
      `(got ${String(broadcast.transactions?.[createIndex]?.contractAddress)})`,
  );
}

const rawBlock = broadcast.receipts?.[createIndex]?.blockNumber;
if (rawBlock === undefined) {
  fail("broadcast record has no receipt blockNumber");
}
const deployBlock = Number(BigInt(rawBlock));
if (!Number.isSafeInteger(deployBlock) || deployBlock <= 0) {
  fail(`broadcast record has an implausible blockNumber: ${rawBlock}`);
}

// --- merge, preserving the other chain --------------------------------------

type RegistryFile = {
  _comment?: string;
  addresses: Record<string, string | null>;
  deployBlock: Record<string, number | null>;
  abi: unknown[];
};

const current = JSON.parse(readFileSync(REGISTRY_JSON, "utf8")) as RegistryFile;

const previous = current.addresses[chainId];
if (previous && previous.toLowerCase() !== address.toLowerCase()) {
  console.warn(
    `sync-registry: WARNING chain ${chainId} was ${previous}, now ${address}. ` +
      `Every mandate created against the old address becomes unreadable. ` +
      `Announce this to Owner B and Owner C.`,
  );
}

const next: RegistryFile = {
  ...current,
  addresses: { ...current.addresses, [chainId]: address },
  deployBlock: { ...current.deployBlock, [chainId]: deployBlock },
  abi: artifact.abi,
};

writeFileSync(REGISTRY_JSON, `${JSON.stringify(next, null, 2)}\n`, "utf8");

console.log(`sync-registry: chain ${chainId} -> ${address} @ block ${deployBlock}`);
console.log(`sync-registry: wrote ${REGISTRY_JSON}`);
console.log("");
console.log("Announce to the team channel:");
console.log(`  mandate-registry ${chainId}: ${address} (deployBlock ${deployBlock})`);
