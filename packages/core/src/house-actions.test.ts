import { describe, expect, test } from "vitest";
import type { Address } from "viem";
import type { Manifest } from "./types.ts";
import { houseSteps, isHouseAction } from "./house-actions.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const manifest = {
  usdc: a(1),
  house: {
    vault: a(2),
    strata: a(3),
    staking: a(4),
    distributor: a(5),
    operator: a(6),
    launchTime: 2,
    genesisStart: 1,
    deployedBlock: "1",
  },
} as unknown as Manifest;
const user = a(9);

describe("houseSteps", () => {
  test("deposits approve exact USDC then deposit", () => {
    const steps = houseSteps(
      manifest,
      { action: "house-deposit", amount: "12.5" },
      user,
    );
    expect(steps[0]).toEqual({
      kind: "approve",
      token: a(1),
      spender: a(2),
      amount: 12_500_000n,
    });
    expect(steps[1]).toMatchObject({
      kind: "call",
      functionName: "deposit",
      args: [12_500_000n],
    });
  });

  test("staking uses 18 decimals and approves the staking contract", () => {
    const steps = houseSteps(
      manifest,
      { action: "strata-stake", amount: "2" },
      user,
    );
    expect(steps[0]).toMatchObject({
      token: a(3),
      spender: a(4),
      amount: 2n * 10n ** 18n,
    });
    expect(steps[1]).toMatchObject({ address: a(4), functionName: "stake" });
  });

  test("claims pass the published proof and stake choice", () => {
    const steps = houseSteps(
      manifest,
      {
        action: "rewards-claim",
        stake: true,
        claim: { cumulative: "7", proof: [] },
      },
      user,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      address: a(5),
      args: [user, 7n, [], true],
    });
  });

  test("rejects missing amounts, missing claims and missing vaults", () => {
    expect(() =>
      houseSteps(manifest, { action: "house-deposit", amount: "0" }, user),
    ).toThrow("positive");
    expect(() =>
      houseSteps(manifest, { action: "rewards-claim" }, user),
    ).toThrow("No published");
    expect(() =>
      houseSteps(
        { ...manifest, house: undefined },
        { action: "house-redeem" },
        user,
      ),
    ).toThrow("no house vault");
  });

  test("recognizes house actions", () => {
    expect(isHouseAction("house-deposit")).toBe(true);
    expect(isHouseAction("trade")).toBe(false);
  });
});
