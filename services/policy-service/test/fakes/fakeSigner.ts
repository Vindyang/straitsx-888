import type { SignResult, TypedData } from "../../src/clients/signerClient.js";

let nextResult: SignResult | null = null;
const calls: Array<{ requestId: string; mandateId: string; typedData: TypedData }> = [];

export function reset(): void {
  nextResult = null;
  calls.length = 0;
}

/** Overrides the outcome of the next `sign()` call only, then reverts to the default success. */
export function setNextResult(result: SignResult): void {
  nextResult = result;
}

export function getCalls(): Array<{ requestId: string; mandateId: string; typedData: TypedData }> {
  return calls;
}

// client-shaped export, matching src/clients/signerClient.ts
export async function sign(requestId: string, mandateId: string, typedData: TypedData): Promise<SignResult> {
  calls.push({ requestId, mandateId, typedData });
  if (nextResult) {
    const result = nextResult;
    nextResult = null;
    return result;
  }
  return {
    ok: true,
    header: "fake-header-base64",
    signerAddress: "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7",
    signedAt: new Date().toISOString(),
  };
}
