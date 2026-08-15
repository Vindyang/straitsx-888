/**
 * KmsKeySource — the real AWS KMS backend for the `KeySource` seam.
 *
 * Wraps `GetPublicKey` and `Sign` from `@aws-sdk/client-kms` for an asymmetric
 * `ECC_SECG_P256K1` / `SIGN_VERIFY` key. The public key is returned as SPKI DER
 * (X.509 SubjectPublicKeyInfo) and the signature as ECDSA DER — the exact
 * shapes LocalKeySource emulates, so the downstream parse → normalise → recover
 * path is identical.
 *
 * Never log the full key id (docs/execution_plan.md §18). KMS failures surface
 * as `SIGNER_KMS_FAILED` (502, retryable) in the standard envelope.
 */

import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from "@aws-sdk/client-kms";
import { AppError, ErrorCode } from "@straitsx/contracts";
import type { KeySource } from "./key-source";

export type KmsKeySourceOptions = {
  keyId: string;
  region: string;
  /** The signing algorithm for secp256k1 ECDSA (SHA-256 digest). */
  signingAlgorithm?: "ECDSA_SHA_256";
};

export function buildKmsKeySource(opts: KmsKeySourceOptions): KeySource {
  const client = new KMSClient({ region: opts.region });
  const signingAlgorithm = opts.signingAlgorithm ?? "ECDSA_SHA_256";

  return {
    async getPublicKeyDer(): Promise<Uint8Array> {
      try {
        const res = await client.send(
          new GetPublicKeyCommand({ KeyId: opts.keyId }),
        );
        if (!res.PublicKey) {
          throw new Error("KMS GetPublicKey returned no PublicKey");
        }
        return res.PublicKey;
      } catch (err) {
        throw wrapKmsError(err);
      }
    },

    async signDigest(digest: Uint8Array): Promise<Uint8Array> {
      try {
        const res = await client.send(
          new SignCommand({
            KeyId: opts.keyId,
            Message: digest,
            MessageType: "DIGEST",
            SigningAlgorithm: signingAlgorithm,
          }),
        );
        if (!res.Signature) {
          throw new Error("KMS Sign returned no Signature");
        }
        return res.Signature;
      } catch (err) {
        throw wrapKmsError(err);
      }
    },
  };
}

/** Map any KMS failure to the standard 502 envelope. The message never carries
 *  the full key id, a signature, or a PAN. */
function wrapKmsError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : "unknown KMS error";
  // Strip a full key ARN if it leaked into the SDK message.
  const safe = message.replace(/arn:aws:kms:[^ ]+/g, "arn:aws:kms:…(redacted)");
  return new AppError(
    502,
    ErrorCode.SIGNER_KMS_FAILED,
    `KMS signing failed: ${safe}`,
    true,
  );
}
