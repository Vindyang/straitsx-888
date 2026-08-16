/**
 * LocalKeySource — a `KeySource` that signs with an in-memory secp256k1 private
 * key while emitting AWS KMS-shaped outputs (SPKI public key, ECDSA DER
 * signature with no recovery id and no low-s guarantee).
 *
 * Dev/test ONLY. The private key must never appear in a production env — the
 * whole point of the project is "the agent never holds the key", and KMS is not
 * substitutable (docs/execution_plan.md §18). main.ts refuses to start in this
 * mode unless ALLOW_LOCAL_KEY_SOURCE=true, and the private key itself is only
 * ever supplied for offline signature-vector tests.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes } from "viem";
import type { KeySource } from "./key-source";
import { encodeSignatureDer } from "./der";

/** ASN.1 OID encodings for the secp256k1 SPKI algorithm identifier. */
const OID_EC_PUBLIC_KEY = new Uint8Array([
  0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
]);
const OID_SECP256K1 = new Uint8Array([
  0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a,
]);

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** Build SPKI DER for a secp256k1 uncompressed point (0x04‖x‖y). */
export function buildSpkiDer(uncompressedPoint: Uint8Array): Uint8Array {
  if (uncompressedPoint.length !== 65 || uncompressedPoint[0] !== 0x04) {
    throw new Error("uncompressed point must be 65 bytes starting with 0x04");
  }

  // AlgorithmIdentifier: SEQUENCE { OID ecPublicKey, OID secp256k1 }
  const algorithm = new Uint8Array([
    0x30,
    ...derLength(OID_EC_PUBLIC_KEY.length + OID_SECP256K1.length),
    ...OID_EC_PUBLIC_KEY,
    ...OID_SECP256K1,
  ]);

  // BIT STRING: 0x00 (unused bits) || point
  const bitStringContent = new Uint8Array(1 + uncompressedPoint.length);
  bitStringContent.set(uncompressedPoint, 1);
  const bitString = new Uint8Array([
    0x03,
    ...derLength(bitStringContent.length),
    ...bitStringContent,
  ]);

  const inner = new Uint8Array(algorithm.length + bitString.length);
  inner.set(algorithm, 0);
  inner.set(bitString, algorithm.length);
  return new Uint8Array([0x30, ...derLength(inner.length), ...inner]);
}

/** Normalise a private key into a 32-byte array for @noble/curves. */
function privateKeyBytes(privateKey: Uint8Array | string): Uint8Array {
  if (typeof privateKey === "string") {
    const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    return hexToBytes(`0x${hex}`);
  }
  if (privateKey.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKey.length}`);
  }
  return privateKey;
}

/**
 * Build a LocalKeySource from a 32-byte private key (Uint8Array or 0x-hex).
 * `signDigest` signs the 32-byte digest directly (`prehash: false`, matching
 * AWS KMS `MessageType: DIGEST`) with `lowS: false` so the DER can legitimately
 * carry a high-`s` — the exact condition the normalisation path must handle.
 */
export function buildLocalKeySource(
  privateKey: Uint8Array | string,
): KeySource {
  const key = privateKeyBytes(privateKey);
  const uncompressed = secp256k1.getPublicKey(key, false);
  const spki = buildSpkiDer(uncompressed);

  return {
    async getPublicKeyDer(): Promise<Uint8Array> {
      return spki;
    },
    async signDigest(digest: Uint8Array): Promise<Uint8Array> {
      if (digest.length !== 32) {
        throw new Error(`digest must be 32 bytes, got ${digest.length}`);
      }
      // prehash: false -> sign the digest bytes as-is (KMS DIGEST semantics).
      // lowS: false -> do NOT auto-normalise, so we exercise the real KMS shape.
      const sig = secp256k1.sign(digest, key, { prehash: false, lowS: false });
      return encodeSignatureDer(sig.r, sig.s);
    },
  };
}
