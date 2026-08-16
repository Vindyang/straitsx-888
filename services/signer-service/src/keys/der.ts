/**
 * ECDSA DER codec + low-s normalisation. Pure functions over bigint / Uint8Array.
 *
 * A13 is the classic KMS bug (docs/owner-a-tasks.md A13, docs/execution_plan.md
 * §12b): AWS KMS returns a DER-encoded ECDSA signature with NO recovery id and
 * does NOT guarantee a low `s`. A high-`s` signature is rejected by most
 * verifiers, and the symptom — a 402 that never clears — looks exactly like a
 * wrong-domain bug. This module owns the two halves of the fix: decode/encode
 * the DER form, and normalise `s` to the lower half of the curve order.
 *
 * Hand-rolled on purpose: the DER subset for an ECDSA signature is tiny
 * (SEQUENCE of two INTEGERs), and keeping it self-contained makes the codec
 * independently testable against fixed vectors without dragging in a curve
 * library. The signature-vector tests (test/signature-vectors.test.ts) prove it
 * agrees with both viem and @noble/curves.
 */

/** The secp256k1 group order `n`. `s` must live in [1, n-1]; the low-s rule
 *  requires `s <= n/2`. Constant, not computed — never let this drift. */
export const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Half of `n`, the low-s boundary. `s > n/2` means "high-s". */
export const SECP256K1_HALF_ORDER = SECP256K1_ORDER >> 1n;

const INTEGER_TAG = 0x02;
const SEQUENCE_TAG = 0x30;

/** True when `s` is in the upper half of the curve order and must be flipped. */
export function isHighS(s: bigint): boolean {
  return s > SECP256K1_HALF_ORDER;
}

/** Normalise `s` to the lower half of the curve order: `s > n/2` → `n - s`. */
export function normaliseS(s: bigint): bigint {
  return isHighS(s) ? SECP256K1_ORDER - s : s;
}

/** A parsed ECDSA signature's two scalars, both in [1, n-1]. */
export type RSEcdsa = { r: bigint; s: bigint };

function assertScalar(value: bigint, name: "r" | "s"): bigint {
  if (value <= 0n || value >= SECP256K1_ORDER) {
    throw new Error(`invalid signature ${name}: out of range 1..n-1`);
  }
  return value;
}

/** Encode a length in DER: short form (<=127) or long form (0x80 | count). */
function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** Read a DER length at `offset`; returns the byte count and the offset of the
 *  first content byte. Rejects indefinite lengths (never valid in DER). */
function readLength(
  der: Uint8Array,
  offset: number,
): { length: number; next: number } {
  const first = der[offset];
  if (first === undefined) throw new Error("DER truncated: missing length");
  if (first < 0x80) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count === 0) throw new Error("DER indefinite length is not allowed");
  if (count > 4) throw new Error("DER length too large");
  let length = 0;
  for (let i = 0; i < count; i++) {
    const byte = der[offset + 1 + i];
    if (byte === undefined) throw new Error("DER truncated: length");
    length = length * 256 + byte;
  }
  return { length, next: offset + 1 + count };
}

/** Minimal big-endian bytes of a non-negative bigint, with a leading 0x00 when
 *  the top bit of the most-significant byte is set (so the INTEGER is positive). */
function toDerInteger(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("DER INTEGER must be non-negative");
  if (value === 0n) return new Uint8Array([0x00]);
  const hex = value.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  // Positive INTEGER: if the top bit is set, prefix 0x00 so it is not read as
  // a negative two's-complement value.
  if ((bytes[0]! & 0x80) !== 0) {
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes, 1);
    return out;
  }
  return bytes;
}

/** Encode an ECDSA signature as ASN.1 DER: SEQUENCE { INTEGER r, INTEGER s }. */
export function encodeSignatureDer(r: bigint, s: bigint): Uint8Array {
  assertScalar(r, "r");
  assertScalar(s, "s");
  const rBytes = new Uint8Array([
    INTEGER_TAG,
    ...encodeLength(toDerInteger(r).length),
    ...toDerInteger(r),
  ]);
  const sBytes = new Uint8Array([
    INTEGER_TAG,
    ...encodeLength(toDerInteger(s).length),
    ...toDerInteger(s),
  ]);
  const inner = new Uint8Array(rBytes.length + sBytes.length);
  inner.set(rBytes, 0);
  inner.set(sBytes, rBytes.length);
  return new Uint8Array([
    SEQUENCE_TAG,
    ...encodeLength(inner.length),
    ...inner,
  ]);
}

/** Parse an ASN.1 DER ECDSA signature into `{ r, s }`. */
export function parseSignatureDer(der: Uint8Array): RSEcdsa {
  if (der[0] !== SEQUENCE_TAG) {
    throw new Error("DER signature must start with a SEQUENCE");
  }
  const { length: seqLength, next: seqContent } = readLength(der, 1);
  if (seqContent + seqLength !== der.length) {
    throw new Error("DER signature length mismatch");
  }

  const readInteger = (offset: number): { value: bigint; next: number } => {
    const tag = der[offset];
    if (tag !== INTEGER_TAG)
      throw new Error("DER signature INTEGER tag missing");
    const { length, next } = readLength(der, offset + 1);
    if (length === 0) throw new Error("DER INTEGER is empty");
    const content = der.slice(next, next + length);
    if (content.length !== length) throw new Error("DER INTEGER truncated");
    // Two's-complement big-endian. A leading 0x00 marks a positive number whose
    // top bit would otherwise be set; a leading 0x80+ is negative (invalid).
    if ((content[0]! & 0x80) !== 0) {
      throw new Error("DER signature INTEGER is negative");
    }
    let value = 0n;
    for (const byte of content) value = (value << 8n) | BigInt(byte);
    return { value, next: next + length };
  };

  const { value: r, next: afterR } = readInteger(seqContent);
  const { value: s, next: afterS } = readInteger(afterR);
  if (afterS !== seqContent + seqLength) {
    throw new Error("DER signature has trailing bytes");
  }
  return { r: assertScalar(r, "r"), s: assertScalar(s, "s") };
}
