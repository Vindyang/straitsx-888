import type { FastifyReply } from "fastify";

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
  retryable = false,
): void {
  reply.code(statusCode).send({ error: { code, message, requestId, retryable } });
}
