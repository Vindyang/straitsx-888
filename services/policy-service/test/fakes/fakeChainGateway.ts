import type { RegistryMandate } from "../../src/checks/types.js";

const registry = new Map<string, RegistryMandate>();

export function reset(): void {
  registry.clear();
}

export function seed(mandateId: string, record: RegistryMandate): void {
  registry.set(mandateId, record);
}

export function setRevoked(mandateId: string, revoked: boolean): void {
  const record = registry.get(mandateId);
  if (record) record.revoked = revoked;
}

// client-shaped export, matching src/clients/chainGatewayClient.ts
export async function getMandate(mandateId: string, _chainId: number): Promise<RegistryMandate | null> {
  return registry.get(mandateId) ?? null;
}
