/**
 * Shared Fastify plumbing so both services emit the SAME error envelope and
 * enforce the SAME internal auth. Owner B parses one shape, not two.
 *
 * Source: docs/api-contracts.md §0 (error envelope, status ladder, internal auth).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError, ErrorCode } from "./errors";

/** Paths that skip `X-Internal-Token`. Health must answer an unauthenticated
 *  probe — A15's isolation test asserts the CONNECTION is refused, and a 401
 *  would prove the opposite (that the port was reachable). */
const PUBLIC_PATHS = new Set(["/health"]);

export function registerInternalAuth(
  app: FastifyInstance,
  expectedToken: string | undefined,
): void {
  app.addHook("onRequest", async (req: FastifyRequest) => {
    if (PUBLIC_PATHS.has(req.url.split("?")[0] ?? req.url)) return;
    // An unset token means "not configured" — fail closed, never open.
    if (!expectedToken) {
      throw new AppError(
        401,
        ErrorCode.UNAUTHORIZED,
        "INTERNAL_TOKEN is not configured on this service",
      );
    }
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !timingSafeEqual(provided, expectedToken)) {
      throw AppError.unauthorized();
    }
  });
}

/** Constant-time compare so the token can't be recovered byte-by-byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** `requestId` is the idempotency key across every service (§0), so echo the
 *  caller's when present rather than inventing a second identity for the same
 *  request. */
export function resolveRequestId(req: FastifyRequest): string {
  const header = req.headers["x-request-id"];
  if (typeof header === "string" && header.length > 0) return header;
  const body = req.body as { requestId?: unknown } | undefined;
  if (body && typeof body.requestId === "string" && body.requestId.length > 0) {
    return body.requestId;
  }
  return req.id;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (err: unknown, req: FastifyRequest, reply: FastifyReply) => {
      const requestId = resolveRequestId(req);

      if (err instanceof AppError) {
        reply.status(err.statusCode).send(err.toEnvelope(requestId));
        return;
      }

      // Fastify's own validation/parse failures arrive with a statusCode.
      const maybe = err as { statusCode?: number; message?: string };
      if (typeof maybe.statusCode === "number" && maybe.statusCode < 500) {
        reply.status(maybe.statusCode).send({
          error: {
            code: ErrorCode.BAD_REQUEST,
            message: maybe.message ?? "bad request",
            requestId,
            retryable: false,
          },
        });
        return;
      }

      // Unexpected. Log the real cause server-side; return nothing revealing.
      req.log.error({ err }, "unhandled error");
      reply.status(500).send({
        error: {
          code: ErrorCode.INTERNAL,
          message: "internal error",
          requestId,
          retryable: false,
        },
      });
    },
  );

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send({
      error: {
        // 404 with code BAD_REQUEST would be a contract lie: §0 pins 400 to
        // validation and 404 to an unknown id, and Owner B parses `code`.
        code: ErrorCode.NOT_FOUND,
        message: `no route for ${req.method} ${req.url}`,
        requestId: resolveRequestId(req),
        retryable: false,
      },
    });
  });
}

/** Reads a required env var, or throws at boot. Fail at startup, not at the
 *  first request — a misconfigured signer must never reach a signing path. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`missing required env var ${name}`);
  }
  return v;
}

export function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env var ${name} is not a number: ${v}`);
  return n;
}
