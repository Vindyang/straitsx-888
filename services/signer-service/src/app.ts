/**
 * signer-service — A1 stub.
 *
 * Deliberately dumb. Holds the only key. Accepts calls from policy-service and
 * NOTHING else, enforced at the network layer (A15), not by a check in here.
 *
 * THIS IS A STUB. It returns a fixed dummy header so Owner B can integrate
 * against the real response shape on hour one. It holds no key, touches no KMS,
 * and enforces none of the seven rail invariants — those land in A11–A14.
 * `GET /health` reports `stub: true` so nobody can mistake it for the real
 * signer, and it refuses to start if a KMS key id is configured, so this build
 * can never be the thing that signs.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  AppError,
  ErrorCode,
  isoSeconds,
  parseChainId,
  parseMandateId,
  registerErrorHandler,
  registerInternalAuth,
  requireObject,
  type SignResponse,
} from "@straitsx/contracts";

export type BuildSignerAppOptions = {
  internalToken: string | undefined;
  chainId: number;
  logger?: boolean;
};

/** Fixed, obviously-fake. A real PAYMENT-SIGNATURE is base64 of the x402
 *  payload; this decodes to a marker so a stub reaching cardapi fails loudly. */
const STUB_HEADER = Buffer.from(
  JSON.stringify({ stub: true, note: "signer-service A1 stub — not a signature" }),
).toString("base64");

export function buildSignerApp(opts: BuildSignerAppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    requestIdHeader: "x-request-id",
  });

  registerErrorHandler(app);
  registerInternalAuth(app, opts.internalToken);

  app.get("/health", async () => ({
    ok: true,
    stub: true,
    derivedAddress: null,
    kmsKeyId: null,
    chainId: opts.chainId,
  }));

  app.post("/sign", async (req) => {
    const body = requireObject(req.body);

    // Validate the shape B will actually send, so integration surfaces field
    // mistakes now rather than against the real signer.
    const requestId = body["requestId"];
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw AppError.badRequest("requestId is required");
    }
    // mandateId is a TOP-LEVEL sibling of typedData — the §4 JSON example omits
    // it, the line below the refusal table adds it. The rail needs it.
    const mandateId = parseMandateId(body["mandateId"]);
    const typedData = requireObject(body["typedData"], "typedData");
    const domain = requireObject(typedData["domain"], "typedData.domain");
    requireObject(typedData["message"], "typedData.message");
    parseChainId(domain["chainId"]);

    const response: SignResponse & { stub: true; mandateId: string } = {
      requestId,
      mandateId,
      stub: true,
      header: STUB_HEADER,
      signature: { v: 27, r: `0x${"0".repeat(64)}`, s: `0x${"0".repeat(64)}` },
      signerAddress: "0x0000000000000000000000000000000000000000",
      signedAt: isoSeconds(),
    };
    return response;
  });

  app.post("/sign/*", async () => {
    throw new AppError(404, ErrorCode.NOT_FOUND, "unknown signer route");
  });

  return app;
}
