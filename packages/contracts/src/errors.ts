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
  NOT_FOUND: "NOT_FOUND", // 404 unknown route
  INTERNAL: "INTERNAL", // 500

  // chain-gateway
  UNSUPPORTED_CHAIN: "UNSUPPORTED_CHAIN", // 400
  MANDATE_NOT_FOUND: "MANDATE_NOT_FOUND", // 404 (owner == address(0))
  TX_NOT_FOUND: "TX_NOT_FOUND", // 404
  RPC_FAILED: "RPC_FAILED", // 502, retryable
  RPC_TIMEOUT: "RPC_TIMEOUT", // 504, retryable
  CHAIN_NOT_CONFIGURED: "CHAIN_NOT_CONFIGURED", // 400 — a null constant, refuse never default
  /** XSGD did not report 6 decimals. NOT an RPC failure: retrying never fixes
   *  it, so it must not carry `retryable: true`. */
  TOKEN_DECIMALS_INVALID: "TOKEN_DECIMALS_INVALID", // 500
  /** The 402 challenge could not be parsed into X402Requirements. */
  X402_MALFORMED: "X402_MALFORMED", // 400

  // signer-service hard-invariant rail (api-contracts.md §4, task A14)
  SIGNER_UNPINNED_MANDATE: "SIGNER_UNPINNED_MANDATE", // 403
  SIGNER_WRONG_RECIPIENT: "SIGNER_WRONG_RECIPIENT", // 403
  SIGNER_CEILING: "SIGNER_CEILING", // 403
  SIGNER_WRONG_FROM: "SIGNER_WRONG_FROM", // 403
  SIGNER_WRONG_CHAIN: "SIGNER_WRONG_CHAIN", // 403
  SIGNER_WINDOW: "SIGNER_WINDOW", // 403
  SIGNER_REPLAY: "SIGNER_REPLAY", // 409
  /**
   * NOT an eighth rail condition. §4 says the seven refusals above are "the
   * only conditions it evaluates", and this does not contradict that: A12
   * separately requires "Assert the live challenge matches the expected
   * constants; refuse on mismatch", and §19.4 says a live 402 that disagrees
   * with the pinned constants is "either a chain misconfiguration or an
   * attack". It is a fixed assertion, not a judgement — same category as
   * "never hardcode the domain". Announced to Owner B alongside the rail.
   */
  SIGNER_DOMAIN_MISMATCH: "SIGNER_DOMAIN_MISMATCH", // 403
  SIGNER_KMS_FAILED: "SIGNER_KMS_FAILED", // 502

  // agent-orchestrator / card-gateway (Owner C, api-contracts.md §7-8)
  RUN_NOT_FOUND: "RUN_NOT_FOUND", // 404
  /** A required remote service contract is not currently reachable. Module C
   *  is live but not ready to accept a payment run. */
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE", // 503, retryable
  /** C9 post-issuance control: current page doesn't match the discovered, intent-matched URL. */
  DOMAIN_MISMATCH: "DOMAIN_MISMATCH", // 403
  /** MCP SSE handshake or JSON-RPC call failed (transport, not payload shape). */
  MCP_UNREACHABLE: "MCP_UNREACHABLE", // 502, retryable
  /** MCP tool result did not have the expected shape (missing text block, bad JSON, etc). */
  MCP_RESULT_MALFORMED: "MCP_RESULT_MALFORMED", // 502
  /** cardapi retry with the signed header failed for a reason other than a fresh 402. */
  CARDAPI_FAILED: "CARDAPI_FAILED", // 502
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
