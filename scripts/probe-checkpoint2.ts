/**
 * A16 — CHECKPOINT 2: the first real signature.
 *
 *   pnpm tsx scripts/probe-checkpoint2.ts              # challenge only, FREE
 *   pnpm tsx scripts/probe-checkpoint2.ts --settle     # signs and SPENDS
 *
 * Two modes, and the default is the safe one.
 *
 * WITHOUT --settle it fetches the live 402 and stops. Per execution_plan §19.3 a
 * 402 creates nothing and spends nothing, so this is free to run as often as you
 * like. It still proves the valuable things: that the challenge parses, that its
 * domain matches our configured constants, and exactly what would be signed.
 *
 * WITH --settle it signs via the real KMS key and retries the request, which
 * issues a card and moves 5 XSGD on Fuji. That is irreversible.
 *
 * WHAT THIS IS ACTUALLY TESTING. Everything else has been proven offline against
 * a local key. The one thing no offline test can answer is whether the sponsor's
 * facilitator ACCEPTS our PAYMENT-SIGNATURE header. That header was carrying the
 * EIP-712 typed data and no signature at all until it was fixed against the x402
 * exact/EVM spec; this probe is what confirms the corrected shape end to end.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAINS,
  X402_VERSION,
  isSupportedChainId,
} from "../packages/contracts/src/constants";
import { parseX402Challenge } from "../packages/contracts/src/x402";
import { buildCommitmentNonce } from "../packages/contracts/src/mandate";
import { buildKmsKeySource } from "../services/signer-service/src/keys/kms-key-source";
import { deriveAddressFromSpki } from "../services/signer-service/src/keys/derive-address";
import {
  assertDomainMatches,
  buildTransferWithAuthorizationTypedData,
  digestTypedData,
} from "../services/signer-service/src/sign/typed-data";
import { signDigestWithKeySource } from "../services/signer-service/src/sign/pipeline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  console.error(`\nprobe-checkpoint2: ${message}\n`);
  process.exit(1);
}

// --- env ----------------------------------------------------------------------

/** Minimal .env reader — the repo has no dotenv dependency and a probe should
 *  not add one. Only KEY=value lines, no interpolation, no export prefixes. */
function readEnvFile(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(resolve(ROOT, ".env"), "utf8");
  } catch {
    fail("no .env found — run scripts/setup-kms.sh first");
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...readEnvFile(), ...process.env } as Record<string, string>;

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(`--${flag}`);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const SETTLE = has("settle");
const chainId = Number(arg("chain") ?? "43113");
if (!isSupportedChainId(chainId)) fail(`unsupported --chain ${chainId}`);

const amountSgd = Number(arg("amount-sgd") ?? "5");
const cardholderName = arg("name") ?? "Checkpoint Two Probe";

const CARDAPI = "https://card.straitsx.ai/sandbox/cardapi/issue_card";
const chain = CHAINS[chainId];
const rpc = env["RPC_URL_43113"] ?? chain.rpc;

// --- helpers ------------------------------------------------------------------

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(20)} ${String(value)}`);
}

// --- 1. the live challenge (free, creates nothing) ------------------------------

console.log("\nA16 checkpoint 2 — first real signature");
console.log(`  mode: ${SETTLE ? "SETTLE (spends real XSGD)" : "challenge only (free)"}\n`);

console.log("1. Fetching the live 402 challenge");
const challengeRes = await fetch(CARDAPI, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ amount_sgd: amountSgd, cardholder_name: cardholderName }),
});

if (challengeRes.status !== 402) {
  fail(
    `expected 402 Payment Required, got ${challengeRes.status}. ` +
      `Body: ${(await challengeRes.text()).slice(0, 400)}`,
  );
}

const rawChallenge: unknown = await challengeRes.json();
const challenge = parseX402Challenge(rawChallenge);

line("x402Version", challenge.x402Version);
line("network", challenge.network);
line("chainId", challenge.chainId);
line("asset", challenge.asset);
line("payTo", challenge.payTo);
line("amount", `${challenge.amount} base units`);
line("maxTimeoutSeconds", challenge.maxTimeoutSeconds);
line("extra.name", challenge.extra.name);
line("extra.version", challenge.extra.version);

// --- 2. the load-bearing domain assertion (§19.4) -------------------------------

console.log("\n2. Asserting the challenge matches our configured constants");
const domain = {
  name: challenge.extra.name,
  version: challenge.extra.version,
  chainId: challenge.chainId,
  verifyingContract: challenge.asset,
};
try {
  assertDomainMatches(domain, {
    chainId,
    asset: chain.xsgd.toLowerCase(),
    name: chain.eip712Name,
    version: chain.eip712Version ?? "",
  });
  console.log("  + domain matches — safe to sign against this challenge");
} catch (err) {
  fail(
    `DOMAIN MISMATCH, refusing to sign: ${err instanceof Error ? err.message : String(err)}\n` +
      `  This is either a chain misconfiguration or the challenge changed. ` +
      `Do not "fix" it by relaxing the assertion.`,
  );
}

// --- 3. what would be signed ----------------------------------------------------

const expectedSigner = env["EXPECTED_SIGNER_ADDRESS"];
if (!expectedSigner) fail("EXPECTED_SIGNER_ADDRESS is not set in .env");

const requestId = `probe-${Date.now()}`;
// A17 commitment nonce. A probe has no real mandate or intent, so these two
// hashes are LABELLED PROBE VALUES, not fabricated mandate data — the point is
// to exercise the same code path policy-service will use, not to fake a mandate.
const nonce = buildCommitmentNonce({
  requestId,
  policyHash: `0x${"00".repeat(31)}01`,
  intentHash: `0x${"00".repeat(31)}02`,
  merchantDomain: new URL(CARDAPI).hostname,
});

const now = Math.floor(Date.now() / 1000);
const validAfter = now - 60; // clock skew tolerance
// The signer refuses a window wider than 600s (SIGNER_WINDOW). Respect the
// challenge's own timeout when it is tighter.
const window = Math.min(challenge.maxTimeoutSeconds ?? 300, 540);
const validBefore = validAfter + window;

const typedDataInput = {
  from: expectedSigner,
  to: challenge.payTo,
  value: challenge.amount,
  validAfter,
  validBefore,
  nonce,
  domain,
};

console.log("\n3. The authorization that would be signed");
line("from", expectedSigner);
line("to", challenge.payTo);
line("value", `${challenge.amount} (${Number(challenge.amount) / 1e6} XSGD)`);
line("validAfter", validAfter);
line("validBefore", `${validBefore}  (window ${window}s, limit 600)`);
line("nonce", nonce);

if (!SETTLE) {
  console.log("\n  Stopping here. Nothing was created and nothing was spent.");
  console.log("  Re-run with --settle to sign via KMS and issue a real card.\n");
  process.exit(0);
}

// --- 4. sign via the real KMS key ------------------------------------------------

const kmsKeyId = env["KMS_KEY_ID"];
if (!kmsKeyId) fail("KMS_KEY_ID is not set in .env — run scripts/setup-kms.sh");

console.log("\n4. Signing via KMS");
const keySource = buildKmsKeySource({
  keyId: kmsKeyId,
  region: env["AWS_REGION"] ?? "ap-southeast-1",
});

const derived = deriveAddressFromSpki(await keySource.getPublicKeyDer());
if (derived.toLowerCase() !== expectedSigner.toLowerCase()) {
  fail(
    `derived address ${derived} does not match EXPECTED_SIGNER_ADDRESS ${expectedSigner} — ` +
      `the same custody assertion signer-service makes at boot`,
  );
}
line("derivedAddress", `${derived}  (matches EXPECTED_SIGNER_ADDRESS)`);

const fullTypedData = buildTransferWithAuthorizationTypedData(typedDataInput);
const digest = digestTypedData(fullTypedData);

const signed = await signDigestWithKeySource(
  keySource,
  Buffer.from(digest.slice(2), "hex"),
  derived,
  {
    x402Version: challenge.x402Version ?? X402_VERSION,
    resource: CARDAPI,
    // The challenge entry being satisfied. `accepted.amount` is the only place
    // the facilitator reads the payment amount from — confirmed the hard way.
    accepted: {
      scheme: "exact",
      network: challenge.network,
      chainId: challenge.chainId,
      amount: challenge.amount,
      asset: challenge.asset,
      payTo: challenge.payTo,
      maxTimeoutSeconds: challenge.maxTimeoutSeconds,
      extra: {
        assetTransferMethod: challenge.extra.assetTransferMethod,
        name: challenge.extra.name,
        version: challenge.extra.version,
      },
    },
    authorization: {
      from: expectedSigner as `0x${string}`,
      to: challenge.payTo as `0x${string}`,
      value: challenge.amount,
      validAfter: String(validAfter),
      validBefore: String(validBefore),
      nonce: nonce as `0x${string}`,
    },
  },
);

line("v", signed.signature.v);
line("header bytes", signed.header.length);

// --- 5. retry with PAYMENT-SIGNATURE ---------------------------------------------

console.log("\n5. Retrying with PAYMENT-SIGNATURE");

// The header from the pipeline is now the confirmed v2 envelope, so the probe
// exercises the SAME code path production uses rather than a bespoke payload.
// The variant search that discovered this shape is recorded in
// execution_plan §19.3 and pinned by test/x402-header.test.ts.
const t0 = Date.now();
const settleRes = await fetch(CARDAPI, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "PAYMENT-SIGNATURE": signed.header,
  },
  body: JSON.stringify({
    amount_sgd: amountSgd,
    cardholder_name: cardholderName,
  }),
});
const settleBody = await settleRes.text();

if (settleRes.status === 402) {
  let reason = settleBody.slice(0, 300);
  try {
    reason = (JSON.parse(settleBody) as { error?: string }).error ?? reason;
  } catch {
    /* not JSON */
  }
  fail(
    `402 — the facilitator rejected the payload. Nothing was spent.\n` +
      `  Reason: ${reason}\n\n` +
      `  The domain assertion passed in step 2, so the digest is not the issue.\n` +
      `  An "invalid atomic amount" here means the accepted block did not arrive intact.`,
  );
}
if (!settleRes.ok) {
  fail(`unexpected ${settleRes.status}: ${settleBody.slice(0, 600)}`);
}

line("status", settleRes.status);


let parsed: Record<string, unknown>;
try {
  parsed = JSON.parse(settleBody) as Record<string, unknown>;
} catch {
  fail(`response was not JSON: ${settleBody.slice(0, 400)}`);
}

console.log("\n  ACCEPTED. Response keys: " + Object.keys(parsed).join(", "));
const settlementTx =
  (parsed["settlement_tx"] as string | undefined) ??
  (parsed["settlementTx"] as string | undefined);
const cardId =
  (parsed["card_opaque_id"] as string | undefined) ??
  (parsed["cardOpaqueId"] as string | undefined);
if (cardId) line("card_opaque_id", cardId);
if (settlementTx) line("settlement_tx", settlementTx);

// --- 6. verify the settlement on chain + measure latency -------------------------

if (!settlementTx) {
  console.log(
    "\n  No settlement_tx in the response. Record the actual keys above in " +
      "execution_plan §19.3 and hand them to Owner B.\n",
  );
  process.exit(0);
}

console.log("\n6. Verifying the settlement on Fuji");
let receipt: { status?: string; blockNumber?: string } | null = null;
for (let i = 0; i < 60; i++) {
  receipt = (await rpcCall("eth_getTransactionReceipt", [settlementTx])) as {
    status?: string;
    blockNumber?: string;
  } | null;
  if (receipt) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const latencyMs = Date.now() - t0;

if (!receipt) {
  fail(`no receipt for ${settlementTx} after 60s — it may still be pending`);
}
line("status", receipt.status === "0x1" ? "success" : `REVERTED (${receipt.status})`);
line("blockNumber", Number(receipt.blockNumber));

console.log(`\n  202 -> settlement latency: ${latencyMs} ms (${(latencyMs / 1000).toFixed(1)}s)`);
console.log("\n  HAND THIS NUMBER TO OWNER B.");
console.log("  It sets maxAuthValiditySeconds (check 7) from data, not a guess.");
console.log(`  Explorer: ${chain.explorerTxBase}${settlementTx}\n`);
