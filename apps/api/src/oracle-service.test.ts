import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";

const f = vi.hoisted(() => {
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  return {
    root: "",
    fetch: vi.fn(),
    simulate: vi.fn(),
    address,
    manifest: {
      chainId: 31337,
      engine: address(1),
      oracle: address(2),
      oracleMode: "pyth",
      assetId: `0x${"aa".repeat(32)}`,
      series: [{ id: 1, expiry: 1000, token: address(4) }],
    },
  };
});
vi.mock("../../../packages/core/src/hermes.ts", () => ({
  fetchEvidence: f.fetch,
}));
vi.mock("./runtime.ts", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { oraclePolicyId } =
    await import("../../../packages/core/src/oracle-proof.ts");
  f.root = mkdtempSync(resolve(tmpdir(), "strata-oracle-service-"));
  return {
    root: f.root,
    runtimeDirectory: resolve(f.root, ".runtime"),
    manifest: f.manifest,
    client: {
      getChainId: async () => 31337,
      getBlockNumber: async () => 10n,
      getBlock: async () => ({
        number: 10n,
        timestamp: 1100n,
        hash: `0x${"bb".repeat(32)}`,
      }),
      getCode: async () => "0x6000",
      simulateContract: f.simulate,
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "oracle":
            return f.manifest.oracle;
          case "pyth":
            return f.address(3);
          case "POLICY_ID":
            return oraclePolicyId;
          case "maxPriceAge":
            return 300n;
          case "getSeries":
            return {
              asset: f.manifest.assetId,
              expiry: 1000n,
              token: f.address(4),
            };
          case "settlementPrice":
            return 0n;
          case "getUpdateFee":
            return 7n;
          default:
            throw new Error("Unexpected fixture read");
        }
      },
    },
  };
});
import {
  archiveProof,
  archivedProof,
  oracleServiceStatus,
  prepareFromProvider,
} from "./oracle-service.ts";
const evidence = {
  updates: ["0xdeadbeef"],
  feed: f.manifest.assetId,
  price: "103000000",
  confidence: "2000000",
  exponent: -8,
  publishTime: 1001,
};
beforeEach(() => {
  vi.stubEnv("PYTH_API_KEY", "unit-test-credential");
  vi.stubEnv("HERMES_URL", "https://primary.invalid");
  vi.stubEnv("HERMES_BACKUP_URL", "https://backup.invalid");
  vi.stubEnv("PYTH_BACKUP_API_KEY", "unit-test-backup-credential");
  f.fetch.mockReset().mockResolvedValue(evidence);
  f.simulate.mockReset().mockImplementation(async ({ functionName }) =>
    functionName === "finalize"
      ? { result: 103000000n }
      : {
          result: [
            {
              id: f.manifest.assetId,
              price: {
                price: 103000000n,
                conf: 2000000n,
                expo: -8,
                publishTime: 1001n,
              },
            },
          ],
        },
  );
  rmSync(f.root, { recursive: true, force: true });
  mkdirSync(f.root);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(f.root, { recursive: true, force: true }));
describe("oracle retrieval/archive service with synthetic provider and RPC fixtures, not Pyth authentication", () => {
  it("falls back after primary failure and retains only the bound package with private file permissions", async () => {
    f.fetch.mockRejectedValueOnce(
      new Error("Bearer unit-test-credential provider failure"),
    );
    const proof = await prepareFromProvider(
      "settlement",
      1000,
      f.address(5) as Address,
    );
    expect(f.fetch.mock.calls.map(([p]) => p.endpoint)).toEqual([
      "https://primary.invalid",
      "https://backup.invalid",
    ]);
    expect(
      await archivedProof("settlement", 1000, proof.observation.proofHash),
    ).toEqual(proof);
    const directory = resolve(
      f.root,
      ".runtime/oracle-proofs/31337",
      f.manifest.oracle,
    );
    expect(readdirSync(directory)).toHaveLength(1);
    const path = resolve(directory, readdirSync(directory)[0]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("credential");
    expect(text).not.toContain("primary.invalid");
    await expect(
      archivedProof("settlement", 1000, "../../escape" as Hex),
    ).rejects.toThrow("Invalid archive key");
    await expect(archiveProof({ ...proof, chainId: 10143 })).rejects.toThrow(
      "different deployment",
    );
  });
  it("rejects primary verification failure and checks backup evidence before archiving", async () => {
    f.simulate.mockRejectedValueOnce(new Error("invalid proof"));
    const proof = await prepareFromProvider(
      "settlement",
      1000,
      f.address(5) as Address,
    );
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.simulate.mock.calls.map(([r]) => r.functionName)).toEqual([
      "parsePriceFeedUpdatesUnique",
      "parsePriceFeedUpdatesUnique",
      "finalize",
    ]);
    expect(
      await archivedProof("settlement", 1000, proof.observation.proofHash),
    ).toEqual(proof);
  });
  it("returns a generic failure for exhausted providers and does not report credentials", async () => {
    f.fetch.mockRejectedValue(
      new Error(
        "Bearer unit-test-credential from https://private.invalid/token",
      ),
    );
    await expect(
      prepareFromProvider("settlement", 1000, f.address(5) as Address),
    ).rejects.toThrow("Verified oracle evidence is unavailable");
    expect(readdirSync(f.root)).toEqual([]);
    expect(oracleServiceStatus()).toMatchObject({
      providerConfigured: true,
      backupConfigured: true,
    });
    expect(JSON.stringify(oracleServiceStatus())).not.toContain("credential");
    vi.stubEnv("PYTH_API_KEY", "");
    await expect(
      prepareFromProvider("settlement", 1000, f.address(5) as Address),
    ).rejects.toThrow("not configured");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("coalesces identical requests and bounds concurrent provider work", async () => {
    const release: Array<(value: typeof evidence) => void> = [];
    f.fetch.mockImplementation(
      () => new Promise((resolve) => release.push(resolve)),
    );
    const first = prepareFromProvider(
      "settlement",
      1000,
      f.address(5) as Address,
    );
    const duplicate = prepareFromProvider(
      "settlement",
      1000,
      f.address(5) as Address,
    );
    const others = [6, 7, 8].map((n) =>
      prepareFromProvider("settlement", 1000, f.address(n) as Address),
    );
    await expect(
      prepareFromProvider("settlement", 1000, f.address(9) as Address),
    ).rejects.toThrow("busy");
    expect(f.fetch).toHaveBeenCalledTimes(4);
    for (const resolve of release) resolve(evidence);
    const [a, b] = await Promise.all([first, duplicate, ...others]);
    expect(a).toBe(b);
    f.fetch.mockResolvedValue(evidence);
    await expect(
      prepareFromProvider("settlement", 1000, f.address(9) as Address),
    ).resolves.toMatchObject({ kind: "settlement" });
  });
});
