import { describe, it, expect, vi } from "vitest";
import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  oraclePolicyId,
  parseOracleProof,
  prepareOracleProof,
  recheckOracleProof,
  oracleProofSchema,
} from "./oracle-proof.ts";
import type { Manifest } from "./types.ts";
import type { Evidence } from "./hermes.ts";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const feed = `0x${"ab".repeat(32)}` as Hex,
  blockHash = `0x${"cd".repeat(32)}` as Hex;
const manifest = {
  chainId: 31337,
  oracleMode: "pyth",
  engine: addr(1),
  oracle: addr(2),
  assetId: feed,
  series: [{ id: 1, expiry: 1000, token: addr(4) }],
} as Manifest;
const evidence: Evidence = {
  updates: ["0xdeadbeef"],
  feed,
  price: "103000000",
  confidence: "2000000",
  exponent: -8,
  publishTime: 1001,
  previousPublishTime: 999,
};
function fixture({
  fee = 7n,
  finalized = 0n,
  mismatch = false,
  reorg = false,
  confidence = 2000000n,
}: {
  fee?: bigint;
  finalized?: bigint;
  mismatch?: boolean;
  reorg?: boolean;
  confidence?: bigint;
} = {}) {
  let blocks = 0;
  const simulated = vi.fn(async (request: any) => {
    if (request.functionName === "finalize") return { result: 103000000n };
    if (request.functionName === "updatePriceFeeds")
      return { result: undefined };
    return {
      result: [
        {
          id: feed,
          price: {
            price: mismatch ? 104000000n : 103000000n,
            conf: confidence,
            expo: -8,
            publishTime: 1001n,
          },
        },
      ],
    };
  });
  const client = {
    getChainId: async () => 31337,
    getBlockNumber: async () => 10n,
    getBlock: async () => ({
      number: 10n,
      timestamp: 1100n,
      hash: reorg && ++blocks > 1 ? `0x${"ef".repeat(32)}` : blockHash,
    }),
    getCode: async () => "0x6000",
    readContract: async (r: any) => {
      switch (r.functionName) {
        case "oracle":
          return manifest.oracle;
        case "pyth":
          return addr(3);
        case "POLICY_ID":
          return oraclePolicyId;
        case "maxPriceAge":
          return 300n;
        case "getSeries":
          return { asset: feed, expiry: 1000n, token: addr(4) };
        case "settlementPrice":
          return finalized;
        case "getUpdateFee":
          return fee;
        default:
          throw new Error("Unexpected read " + r.functionName);
      }
    },
    simulateContract: simulated,
  } as unknown as PublicClient;
  return { client, simulated };
}
describe("oracle proof packages (synthetic client fixtures, not Pyth authentication)", () => {
  it("returns validation failures for malformed numeric fields instead of throwing conversion errors", async () => {
    const proof = await prepareOracleProof(
      fixture().client,
      manifest,
      evidence,
      addr(5),
      1000,
    );
    for (const value of ["invalid", "", "-1", "1.2", "1e9", "9".repeat(1000)]) {
      for (const field of [
        "publishedAt",
        "rawPrice",
        "confidence",
        "normalizedPrice",
      ])
        expect(
          oracleProofSchema.safeParse({
            ...proof,
            observation: { ...proof.observation, [field]: value },
          }).success,
        ).toBe(false);
      expect(
        oracleProofSchema.safeParse({ ...proof, maxFee: value }).success,
      ).toBe(false);
      for (const field of ["blockNumber", "blockTimestamp"])
        expect(
          oracleProofSchema.safeParse({
            ...proof,
            verification: { ...proof.verification, [field]: value },
          }).success,
        ).toBe(false);
    }
  });
  it("binds the reviewed package and checks both unique parsing and adapter finalization", async () => {
    const { client, simulated } = fixture();
    const proof = await prepareOracleProof(
      client,
      manifest,
      evidence,
      addr(5),
      1000,
    );
    expect(proof.observation.confidence).toBe("2000000");
    expect(proof.observation.proofHash).toBe(
      keccak256(encodeAbiParameters([{ type: "bytes[]" }], [evidence.updates])),
    );
    expect(simulated.mock.calls.map(([r]) => r.functionName)).toEqual([
      "parsePriceFeedUpdatesUnique",
      "finalize",
    ]);
    expect(
      simulated.mock.calls.every(
        ([r]) => r.value === 7n && r.blockNumber === 10n,
      ),
    ).toBe(true);
    expect(parseOracleProof(proof, manifest)).toEqual(proof);
    await expect(
      recheckOracleProof(client, manifest, proof, addr(6)),
    ).resolves.toEqual(proof);
    for (const changed of [
      { chainId: 10143 },
      { oracle: addr(6) },
      { expiry: 1002 },
      { updates: ["0xbeef"] },
      { policyId: blockHash },
    ])
      expect(() =>
        parseOracleProof({ ...proof, ...changed }, manifest),
      ).toThrow();
  });
  it("rejects finalized references, metadata disagreement and a reorganization", async () => {
    for (const options of [
      { finalized: 1n },
      { mismatch: true },
      { reorg: true },
    ])
      await expect(
        prepareOracleProof(
          fixture(options).client,
          manifest,
          evidence,
          addr(5),
          1000,
        ),
      ).rejects.toThrow();
  });
  it("rejects tampered observations and fees above the reviewed maximum on resubmission", async () => {
    const proof = await prepareOracleProof(
      fixture().client,
      manifest,
      evidence,
      addr(5),
      1000,
    );
    await expect(
      recheckOracleProof(fixture({ fee: 8n }).client, manifest, proof, addr(5)),
    ).rejects.toThrow("fee increased");
    await expect(
      recheckOracleProof(
        fixture().client,
        manifest,
        {
          ...proof,
          observation: { ...proof.observation, normalizedPrice: "104000000" },
        },
        addr(5),
      ),
    ).rejects.toThrow("differs");
  });
  it("rejects wide live confidence even when it is acceptable for canonical settlement", async () => {
    await expect(
      prepareOracleProof(fixture().client, manifest, evidence, addr(5)),
    ).rejects.toThrow("confidence");
    expect(() => parseOracleProof({ kind: "live" }, manifest)).toThrow();
  });
  it("verifies a fresh live update and its exact payable submission without unique expiry parsing", async () => {
    const { client, simulated } = fixture({ confidence: 100000n });
    const proof = await prepareOracleProof(
      client,
      manifest,
      { ...evidence, confidence: "100000" },
      addr(5),
    );
    expect(proof.kind).toBe("live");
    expect(proof.expiry).toBeNull();
    expect(simulated.mock.calls.map(([r]) => r.functionName)).toEqual([
      "parsePriceFeedUpdates",
      "updatePriceFeeds",
    ]);
    expect(simulated.mock.calls[0][0].args.slice(2)).toEqual([800n, 1100n]);
    expect(simulated.mock.calls[1][0]).toMatchObject({
      address: addr(3),
      value: 7n,
      blockNumber: 10n,
    });
    expect(() =>
      parseOracleProof(
        {
          ...proof,
          observation: {
            ...proof.observation,
            rawPrice: "9223372036854775808",
          },
        },
        manifest,
      ),
    ).toThrow();
  });
});
