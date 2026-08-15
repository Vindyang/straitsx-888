import type { Hex } from "./mandate.js";

export type Decision =
  | { status: "signed"; header: string; nonce: Hex; validAfter: number; validBefore: number }
  | { status: "refused"; check: string; detail: string }
  | { status: "escalated"; approvalUrl: string; expiresAt: number };
