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
  X402_VERSION,
  type Hex,
  type SignResponse,
  type X402Accepted,
} from "@straitsx/contracts";
import { hexToBytes, type Address, type Hex as ViemHex } from "viem";
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
  /** The `accepts[]` entry from the 402 that this payment satisfies. */
  accepted: X402Accepted;
  /** The resource URL being paid for. */
  resource: string;
  x402Version: number;
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

  // The `accepts[]` entry being satisfied, passed through from the 402. This is
  // REQUIRED, not optional: the facilitator reads `accepted.amount` and has no
  // other source for it. Omitting it produced
  // `cannot parse payment amount: invalid atomic amount ""` at checkpoint 2, so
  // we refuse here rather than emit a header that cannot settle.
  const accepted = requireObject(obj["accepted"], "accepted");
  const acceptedAmount = parseUint(accepted["amount"], "accepted.amount");
  const acceptedExtra = requireObject(accepted["extra"], "accepted.extra");

  const resource = obj["resource"];
  if (typeof resource !== "string" || resource.length === 0) {
    throw AppError.badRequest("resource is required (the cardapi URL)");
  }

  const rawVersion = obj["x402Version"];
  if (rawVersion !== undefined && typeof rawVersion !== "number") {
    throw AppError.badRequest("x402Version must be a number when present");
  }

  return {
    requestId,
    mandateId,
    resource,
    accepted: {
      scheme: "exact",
      network: requireString(accepted["network"], "accepted.network"),
      chainId: parseChainId(accepted["chainId"]),
      amount: acceptedAmount,
      asset: parseAddress(accepted["asset"], "accepted.asset"),
      payTo: parseAddress(accepted["payTo"], "accepted.payTo"),
      maxTimeoutSeconds: requireNumber(
        accepted["maxTimeoutSeconds"],
        "accepted.maxTimeoutSeconds",
      ),
      extra: {
        assetTransferMethod: "eip3009",
        name: requireString(acceptedExtra["name"], "accepted.extra.name"),
        version: requireString(
          acceptedExtra["version"],
          "accepted.extra.version",
        ),
      },
    },
    x402Version: rawVersion ?? X402_VERSION,
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
    const { requestId, mandateId, typedData, accepted, resource, x402Version } =
      parseSignBody(req.body);

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
      {
        x402Version,
        resource,
        // Passed straight through from the challenge. `accepted.amount` is the
        // only place the facilitator reads the payment amount from.
        accepted,
        // value/validAfter/validBefore are STRINGS in the x402 payload, even
        // though validAfter/validBefore are numbers on the wire into /sign.
        authorization: {
          from: typedData.from as Address,
          to: typedData.to as Address,
          value: typedData.value,
          validAfter: String(typedData.validAfter),
          validBefore: String(typedData.validBefore),
          nonce: typedData.nonce as ViemHex,
        },
      },
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
