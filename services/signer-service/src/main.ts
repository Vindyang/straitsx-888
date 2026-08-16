/**
 * signer-service entry point (A11) — reads env, selects the key source, derives
 * the paying address at boot, asserts it matches EXPECTED_SIGNER_ADDRESS, and
 * listens. Nothing else.
 */

import {
  CHAINS,
  SERVICE_PORTS,
  envNumber,
  requireEnv,
  type ChainId,
  type Hex,
} from "@straitsx/contracts";
import { getAddress } from "viem";
import { buildSignerApp } from "./app";
import { buildKmsKeySource } from "./keys/kms-key-source";
import { buildLocalKeySource } from "./keys/local-key-source";
import { deriveAddressFromSpki } from "./keys/derive-address";

const port = envNumber("PORT", SERVICE_PORTS.signer);
const host = process.env["HOST"] ?? "0.0.0.0";
const chainId = envNumber("SIGNER_CHAIN_ID", 43113) as ChainId;

const keySourceKind = process.env["SIGNER_KEY_SOURCE"] ?? "kms";
const kmsKeyId = process.env["KMS_KEY_ID"];

let keySource;
if (keySourceKind === "local") {
  // Dev/test ONLY. Refuse to start unless explicitly allowed, so a local key can
  // never be mistaken for the KMS-backed real signer.
  if (process.env["ALLOW_LOCAL_KEY_SOURCE"] !== "true") {
    throw new Error(
      "SIGNER_KEY_SOURCE=local requires ALLOW_LOCAL_KEY_SOURCE=true (dev/test only). " +
        "A raw private key undercuts the 'agent never holds the key' claim.",
    );
  }
  const privateKey = requireEnv("LOCAL_SIGNER_PRIVATE_KEY");
  keySource = buildLocalKeySource(privateKey);
} else {
  if (!kmsKeyId) {
    throw new Error(
      "KMS_KEY_ID is required when SIGNER_KEY_SOURCE=kms (the default)",
    );
  }
  keySource = buildKmsKeySource({
    keyId: kmsKeyId,
    region: process.env["AWS_REGION"] ?? "ap-southeast-1",
  });
}

// The custody proof (A11): derive the address from the public key and assert it
// equals EXPECTED_SIGNER_ADDRESS character-for-character. On mismatch, refuse to
// start — signing from an unfunded account means no signature ever settles.
const expectedSignerAddress = requireEnv("EXPECTED_SIGNER_ADDRESS");
const derivedAddress = deriveAddressFromSpki(await keySource.getPublicKeyDer());
if (derivedAddress.toLowerCase() !== expectedSignerAddress.toLowerCase()) {
  throw new Error(
    `derived address ${derivedAddress} does not match EXPECTED_SIGNER_ADDRESS ${expectedSignerAddress} — ` +
      "stop and tell the team; this account has no money and no signature will settle",
  );
}

// Expected on-chain constants the live challenge must match (A12 + §19.4). For
// the configured chain only; the challenge is the authority for the domain, and
// a mismatch must refuse, never default.
const chain = CHAINS[chainId];
const expectedDomain = {
  chainId,
  asset: chain.xsgd.toLowerCase() as Hex,
  name: chain.eip712Name,
  version: chain.eip712Version ?? "", // mainnet null → will mismatch any live challenge → refuse
};

const app = buildSignerApp({
  internalToken: process.env["INTERNAL_TOKEN"],
  chainId,
  keySource,
  signerAddress: getAddress(derivedAddress),
  expectedDomain,
  pinnedMandatesJson: process.env["PINNED_MANDATES"],
  kmsKeyId,
  logger: true,
});

await app.listen({ port, host });
app.log.warn(
  `signer-service listening on ${host}:${port} — derivedAddress ${derivedAddress}`,
);
