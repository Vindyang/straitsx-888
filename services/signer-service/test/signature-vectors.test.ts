/**
 * The three A13 offline signature vectors — the highest-value test in the
 * project (docs/owner-a-tasks.md A13, docs/execution_plan.md §12b).
 *
 *   1. Fixed key → viem signTypedData vs the same digest through
 *      LocalKeySource + our DER path → byte-identical { r, s } and matching v.
 *   2. A hand-built high-`s` DER → normalisation flips it and v still recovers.
 *   3. Both v = 27 and v = 28 cases exercised (recoverV tries both parities).
 *
 * No KMS, no network, no credentials.
 */

import { describe, expect, it } from "vitest";
import {
  getAddress,
  hexToBytes,
  keccak256,
  parseSignature,
  stringToHex,
  type Hex,
} from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import { buildLocalKeySource } from "../src/keys/local-key-source";
import { deriveAddressFromSpki } from "../src/keys/derive-address";
import {
  encodeSignatureDer,
  parseSignatureDer,
  SECP256K1_ORDER,
} from "../src/keys/der";
import {
  buildTransferWithAuthorizationTypedData,
  digestTypedData,
  type BuildTypedDataInput,
} from "../src/sign/typed-data";
import { recoverV, signDigestWithKeySource } from "../src/sign/pipeline";

const PRIVATE_KEY = `0x${"1".padStart(64, "0")}` as Hex;

function makeTypedData(): BuildTypedDataInput {
  return {
    from: "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7",
    to: "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8",
    value: "5000000",
    validAfter: 1786000000,
    validBefore: 1786000120,
    nonce: `0x${"9c1f".padStart(64, "0")}`,
    domain: {
      name: "XSGD",
      version: "2",
      chainId: 43113,
      verifyingContract: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
    },
  };
}

describe("A13 signature vectors", () => {
  it("vector 1: LocalKeySource + pipeline is byte-identical to viem signTypedData", async () => {
    const source = buildLocalKeySource(PRIVATE_KEY);
    const expectedAddress = privateKeyToAccount(PRIVATE_KEY).address;

    // Custody proof: the SPKI public key derives to the same address as viem.
    const derived = deriveAddressFromSpki(await source.getPublicKeyDer());
    expect(derived).toBe(expectedAddress);

    const typedData = buildTransferWithAuthorizationTypedData(makeTypedData());
    const digest = digestTypedData(typedData);

    const viemSig = await signTypedData({
      ...(typedData as unknown as Parameters<typeof signTypedData>[0]),
      privateKey: PRIVATE_KEY,
    });
    const viemParsed = parseSignature(viemSig);

    const result = await signDigestWithKeySource(
      source,
      hexToBytes(digest),
      expectedAddress,
      { x402Version: 1, scheme: "exact" },
    );

    expect(result.signature.r).toBe(viemParsed.r);
    expect(result.signature.s).toBe(viemParsed.s);
    // viem 2.x emits yParity (0/1); our wire v is 27/28.
    expect(result.signature.v - 27).toBe(viemParsed.yParity);
    expect(result.signerAddress).toBe(getAddress(expectedAddress));
  });

  it("vector 2: a high-s DER is normalised and v still recovers", async () => {
    const source = buildLocalKeySource(PRIVATE_KEY);
    const expectedAddress = privateKeyToAccount(PRIVATE_KEY).address;

    const typedData = buildTransferWithAuthorizationTypedData(makeTypedData());
    const digestBytes = hexToBytes(digestTypedData(typedData));

    // Sign via noble (lowS: false may produce either half). Compute the
    // canonical low-s, then build the deliberately high-s form (n - lowS).
    const realDer = await source.signDigest(digestBytes);
    const { r, s } = parseSignatureDer(realDer);
    const lowS = s > SECP256K1_ORDER / 2n ? SECP256K1_ORDER - s : s;
    const sHigh = SECP256K1_ORDER - lowS;
    expect(sHigh > SECP256K1_ORDER / 2n).toBe(true);

    // A KeySource that returns the deliberately high-s DER.
    const highSsource = {
      getPublicKeyDer: () => source.getPublicKeyDer(),
      signDigest: async () => encodeSignatureDer(r, sHigh),
    };

    const result = await signDigestWithKeySource(
      highSsource,
      digestBytes,
      expectedAddress,
      {},
    );

    // The pipeline must normalise s back down to low-s and still recover a v.
    expect(result.signature.s).toBe(`0x${lowS.toString(16).padStart(64, "0")}`);
    expect([27, 28]).toContain(result.signature.v);
  });

  it("vector 3: recoverV recovers both v = 27 and v = 28 across deterministic digests", async () => {
    const source = buildLocalKeySource(PRIVATE_KEY);
    const derivedAddress = deriveAddressFromSpki(
      await source.getPublicKeyDer(),
    );
    const seen = new Set<number>();

    // Deterministic digests: keccak256 of "digest-N". Fixed inputs → the set of
    // recovered parities is identical on every run.
    for (let i = 0; i < 64; i++) {
      const digest = hexToBytes(keccak256(stringToHex(`digest-${i}`)));
      const der = await source.signDigest(digest);
      const { r, s } = parseSignatureDer(der);
      seen.add(recoverV(r, s, digest, derivedAddress));
      if (seen.size === 2) break;
    }

    expect(seen.has(27)).toBe(true);
    expect(seen.has(28)).toBe(true);
  });
});
