import type { FastifyInstance } from "fastify";
import { AppError, ErrorCode } from "@straitsx/contracts";
import { assertCheckoutDomain } from "../post-issuance/assert-checkout-domain";
import { getRun } from "../run/store";

/**
 * C9 — api-contracts.md §8 `POST /checkout/assert`. Post-issuance control:
 * before a browser automation layer fills the card, it confirms the page it's
 * actually on matches what discovery resolved for this run.
 */
export function registerCheckoutRoutes(app: FastifyInstance): void {
  app.post("/checkout/assert", async (request, reply) => {
    const { requestId, currentUrl } = request.body as { requestId?: string; currentUrl?: string };
    if (!requestId || !currentUrl) {
      throw AppError.badRequest("requestId and currentUrl are required");
    }
    const run = getRun(requestId);
    if (!run?.resolvedItem) {
      throw AppError.notFound(ErrorCode.RUN_NOT_FOUND, `no discovered item for run ${requestId}`);
    }

    const result = assertCheckoutDomain({
      currentUrl,
      matchedCheckoutUrl: run.resolvedItem.checkoutUrl,
      matchedDomain: run.resolvedItem.merchantDomain,
    });

    if (!result.allowed) {
      throw new AppError(403, ErrorCode.DOMAIN_MISMATCH, "current page does not match the discovered checkout URL");
    }
    reply.send({ allowed: true, merchantDomain: result.merchantDomain, matchedAgainst: result.matchedAgainst });
  });
}
