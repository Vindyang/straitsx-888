/**
 * A11 — derive the Ethereum address from a KMS public key.
 *
 * Reads the base64 SPKI DER on **stdin** and prints the EIP-55 checksummed
 * address. Taking the key on stdin rather than calling KMS itself keeps this
 * script credential-free and offline-testable: the caller (scripts/setup-kms.sh)
 * already has an authenticated `aws` CLI, and the derivation is pure.
 *
 *   aws kms get-public-key --key-id "$KMS_KEY_ID" --region "$AWS_REGION" \
 *     --output text --query PublicKey | pnpm tsx scripts/derive-kms-address.ts
 *
 * This is the value that becomes `EXPECTED_SIGNER_ADDRESS`. signer-service
 * re-derives it at boot and refuses to start if it disagrees — so a typo here
 * fails loudly at startup, never mid-signature.
 *
 * NOTE ON THE IMPORT: this reaches into signer-service's source, which services
 * themselves may never do (conventions.md §1). `scripts/` is repo tooling, not a
 * service, and the alternative is a second ASN.1 walk that could drift from the
 * one the boot assertion uses — two derivations that disagree is precisely the
 * bug this script exists to rule out. One implementation, imported.
 */

import { deriveAddressFromSpki } from "../services/signer-service/src/keys/derive-address";

function fail(message: string): never {
  console.error(`derive-kms-address: ${message}`);
  process.exit(1);
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk));
}

const base64 = Buffer.concat(chunks).toString("utf8").trim();
if (base64.length === 0) {
  fail(
    "no input on stdin — pipe the base64 SPKI DER in, e.g. " +
      "aws kms get-public-key --key-id KEY --output text --query PublicKey | pnpm tsx scripts/derive-kms-address.ts",
  );
}

let der: Buffer;
try {
  der = Buffer.from(base64, "base64");
} catch {
  fail("stdin is not valid base64");
}

// Buffer.from is lenient: it drops invalid characters instead of throwing, so a
// truncated or non-base64 paste arrives here as a short buffer. Re-encoding and
// comparing lengths catches that before it becomes a wrong address.
if (der.length === 0 || der.toString("base64").length !== base64.length) {
  fail(
    `stdin does not round-trip as base64 (decoded ${der.length} bytes) — ` +
      "the public key was probably truncated in transit",
  );
}

let address: string;
try {
  address = deriveAddressFromSpki(new Uint8Array(der));
} catch (err) {
  fail(
    `could not parse the SPKI DER public key: ${err instanceof Error ? err.message : String(err)}`,
  );
}

// stdout is ONLY the address, so the wizard can capture it with $(...).
process.stdout.write(`${address}\n`);
