/**
 * A1 stub contract tests. Owner B integrates against these shapes on hour one,
 * so the stub's job is to be shape-correct and unmistakably a stub.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildSignerApp } from "../src/app";

const TOKEN = "test-internal-token";
const MANDATE_ID = `0x${"7f3a".padStart(64, "0")}`;

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
        from: "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7",
        to: "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8",
        value: "5000000",
        validAfter: 1786000000,
        validBefore: 1786000120,
        nonce: `0x${"9c1f".padStart(64, "0")}`,
      },
    },
  };
}

describe("signer-service stub", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildSignerApp({ internalToken: TOKEN, chainId: 43113 });
  });

  it("GET /health answers unauthenticated so A15 can probe reachability", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  /**
   * The single most important property of this build: it must be impossible to
   * mistake for the real signer. derivedAddress is null, not the paying wallet.
   */
  it("GET /health declares itself a stub with no derived address", async () => {
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(body.stub).toBe(true);
    expect(body.derivedAddress).toBeNull();
    expect(body.kmsKeyId).toBeNull();
  });

  it("POST /sign returns the §4 response shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: validSignBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      requestId: "3f6c8b2e-0000-4000-8000-000000000000",
      stub: true,
    });
    expect(typeof body.header).toBe("string");
    expect(body.signature).toHaveProperty("v");
    expect(body.signature).toHaveProperty("r");
    expect(body.signature).toHaveProperty("s");
    expect(typeof body.signerAddress).toBe("string");
    expect(body.signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  /** A stub header that reached cardapi must fail loudly, not look plausible. */
  it("returns a header that decodes to a visible stub marker", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: validSignBody(),
    });
    const decoded = Buffer.from(res.json().header, "base64").toString("utf8");
    expect(decoded).toContain("stub");
  });

  it("requires the internal token on /sign", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      payload: validSignBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * mandateId is a TOP-LEVEL sibling of typedData. The §4 JSON example omits
   * it and the line below the refusal table adds it — the rail (A14) cannot
   * work without it, so the stub rejects a body that leaves it out.
   */
  it("400s when mandateId is missing", async () => {
    const body = validSignBody() as Record<string, unknown>;
    delete body["mandateId"];
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/mandateId/);
  });

  it("400s when requestId is missing", async () => {
    const body = validSignBody() as Record<string, unknown>;
    delete body["requestId"];
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s on an unsupported domain.chainId", async () => {
    const body = validSignBody();
    body.typedData.domain.chainId = 1;
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("UNSUPPORTED_CHAIN");
  });

  it("emits the standard error envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { "x-internal-token": TOKEN },
      payload: { requestId: "x" },
    });
    const body = res.json();
    expect(body).toHaveProperty("error.code");
    expect(body).toHaveProperty("error.message");
    expect(body).toHaveProperty("error.requestId");
    expect(typeof body.error.retryable).toBe("boolean");
  });
});
