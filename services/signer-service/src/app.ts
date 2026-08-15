/**
 * signer-service — the real signer (A11–A14), replacing the A1 stub.
 *
 * Deliberately dumb. Holds the only key. Accepts calls from policy-service and
 * NOTHING else, enforced at the network layer (A15), not by a check in here.
 *
 * This file is wiring only: it builds the Fastify instance, registers the error
 * envelope and internal auth, and mounts one registrar per endpoint group
 * (conventions.md §1, §3). The behaviour lives in `routes/`, the crypto in
 * `sign/`, and the key access behind the `KeySource` seam in `keys/`.
 *
 * `buildSignerApp(opts)` returns the instance without binding a port, which is
 * what lets tests inject a LocalKeySource and drive it with `app.inject`.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  registerErrorHandler,
  registerInternalAuth,
} from "@straitsx/contracts";
import type { Address } from "viem";
import type { KeySource } from "./keys/key-source";
import { parsePinnedMandates } from "./sign/rail";
import type { ExpectedDomain } from "./sign/typed-data";
import { registerHealthRoute } from "./routes/health";
import { registerSignRoute } from "./routes/sign";

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

export function buildSignerApp(opts: BuildSignerAppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    // requestId is the idempotency key across every service (§0).
    requestIdHeader: "x-request-id",
  });

  registerErrorHandler(app);
  registerInternalAuth(app, opts.internalToken);

  // Parsed once at build time, never per request: the pinned map is immutable
  // and comes from env at boot, never from a request body (A14).
  const pinned = parsePinnedMandates(opts.pinnedMandatesJson);

  registerHealthRoute(app, {
    signerAddress: opts.signerAddress,
    kmsKeyId: opts.kmsKeyId,
    chainId: opts.chainId,
  });

  registerSignRoute(app, {
    keySource: opts.keySource,
    signerAddress: opts.signerAddress,
    chainId: opts.chainId,
    expectedDomain: opts.expectedDomain,
    pinned,
  });

  return app;
}
