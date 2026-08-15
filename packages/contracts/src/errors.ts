/**
 * The one error envelope, from docs/api-contracts.md §0. Every service, every
 * non-2xx response. Owner B and Owner C parse this shape.
 *
 *   { "error": { "code", "message", "requestId", "retryable" } }
 *
 * NEVER put a PAN, a private key, a KMS key id, a raw signature, or a card
 * iframe URL in an error body or a log line.
 */

export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
  };
};

/**
 * Error codes. §0 fixes the status ladder; §3 names only MANDATE_NOT_FOUND, so
 * the rest are ours and must be announced to Owner B and Owner C.
 */
export const ErrorCode = {
  // shared
  BAD_REQUEST: "BAD_REQUEST", // 400
  UNAUTHORIZED: "UNAUTHORIZED", // 401 bad X-Internal-Token
  FORBIDDEN: "FORBIDDEN", // 403 caller not allowed
  INTERNAL: "INTERNAL", // 500

  // chain-gateway
  UNSUPPORTED_CHAIN: "UNSUPPORTED_CHAIN", // 400
  MANDATE_NOT_FOUND: "MANDATE_NOT_FOUND", // 404 (owner == address(0))
  TX_NOT_FOUND: "TX_NOT_FOUND", // 404
  RPC_FAILED: "RPC_FAILED", // 502, retryable
  RPC_TIMEOUT: "RPC_TIMEOUT", // 504, retryable
  CHAIN_NOT_CONFIGURED: "CHAIN_NOT_CONFIGURED", // 400 — a null constant, refuse never default

  // signer-service hard-invariant rail (api-contracts.md §4, task A14)
  SIGNER_UNPINNED_MANDATE: "SIGNER_UNPINNED_MANDATE", // 403
  SIGNER_WRONG_RECIPIENT: "SIGNER_WRONG_RECIPIENT", // 403
  SIGNER_CEILING: "SIGNER_CEILING", // 403
  SIGNER_WRONG_FROM: "SIGNER_WRONG_FROM", // 403
  SIGNER_WRONG_CHAIN: "SIGNER_WRONG_CHAIN", // 403
  SIGNER_WINDOW: "SIGNER_WINDOW", // 403
  SIGNER_REPLAY: "SIGNER_REPLAY", // 409
  SIGNER_DOMAIN_MISMATCH: "SIGNER_DOMAIN_MISMATCH", // 403 — live challenge != expected constants
  SIGNER_KMS_FAILED: "SIGNER_KMS_FAILED", // 502
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly retryable: boolean;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        retryable: this.retryable,
      },
    };
  }

  static badRequest(message: string, code: ErrorCodeValue = ErrorCode.BAD_REQUEST) {
    return new AppError(400, code, message);
  }

  static unauthorized(message = "invalid or missing X-Internal-Token") {
    return new AppError(401, ErrorCode.UNAUTHORIZED, message);
  }

  static notFound(code: ErrorCodeValue, message: string) {
    return new AppError(404, code, message);
  }

  /** Every RPC error is retryable — see A10. */
  static rpcFailed(message: string) {
    return new AppError(502, ErrorCode.RPC_FAILED, message, true);
  }

  static rpcTimeout(message: string) {
    return new AppError(504, ErrorCode.RPC_TIMEOUT, message, true);
  }

  /** The rail. Refusals are structural invariants, not policy. */
  static signerRefusal(code: ErrorCodeValue, message: string) {
    const statusCode = code === ErrorCode.SIGNER_REPLAY ? 409 : 403;
    return new AppError(statusCode, code, message);
  }
}
