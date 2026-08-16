import "server-only";
import type { Mandate } from "@straitsx/contracts";

/**
 * In-memory tracking of mandates created through this dashboard instance —
 * same "map for the weekend" scope as ledger-service's store.ts
 * (docs/conventions.md). There is no ledger-service "list all mandates"
 * endpoint (only GET /policy/:mandateId keyed by a known id), so the
 * dashboard is the only place that knows which mandateIds exist at all; this
 * resets on server restart, by design, not oversight.
 */

export type TrackedMandate = {
  mandate: Mandate;
  /** True once the createMandate tx has been mined AND the policy body has
   *  been PUT to policy-service (see app/api/mandates/[mandateId]/confirm). */
  confirmed: boolean;
  stagedAt: string;
};

const tracked = new Map<string, TrackedMandate>();

export function stageMandate(mandate: Mandate): void {
  tracked.set(mandate.mandateId, { mandate, confirmed: false, stagedAt: new Date().toISOString() });
}

export function markConfirmed(mandateId: string): void {
  const entry = tracked.get(mandateId);
  if (entry) entry.confirmed = true;
}

export function getTrackedMandate(mandateId: string): TrackedMandate | undefined {
  return tracked.get(mandateId);
}

export function listTrackedMandates(): TrackedMandate[] {
  return [...tracked.values()].sort((a, b) => b.stagedAt.localeCompare(a.stagedAt));
}
