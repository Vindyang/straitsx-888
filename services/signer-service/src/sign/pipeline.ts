/**
 * A13 — the KMS signature normalisation pipeline: parse DER → normalise `s` →
 * recover `v` → emit `{ v, r, s }` and the base64 PAYMENT-SIGNATURE header.
 *
 * AWS KMS returns a DER ECDSA signature with:
 *   - no recovery id (`v` must be recovered by trying both parities), and
 *   - no low-s guarantee (a high `s` must be flipped to `n - s`).
 *
 * A high-`s` signature is rejected by most verifiers and the symptom — a 402
 * that never clears — looks exactly like a wrong-domain bug. The three offline
 * vectors in test/signature-vectors.test.ts prove this path is byte-identical
 * to viem for a fixed key.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex,
  getAddress,
  hexToBytes,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { isoSeconds } from "@straitsx/contracts";
import type { KeySource } from "../keys/key-source";
import { normaliseS, parseSignatureDer, type RSEcdsa } from "../keys/der";

/** The ECDSA signature in the wire shape (api-contracts.md §4): `v` is 27/28. */
export type SignatureParts = { v: number; r: Hex; s: Hex };

/** The `PAYMENT-SIGNATURE` header result — the header is the base64 of the x402
 *  signed-requirements payload (api-contracts.md §4). */
export type PaymentSignatureHeader = {
  header: string;
  signature: SignatureParts;
  signerAddress: Address;
  signedAt: string;
};

function toBigIntHex(value: bigint): Hex {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return `0x${hex}`;
}

function bigIntTo32Bytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  return hexToBytes(`0x${hex}`);
}

/** Derive the lowercased Ethereum address from a 65-byte uncompressed point. */
function addressFromUncompressedPoint(point: Uint8Array): Address {
  // point is 65 bytes: 0x04‖x‖y. Address = keccak256(x‖y)[12..], checksummed.
  const xy = point.slice(1);
  const hash = keccak256(bytesToHex(xy) as Hex);
  const last20 = hexToBytes(hash).slice(-20);
  return getAddress(bytesToHex(last20));
}

/**
 * Recover the 27/28 `v` by trying every recovery id against `derivedAddress`.
 * KMS returns no recovery id. secp256k1 ECDSA recovery ids are 0..3: bit 0 is
 * the parity, bit 1 marks the nonce point's x >= n (so x = r + n, not r).
 * Ethereum's ecrecover handles the overflow internally, so the wire `v` only
 * encodes the parity: `v = 27 + (recovery & 1)`. We try all four and keep the
 * one that recovers the derived address.
 */
export function recoverV(
  r: bigint,
  s: bigint,
  digest: Uint8Array,
  derivedAddress: Address,
): number {
  // Compare checksummed-to-checksummed (§0: addresses are EIP-55 in JSON).
  const expected = getAddress(derivedAddress);
  for (const recovery of [0, 1, 2, 3]) {
    try {
      const recovered = secp256k1.Signature.fromBytes(
        Uint8Array.from([
          recovery,
          ...bigIntTo32Bytes(r),
          ...bigIntTo32Bytes(s),
        ]),
        "recovered",
      ).recoverPublicKey(digest);

      if (addressFromUncompressedPoint(recovered.toBytes(false)) === expected) {
        return 27 + (recovery & 1);
      }
    } catch {
      // noble throws "recovery id 2 or 3 invalid" when r + n >= p — that recovery
      // id cannot describe this signature. Skip it; another id will match.
    }
  }
  throw new Error(
    `signature recovery failed: no recovery id recovers ${derivedAddress}`,
  );
}

/** Parse a DER signature and normalise `s` to the lower half of the order. */
function parseAndNormalise(der: Uint8Array): RSEcdsa {
  const { r, s } = parseSignatureDer(der);
  return { r, s: normaliseS(s) };
}

/**
 * Sign a 32-byte digest with the key source, normalise, recover `v`, and build
 * the full `{ header, signature, signerAddress, signedAt }` result.
 *
 * `signerAddress` comes from the caller's derived address — the pipeline never
 * trusts a `v` supplied by KMS.
 */
export async function signDigestWithKeySource(
  keySource: KeySource,
  digest: Uint8Array,
  derivedAddress: Address,
  headerPayload: unknown,
): Promise<PaymentSignatureHeader> {
  if (digest.length !== 32) {
    throw new Error(`digest must be 32 bytes, got ${digest.length}`);
  }

  const der = await keySource.signDigest(digest);
  const { r, s } = parseAndNormalise(der);
  const v = recoverV(r, s, digest, derivedAddress);

  return {
    header: Buffer.from(JSON.stringify(headerPayload), "utf8").toString(
      "base64",
    ),
    signature: { v, r: toBigIntHex(r), s: toBigIntHex(s) },
    signerAddress: getAddress(derivedAddress),
    signedAt: isoSeconds(),
  };
}
