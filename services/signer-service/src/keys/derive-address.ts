/**
 * Derive the Ethereum address from an SPKI (X.509 SubjectPublicKeyInfo) DER
 * public key — exactly the shape AWS KMS `GetPublicKey` returns for an
 * `ECC_SECG_P256K1` key.
 *
 * This is the A11 custody proof: the signer derives the address from the public
 * key at boot and asserts it equals `EXPECTED_SIGNER_ADDRESS`. The derivation
 * never touches private key material.
 *
 * SPKI for secp256k1 is:
 *
 *   SEQUENCE {
 *     SEQUENCE {
 *       OID ecPublicKey (1.2.840.10045.2.1)
 *       OID secp256k1    (1.3.132.0.10)
 *     }
 *     BIT STRING { 0x04 || x(32) || y(32) }   // uncompressed point
 *   }
 *
 * The Ethereum address is `keccak256(x || y)`'s last 20 bytes, EIP-55
 * checksummed. We parse the BIT STRING with a minimal ASN.1 walk rather than
 * assuming a fixed byte offset, because KMS DER is not guaranteed to have a
 * fixed tail.
 */

import { bytesToHex, getAddress, hexToBytes, keccak256, type Hex } from "viem";

const SEQUENCE_TAG = 0x30;
const BIT_STRING_TAG = 0x03;

function readDerLength(
  der: Uint8Array,
  offset: number,
): { length: number; next: number } {
  const first = der[offset];
  if (first === undefined)
    throw new Error("SPKI DER truncated: missing length");
  if (first < 0x80) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count === 0) throw new Error("SPKI DER indefinite length is not allowed");
  if (count > 4) throw new Error("SPKI DER length too large");
  let length = 0;
  for (let i = 0; i < count; i++) {
    const byte = der[offset + 1 + i];
    if (byte === undefined) throw new Error("SPKI DER truncated: length");
    length = length * 256 + byte;
  }
  return { length, next: offset + 1 + count };
}

/** Extract the raw uncompressed point (65 bytes: 0x04‖x‖y) from SPKI DER. */
export function extractUncompressedPoint(spki: Uint8Array): Uint8Array {
  if (spki[0] !== SEQUENCE_TAG) {
    throw new Error("SPKI DER must start with a SEQUENCE");
  }
  const outer = readDerLength(spki, 1);

  // Skip the algorithm identifier SEQUENCE.
  let cursor = outer.next;
  if (spki[cursor] !== SEQUENCE_TAG) {
    throw new Error("SPKI DER missing algorithm SEQUENCE");
  }
  const algorithm = readDerLength(spki, cursor + 1);
  cursor = algorithm.next + algorithm.length;

  if (spki[cursor] !== BIT_STRING_TAG) {
    throw new Error("SPKI DER missing BIT STRING (public key)");
  }
  const bitString = readDerLength(spki, cursor + 1);
  const contentStart = bitString.next;
  if (spki[contentStart] !== 0x00) {
    throw new Error("SPKI DER BIT STRING has non-zero unused-bits count");
  }
  const point = spki.slice(contentStart + 1, bitString.next + bitString.length);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error(
      `SPKI DER BIT STRING is not a 65-byte uncompressed secp256k1 point (got ${point.length} bytes)`,
    );
  }
  return point;
}

/**
 * Derive the EIP-55 checksummed Ethereum address from an SPKI DER public key.
 * `keccak256(x || y)` last 20 bytes — the `0x04` prefix is dropped.
 */
export function deriveAddressFromSpki(spki: Uint8Array): Hex {
  const point = extractUncompressedPoint(spki);
  const xy = point.slice(1); // drop 0x04
  const hash = keccak256(bytesToHex(xy) as Hex);
  const addressBytes = hexToBytes(hash).slice(-20);
  return getAddress(bytesToHex(addressBytes));
}
