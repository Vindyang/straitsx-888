/**
 * A18 — read the MAINNET 402 and record what it says.
 *
 *   pnpm tsx scripts/probe-production-402.ts --url <production issue_card URL> --cleared
 *
 * Fetching a 402 is free and creates nothing (§19.3), so this spends no money
 * and issues no card. It NEVER sends a signature. It reads the challenge,
 * prints the three values that are still null in our constants, and tells you
 * exactly what to write down.
 *
 * TWO DELIBERATE OBSTACLES, both required:
 *
 * `--url` has NO DEFAULT. Deriving the production endpoint by substituting
 * "sandbox" -> "production" is precisely the defaulting that §0 forbids, and
 * `CARDAPI_PRODUCTION_ISSUE_CARD` is null in constants.ts for that reason. Get
 * the real URL from the organisers and pass it in.
 *
 * `--cleared` asserts you have confirmed with the organisers that teams may use
 * the production endpoint. §19.7 records this as an OPEN PERMISSION question,
 * not an engineering one. Hitting a sponsor's production API uninvited is a
 * people problem no script should let you have by accident.
 *
 * WHY THIS MATTERS: `version` is not readable on chain — `version()` reverts on
 * mainnet exactly as it does on Fuji — so the production 402 is the ONLY source
 * for the mainnet EIP-712 domain. Guessing it produces signatures that fail to
 * verify against real money.
 */

import { CHAINS, MAINNET } from "../packages/contracts/src/constants";
import { parseX402Challenge } from "../packages/contracts/src/x402";

function fail(message: string): never {
  console.error(`\nprobe-production-402: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const arg = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};

const url = arg("url");
if (!url) {
  fail(
    "--url is required and has no default.\n" +
      "  CARDAPI_PRODUCTION_ISSUE_CARD is null in constants.ts on purpose: substituting\n" +
      '  "production" for "sandbox" in the URL is a guess, and §0 says refuse, never default.\n' +
      "  Ask the organisers for the real endpoint.",
  );
}
if (!/^https:\/\//.test(url)) fail(`--url must be https, got ${url}`);

if (!has("cleared")) {
  fail(
    "--cleared is required.\n" +
      "  §19.7 records production access as an OPEN PERMISSION question. Confirm with the\n" +
      "  organisers that teams are cleared to use the production endpoint, then pass\n" +
      "  --cleared to assert you have done so.",
  );
}

const amountSgd = Number(arg("amount-sgd") ?? "5");
const cardholderName = arg("name") ?? "Production Probe";

console.log("\nA18 production 402 probe");
console.log(`  url: ${url}`);
console.log("  This reads a challenge only. No signature is sent and no card is issued.\n");

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ amount_sgd: amountSgd, cardholder_name: cardholderName }),
});

if (res.status !== 402) {
  fail(
    `expected 402 Payment Required, got ${res.status}.\n` +
      `  Body: ${(await res.text()).slice(0, 500)}\n` +
      `  A non-402 here usually means the URL is wrong or access is not actually cleared.`,
  );
}

const challenge = parseX402Challenge(await res.json());

console.log("Observed on the production challenge:");
const show = (k: string, v: unknown) => console.log(`  ${k.padEnd(20)} ${String(v)}`);
show("x402Version", challenge.x402Version);
show("network", challenge.network);
show("chainId", challenge.chainId);
show("asset", challenge.asset);
show("payTo", challenge.payTo);
show("amount", challenge.amount);
show("maxTimeoutSeconds", challenge.maxTimeoutSeconds);
show("extra.name", challenge.extra.name);
show("extra.version", challenge.extra.version);

// --- sanity checks against what we already believe -----------------------------

console.log("\nChecks:");
let warnings = 0;

if (challenge.chainId !== 43114) {
  console.log(
    `  ! chainId is ${challenge.chainId}, expected 43114. This is NOT the mainnet challenge —\n` +
      `    do not record these values as mainnet facts.`,
  );
  warnings++;
} else {
  console.log("  + chainId 43114 — this is the mainnet challenge");
}

if (challenge.asset.toLowerCase() !== MAINNET.xsgd.toLowerCase()) {
  console.log(
    `  ! asset ${challenge.asset} does not match the recorded mainnet XSGD\n` +
      `    ${MAINNET.xsgd}. One of the two is wrong; do not proceed until you know which.`,
  );
  warnings++;
} else {
  console.log("  + asset matches the recorded mainnet XSGD address");
}

if (challenge.extra.version === CHAINS[43113].eip712Version) {
  console.log(
    `  ! extra.version is "${challenge.extra.version}", the SAME as Fuji.\n` +
      `    That may be genuine, but it is also exactly what an inherited default looks like.\n` +
      `    You are recording it because the production 402 said so, NOT because Fuji did.`,
  );
  warnings++;
} else {
  console.log(`  + extra.version "${challenge.extra.version}" differs from Fuji`);
}

// --- what to record -------------------------------------------------------------

console.log("\nRecord these. Paste into docs/execution_plan.md §19.7:");
console.log("");
console.log("  ### 19.7 Production 402 (resolved <today>)");
console.log("");
console.log("  | Field | Value |");
console.log("  | --- | --- |");
console.log(`  | chainId | ${challenge.chainId} |`);
console.log(`  | network | ${challenge.network} |`);
console.log(`  | asset | ${challenge.asset} |`);
console.log(`  | payTo | ${challenge.payTo} |`);
console.log(`  | extra.name | ${challenge.extra.name} |`);
console.log(`  | extra.version | ${challenge.extra.version} |`);
console.log("");
console.log("Then update packages/contracts/src/constants.ts MAINNET:");
console.log("");
console.log(`  settlementRecipient: "${challenge.payTo}",`);
console.log(`  eip712Version: "${challenge.extra.version}",`);
console.log("");
console.log(
  "Both are null today, and every mainnet path refuses while they are null.\n" +
    "That refusal is the safety property — only replace them with what you just read.",
);

if (warnings > 0) {
  console.log(`\n  ${warnings} check(s) flagged above. Read them before recording anything.\n`);
  process.exit(1);
}
console.log("");
