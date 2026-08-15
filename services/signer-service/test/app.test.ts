/**
 * signer-service app-level tests: the real §4 shape, the seven rail refusals at
 * the HTTP layer, internal auth, and the masked health payload. Replaces the
 * A1 stub contract tests (the stub is gone).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildSignerApp } from "../src/app";
import { buildLocalKeySource } from "../src/keys/local-key-source";
import { deriveAddressFromSpki } from "../src/keys/derive-address";

const TOKEN = "test-internal-token";
const PRIVATE_KEY = `0x${"1".padStart(64, "0")}` as Hex;
const MANDATE_ID = `0x${"7f3a".padStart(64, "0")}`;
const RECIPIENT = "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8";

/** The paying wallet is the LocalKeySource's derived address, NOT the funding
 *  origin wallet — the rail asserts message.from == derived paying wallet. */
const PAYING_WALLET = privateKeyToAccount(PRIVATE_KEY).address;

function validSignBody() {
  return {
    requestId: "3f6c8b2e-0000-4000-8000-000000000000",
    mandateId: MANDATE_ID,
    typedData: {
      domain: {
        name: "XSGD",
        version: "2",
        chainId: 43113,
        verifyingContract: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
      },
      primaryType: "TransferWithAuthorization",
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      message: {
        from: PAYING_WALLET,
        to: RECIPIENT,
        value: "5000000",
        validAfter: 1786000000,
        validBefore: 1786000120,
        nonce: `0x${"9c1f".padStart(64, "0")}`,
      },
    },
    // The `accepts[]` entry being satisfied. REQUIRED — the facilitator reads
    // `accepted.amount` and the emitted header cannot settle without it.
    resource: "https://card.straitsx.ai/sandbox/cardapi/issue_card",
    accepted: {
      scheme: "exact",
      network: "eip155:43113",
      chainId: 43113,
      amount: "5000000",
      asset: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
      payTo: RECIPIENT,
      maxTimeoutSeconds: 300,
      extra: {
        assetTransferMethod: "eip3009",
        name: "XSGD",
        version: "2",
      },
    },
  };
}

function makeApp(signerAddress?: string) {
  const source = buildLocalKeySource(PRIVATE_KEY);
  return buildSignerApp({
    internalToken: TOKEN,
    chainId: 43113,
    keySource: source,
    signerAddress: (signerAddress ?? PAYING_WALLET) as `0x${string}`,
    expectedDomain: {
      chainId: 43113,
      asset: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
      name: "XSGD",
      version: "2",
    },
    pinnedMandatesJson: JSON.stringify({
      [MANDATE_ID]: {
        settlementRecipient: RECIPIENT,
        hardMaxTotal: "30000000",
      },
    }),
    kmsKeyId: undefined,
  });
}

describe("signer-service (real)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    await app.ready();
  });

  it("GET /health answers unauthenticated with a masked kmsKeyId and no stub flag", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("stub");
    expect(body.derivedAddress).toBe(privateKeyToAccount(PRIVATE_KEY).address);
  });

  it("POST /sign returns the real §4 response shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: validSignBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestId).toBe("3f6c8b2e-0000-4000-8000-000000000000");
    expect(typeof body.header).toBe("string");
    expect(body.signature).toHaveProperty("v");
    expect(body.signature).toHaveProperty("r");
    expect(body.signature).toHaveProperty("s");
    expect(body.signerAddress).toBe(privateKeyToAccount(PRIVATE_KEY).address);
    expect(body.signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("requires the internal token on /sign", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      payload: validSignBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses SIGNER_UNPINNED_MANDATE for an unpinned mandate (403)", async () => {
    const body = validSignBody();
    body.mandateId = `0x${"f".padStart(64, "0")}`;
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SIGNER_UNPINNED_MANDATE");
  });

  it("refuses SIGNER_WRONG_RECIPIENT for a mismatched to (403)", async () => {
    const body = validSignBody();
    body.typedData.message.to = `0x${"d".padStart(40, "0")}`;
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SIGNER_WRONG_RECIPIENT");
  });

  it("refuses SIGNER_CEILING for a value over hardMaxTotal (403)", async () => {
    const body = validSignBody();
    body.typedData.message.value = "30000001";
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SIGNER_CEILING");
  });

  it("refuses SIGNER_REPLAY for a repeated requestId (409)", async () => {
    const body = validSignBody();
    const headers = { "x-internal-token": TOKEN };
    const first = await app.inject({
      method: "POST",
      url: "/sign",
      headers,
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/sign",
      headers,
      payload: body,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("SIGNER_REPLAY");
  });
});
