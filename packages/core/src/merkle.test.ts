import { describe, expect, test } from "vitest";
import { getAddress, type Address } from "viem";
import { buildRewardTree, rewardLeaf, verifyRewardProof } from "./merkle.ts";

const account = (n: number) =>
  getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;

describe("reward tree", () => {
  test("a single entry is its own root", () => {
    const tree = buildRewardTree([{ account: account(1), cumulative: 5n }]);
    expect(tree.root).toBe(rewardLeaf(account(1), 5n));
    expect(tree.proofs[account(1).toLowerCase()].proof).toEqual([]);
  });

  test.each([2, 3, 5, 8, 13])("every proof verifies with %i entries", (n) => {
    const entries = Array.from({ length: n }, (_, i) => ({
      account: account(i + 1),
      cumulative: BigInt(i + 1) * 10n ** 18n,
    }));
    const tree = buildRewardTree(entries);
    for (const e of entries) {
      const { proof, cumulative } = tree.proofs[e.account.toLowerCase()];
      expect(cumulative).toBe(e.cumulative.toString());
      expect(verifyRewardProof(tree.root, e.account, e.cumulative, proof)).toBe(
        true,
      );
      expect(
        verifyRewardProof(tree.root, e.account, e.cumulative + 1n, proof),
      ).toBe(false);
    }
  });

  test("rejects empty and duplicate inputs", () => {
    expect(() => buildRewardTree([])).toThrow();
    expect(() =>
      buildRewardTree([
        { account: account(1), cumulative: 1n },
        { account: account(1), cumulative: 2n },
      ]),
    ).toThrow("Duplicate");
  });
});
