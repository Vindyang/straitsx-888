/**
 * The key seam that makes the whole signer testable offline (A11/A13).
 *
 * Two backends — `KmsKeySource` (real AWS) and `LocalKeySource` (dev/test) —
 * both implement this interface and feed the IDENTICAL parse → normalise →
 * recover path in sign/pipeline.ts. `LocalKeySource` emulates AWS KMS's output
 * shapes exactly:
 *
 *   - the public key is X.509 SubjectPublicKeyInfo (SPKI) DER, and
 *   - the signature is an ECDSA DER with NO recovery id and no low-s guarantee.
 *
 * Because the two backends are byte-compatible at the interface, swapping in
 * KMS changes no downstream logic and the signature vectors are provable
 * without any AWS credentials.
 */

/** Returns the public key as SPKI (X.509 SubjectPublicKeyInfo) DER bytes. */
export interface KeySource {
  getPublicKeyDer(): Promise<Uint8Array>;
  /** Signs a 32-byte message digest, returning an ECDSA DER signature. */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}
