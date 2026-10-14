import {
  concat,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";

/** Leaf format of StrataDistributor: double-hashed (account, cumulative). */
export function rewardLeaf(account: Address, cumulative: bigint): Hex {
  return keccak256(
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [account, cumulative],
      ),
    ),
  );
}

/** OpenZeppelin MerkleProof commutative pair hash. */
function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b)
    ? keccak256(concat([a, b]))
    : keccak256(concat([b, a]));
}

export interface RewardTree {
  root: Hex;
  /** Keyed by lowercase account. */
  proofs: Record<string, { cumulative: string; proof: Hex[] }>;
}

export function buildRewardTree(
  entries: { account: Address; cumulative: bigint }[],
): RewardTree {
  if (!entries.length)
    throw new Error("A reward tree needs at least one entry");
  if (
    new Set(entries.map((e) => e.account.toLowerCase())).size !== entries.length
  )
    throw new Error("Duplicate reward account");
  const leaves = entries
    .map((e) => ({ ...e, leaf: rewardLeaf(e.account, e.cumulative) }))
    .sort((a, b) => (BigInt(a.leaf) < BigInt(b.leaf) ? -1 : 1));
  const layers: Hex[][] = [leaves.map((l) => l.leaf)];
  while (layers[layers.length - 1].length > 1) {
    const level = layers[layers.length - 1];
    const next: Hex[] = [];
    // An unpaired node moves up unchanged; its proof simply skips that level.
    for (let i = 0; i < level.length; i += 2)
      next.push(
        i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i],
      );
    layers.push(next);
  }
  const proofs: RewardTree["proofs"] = {};
  leaves.forEach((entry, start) => {
    const proof: Hex[] = [];
    let index = start;
    for (const level of layers.slice(0, -1)) {
      const sibling = index ^ 1;
      if (sibling < level.length) proof.push(level[sibling]);
      index = Math.floor(index / 2);
    }
    proofs[entry.account.toLowerCase()] = {
      cumulative: entry.cumulative.toString(),
      proof,
    };
  });
  return { root: layers[layers.length - 1][0], proofs };
}

export function verifyRewardProof(
  root: Hex,
  account: Address,
  cumulative: bigint,
  proof: Hex[],
) {
  return proof.reduce(hashPair, rewardLeaf(account, cumulative)) === root;
}
