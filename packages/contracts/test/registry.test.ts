/**
 * The published registry artefact and the refuse-on-null rule.
 *
 * These assertions used to live in chain-gateway's HTTP tests, where they broke
 * the moment the contract was deployed — they were really testing deployment
 * state, not behaviour. The rule itself ("a null address must refuse, never
 * default") is what matters and it belongs here, next to the code that enforces
 * it.
 */

import { describe, expect, it } from "vitest";
import {
  AppError,
  ErrorCode,
  MANDATE_REGISTRY_ABI,
  RegistryNotDeployedError,
  getRegistryAddress,
  getRegistryDeployBlock,
  requireRegistryAddress,
  SUPPORTED_CHAIN_IDS,
  type ChainId,
} from "../src/index";

const undeployed = SUPPORTED_CHAIN_IDS.filter((id) => getRegistryAddress(id) === null);
const deployed = SUPPORTED_CHAIN_IDS.filter((id) => getRegistryAddress(id) !== null);

describe("registry.json artefact", () => {
  it("carries the full ABI: 3 functions, 2 events, 3 custom errors", () => {
    const kinds = MANDATE_REGISTRY_ABI.reduce<Record<string, number>>((acc, e) => {
      const t = (e as { type: string }).type;
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});
    expect(kinds["function"]).toBe(3);
    expect(kinds["event"]).toBe(2);
    // Not in api-contracts.md §2 — announced additions. If this count changes,
    // Owner B and Owner C need telling before they decode a revert.
    expect(kinds["error"]).toBe(3);
  });

  it("names every function chain-gateway calls", () => {
    const names = MANDATE_REGISTRY_ABI.filter(
      (e) => (e as { type: string }).type === "function",
    ).map((e) => (e as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(["createMandate", "revoke", "get"]));
  });

  it("pairs every deployed address with a deploy block", () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      const address = getRegistryAddress(chainId);
      const block = getRegistryDeployBlock(chainId);
      if (address === null) {
        expect(block, `chain ${chainId} has an address but no deployBlock`).toBeNull();
      } else {
        expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(block, `chain ${chainId} has a deployBlock`).toBeGreaterThan(0);
      }
    }
  });
});

describe("refuse-on-null (§0)", () => {
  it("RegistryNotDeployedError is a 400 CHAIN_NOT_CONFIGURED AppError", () => {
    const err = new RegistryNotDeployedError(43114);
    // As a plain Error this escaped the Fastify handler as a 500 INTERNAL and
    // every caller had to hand-wrap it. It must stay an AppError.
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(ErrorCode.CHAIN_NOT_CONFIGURED);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/not deployed/);
  });

  it.runIf(undeployed.length > 0)(
    "requireRegistryAddress throws rather than defaulting on an undeployed chain",
    () => {
      for (const chainId of undeployed) {
        expect(() => requireRegistryAddress(chainId as ChainId)).toThrow(
          RegistryNotDeployedError,
        );
      }
    },
  );

  it.runIf(deployed.length > 0)(
    "requireRegistryAddress returns the address on a deployed chain",
    () => {
      for (const chainId of deployed) {
        expect(requireRegistryAddress(chainId as ChainId)).toMatch(
          /^0x[0-9a-fA-F]{40}$/,
        );
      }
    },
  );
});
