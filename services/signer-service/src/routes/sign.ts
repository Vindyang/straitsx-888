/**
 * `POST /sign` — the only endpoint that produces a signature (api-contracts.md §4).
 *
 * Order of operations is load-bearing and does not change:
 *
 *   1. the seven hard-invariant rail refusals (A14) — BEFORE any domain work or
 *      any call to KMS, so a refused request never touches the key
 *   2. the challenge-vs-config domain assertion (A12)
 *   3. build typed data, digest, sign through the KeySource seam (A13)
 *   4. record the requestId as seen, only after a successful signature
 *
 * The rail runs first because it is the cheap, definitive refusal. Signing and
 * then discovering the request was out of envelope would mean a live
 * authorization exists for something we refused.
 */

import type { FastifyInstance } from "fastify";
import {
  AppError,
  ErrorCode,
  isoSeconds,
  parseAddress,
  parseBytes32,
  parseChainId,
  parseMandateId,
  parseUint,
  requireObject,
  X402_VERSION,
  type Hex,
  type SignResponse,
  type X402Accepted,
} from "@straitsx/contracts";
import { hexToBytes, type Address, type Hex as ViemHex } from "viem";
import type { KeySource } from "../keys/key-source";
import { checkRail, throwRailRefusal, type RailConfig } from "../sign/rail";
import {
  assertDomainMatches,
  buildTransferWithAuthorizationTypedData,
  digestTypedData,
  type BuildTypedDataInput,
  type ExpectedDomain,
} from "../sign/typed-data";
import { signDigestWithKeySource } from "../sign/pipeline";

export type SignDeps = {
  keySource: KeySource;
  signerAddress: Address;
  chainId: number;
  expectedDomain: ExpectedDomain;
  /** The immutable pinned map, parsed from env at boot — never from a request. */
  pinned: RailConfig["pinned"];
};

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

export function parseSignBody(body: unknown): {
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

  // REQUIRED. The facilitator reads `accepted.amount` and has no other source
  // for it; omitting it produced `cannot parse payment amount: invalid atomic
  // amount ""` at checkpoint 2, so refuse here rather than emit a header that
  // cannot settle.
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

export function registerSignRoute(app: FastifyInstance, deps: SignDeps): void {
  // Per-process replay set. The rail's SIGNER_REPLAY refusal reads it and the
  // handler writes it only after a signature exists.
  const seenRequestIds = new Set<string>();
  const signerAddressLower = deps.signerAddress.toLowerCase() as Hex;

  app.post("/sign", async (req) => {
    const { requestId, mandateId, typedData, accepted, resource, x402Version } =
      parseSignBody(req.body);

    // 1. The hard-invariant rail (A14) — before any domain work or signing.
    const railConfig: RailConfig = {
      pinned: deps.pinned,
      signerAddress: signerAddressLower,
      chainId: deps.chainId,
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
    assertDomainMatches(typedData.domain, deps.expectedDomain);

    // 3. Build typed data, digest, sign via the key source (A13).
    const fullTypedData = buildTransferWithAuthorizationTypedData(typedData);
    const digest = digestTypedData(fullTypedData);
    const result = await signDigestWithKeySource(
      deps.keySource,
      hexToBytes(digest),
      deps.signerAddress,
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

  // A wrong path under /sign must 404 with NOT_FOUND rather than fall through
  // to the catch-all as a 400 — Owner B branches on `code` (§0 status ladder).
  app.post("/sign/*", async () => {
    throw new AppError(404, ErrorCode.NOT_FOUND, "unknown signer route");
  });
}
