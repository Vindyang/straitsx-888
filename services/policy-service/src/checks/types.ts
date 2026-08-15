import type { Address, Hex, Mandate, Uint, X402Requirements } from "@straitsx/contracts";

/** On-chain mandate state as read through chain-gateway. `null` means "absent" (check 1). */
export type RegistryMandate = {
  owner: Address;
  policyHash: Hex;
  expiresAt: number;
  revoked: boolean;
};

/**
 * Everything a check needs, pre-loaded by the pipeline (B10). Checks are pure functions over
 * this object — no I/O, no env reads, no clock reads — so they stay independently unit-testable
 * per api-contracts.md §6 and owner-b-tasks.md B10-B19.
 */
export type CheckContext = {
  now: number; // unix seconds
  mandate: Mandate;
  registry: RegistryMandate | null;
  challenge: X402Requirements;
  requestedAmount: Uint;
  windowUsage: { spent: Uint; cardCount: number };
  intentCreatedAt: string; // ISO-8601
  challengeAttachedAt: string | null; // ISO-8601
  maxSaneValiditySeconds: number; // check 7's ceiling; ops-measured, not a protocol constant
};

export type CheckFailure =
  | { outcome: "refuse"; check: string; detail: string }
  | { outcome: "escalate"; check: string; reason: string; detail: string };

export type CheckFn = (ctx: CheckContext) => CheckFailure | null;

export function refuse(check: string, detail: string): CheckFailure {
  return { outcome: "refuse", check, detail };
}

export function escalate(check: string, reason: string, detail: string): CheckFailure {
  return { outcome: "escalate", check, reason, detail };
}
