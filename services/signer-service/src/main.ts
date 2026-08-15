import { SERVICE_PORTS, envNumber } from "@straitsx/contracts";
import { buildSignerApp } from "./app";

const port = envNumber("PORT", SERVICE_PORTS.signer);
const host = process.env["HOST"] ?? "0.0.0.0";
const chainId = envNumber("SIGNER_CHAIN_ID", 43113);

/**
 * A stub must never be mistaken for the real signer. If a KMS key id is
 * configured, someone believes this process can sign — refuse to start rather
 * than serve dummy headers to a path that expects real ones.
 */
if (process.env["KMS_KEY_ID"]) {
  throw new Error(
    "KMS_KEY_ID is set but this is the A1 stub signer, which cannot sign. " +
      "Unset it, or build the real signer (A11-A14).",
  );
}

const app = buildSignerApp({
  internalToken: process.env["INTERNAL_TOKEN"],
  chainId,
  logger: true,
});

await app.listen({ port, host });
app.log.warn(
  `signer-service STUB listening on ${host}:${port} — returns dummy headers, holds no key`,
);
