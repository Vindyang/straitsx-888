/**
 * signer-service — the real signer (A11–A14), replacing the A1 stub.
 *
 * Deliberately dumb. Holds the only key. Accepts calls from policy-service and
 * NOTHING else, enforced at the network layer (A15), not by a check in here.
 *
 * It derives the paying address from the key source at boot (A11), signs via
 * the KeySource seam (KMS or Local), enforces the seven hard-invariant rail
 * refusals (A14), asserts the live challenge matches the expected constants
 * (A12), and returns the real api-contracts.md §4 shape. There is no stub flag
 * and no dummy header — this is the real thing.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  AppError,
  ErrorCode,
  isoSeconds,
  parseAddress,
  parseBytes32,
  parseChainId,
  parseMandateId,
  parseUint,
  registerErrorHandler,
  registerInternalAuth,
  requireObject,
  type Hex,
  type SignResponse,
} from "@straitsx/contracts";
import { hexToBytes, type Address } from "viem";
import type { KeySource } from "./keys/key-source";
import {
  checkRail,
  parsePinnedMandates,
  throwRailRefusal,
  type RailConfig,
} from "./sign/rail";
import {
  assertDomainMatches,
  buildTransferWithAuthorizationTypedData,
  digestTypedData,
  type BuildTypedDataInput,
  type ExpectedDomain,
} from "./sign/typed-data";
import { signDigestWithKeySource } from "./sign/pipeline";

export type BuildSignerAppOptions = {
  internalToken: string | undefined;
  chainId: number;
  keySource: KeySource;
  /** The derived paying address (EXPECTED_SIGNER_ADDRESS), checksummed. */
  signerAddress: Address;
  /** Expected on-chain constants a live challenge must match (A12). */
  expectedDomain: ExpectedDomain;
  /** Raw PINNED_MANDATES JSON from env. */
  pinnedMandatesJson: string | undefined;
  /** The raw KMS key id/ARN, masked before it ever reaches a response. */
  kmsKeyId: string | undefined;
  logger?: boolean;
};

/** Mask a KMS key id/ARN so only the trailing four chars are visible. The full
 *  key id must never appear in a response or log line (docs/execution_plan.md
 *  §18). */
function maskKmsKeyId(keyId: string | undefined): string | null {
  if (!keyId) return null;
  const visible = keyId.slice(-4);
  return `arn:aws:kms:…:key/****${visible}`;
}

function parseSignBody(body: unknown): {
  requestId: string;
  mandateId: Hex;
  typedData: BuildTypedDataInput;
} {
  const obj = requireObject(body);

  const requestId = obj["requestId"];
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw AppError.badRequest("requestId is required");
  }

  const mandateId = parseMandateId(obj["mandateId"]);

  const typedData = requireObject(obj["typedData"], "typedData");
  const domain = requireObject(typedData["domain"], "typedData.domain");
  const message = requireObject(typedData["message"], "typedData.message");

  const from = parseAddress(message["from"], "typedData.message.from");
  const to = parseAddress(message["to"], "typedData.message.to");
  const value = parseUint(message["value"], "typedData.message.value");
  const validAfter = requireNumber(
    message["validAfter"],
    "typedData.message.validAfter",
  );
  const validBefore = requireNumber(
    message["validBefore"],
    "typedData.message.validBefore",
  );
  const nonce = parseBytes32(message["nonce"], "typedData.message.nonce");

  const name = requireString(domain["name"], "typedData.domain.name");
  const version = requireString(domain["version"], "typedData.domain.version");
  const chainId = parseChainId(domain["chainId"]);
  const verifyingContract = parseAddress(
    domain["verifyingContract"],
    "typedData.domain.verifyingContract",
  );

  return {
    requestId,
    mandateId,
    typedData: {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
      domain: { name, version, chainId, verifyingContract },
    },
  };
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw AppError.badRequest(`${field} must be a non-empty string`);
  }
  return v;
}

function requireNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw AppError.badRequest(`${field} must be a finite number`);
  }
  return v;
}

export function buildSignerApp(opts: BuildSignerAppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    requestIdHeader: "x-request-id",
  });

  registerErrorHandler(app);
  registerInternalAuth(app, opts.internalToken);

  const pinned = parsePinnedMandates(opts.pinnedMandatesJson);
  const seenRequestIds = new Set<string>();
  const signerAddressLower = opts.signerAddress.toLowerCase() as Hex;

  app.get("/health", async () => ({
    ok: true,
    derivedAddress: opts.signerAddress,
    kmsKeyId: maskKmsKeyId(opts.kmsKeyId),
    chainId: opts.chainId,
  }));

  app.post("/sign", async (req) => {
    const { requestId, mandateId, typedData } = parseSignBody(req.body);

    // 1. The hard-invariant rail (A14) — before any domain work or signing.
    const railConfig: RailConfig = {
      pinned,
      signerAddress: signerAddressLower,
      chainId: opts.chainId,
      hasSeenRequestId: (id) => seenRequestIds.has(id),
    };
    const railResult = checkRail(
      {
        mandateId,
        from: typedData.from as Hex,
        to: typedData.to as Hex,
        value: BigInt(typedData.value),
        validAfter: typedData.validAfter,
        validBefore: typedData.validBefore,
        chainId: typedData.domain.chainId,
      },
      requestId,
      railConfig,
    );
    if (!railResult.ok) throwRailRefusal(railResult);

    // 2. Assert the live challenge matches the expected constants (A12).
    assertDomainMatches(typedData.domain, opts.expectedDomain);

    // 3. Build typed data, digest, sign via the key source (A13).
    const fullTypedData = buildTransferWithAuthorizationTypedData(typedData);
    const digest = digestTypedData(fullTypedData);
    const result = await signDigestWithKeySource(
      opts.keySource,
      hexToBytes(digest),
      opts.signerAddress,
      fullTypedData,
    );

    // 4. Mark the requestId as seen (replay guard) AFTER a successful sign.
    seenRequestIds.add(requestId);

    const response: SignResponse = {
      requestId,
      header: result.header,
      signature: result.signature,
      signerAddress: result.signerAddress,
      signedAt: isoSeconds(),
    };
    return response;
  });

  app.post("/sign/*", async () => {
    throw new AppError(404, ErrorCode.NOT_FOUND, "unknown signer route");
  });

  return app;
}
