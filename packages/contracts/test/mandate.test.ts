import { describe, expect, it } from "vitest";
import { hashPolicy, type Mandate } from "../src/index";

const baseMandate: Mandate = {
  mandateId: "0x7f3a000000000000000000000000000000000000000000000000000000000000",
  owner: "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7",
  agentId: "shopper-1",
  chainId: 43113,
  asset: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
  settlementRecipient: "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8",
  maxPerCard: "30000000",
  maxPerWindow: "60000000",
  maxCardsPerWindow: 2,
  windowSeconds: 86400,
  maxAuthValiditySeconds: 120,
  expiresAt: 1786000000,
  revoked: false,
  intentConstraint: "black sneakers, size 42, <= $120",
  merchantAllowlist: ["Shop.Example", "other.example"],
  policyVersion: 1,
};

describe("hashPolicy", () => {
  it("is deterministic for an identical mandate", () => {
    expect(hashPolicy(baseMandate)).toBe(hashPolicy({ ...baseMandate }));
  });

  it("changes when intentConstraint is tampered", () => {
    const tampered: Mandate = { ...baseMandate, intentConstraint: "anything goes" };
    expect(hashPolicy(tampered)).not.toBe(hashPolicy(baseMandate));
  });

  it("changes when merchantAllowlist is tampered", () => {
    const tampered: Mandate = { ...baseMandate, merchantAllowlist: ["attacker.example"] };
    expect(hashPolicy(tampered)).not.toBe(hashPolicy(baseMandate));
  });

  it("is insensitive to address checksum casing and merchant-domain casing", () => {
    const dashboardShaped: Mandate = {
      ...baseMandate,
      owner: baseMandate.owner.toLowerCase(),
      asset: `0x${baseMandate.asset.slice(2).toUpperCase()}`,
      merchantAllowlist: ["SHOP.EXAMPLE", "Other.Example"],
    };
    expect(hashPolicy(dashboardShaped)).toBe(hashPolicy(baseMandate));
  });

  it("round-trips through a JSON wire hop (dashboard -> policy-service)", () => {
    const wireShaped = JSON.parse(JSON.stringify(baseMandate)) as Mandate;
    expect(hashPolicy(wireShaped)).toBe(hashPolicy(baseMandate));
  });
});
