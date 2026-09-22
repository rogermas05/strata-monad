import { describe, expect, it } from "vitest";
import {
  getContractAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  prepareDeploymentPackage,
  parseDeploymentIntent,
  packageDigest,
  monUsdFeed,
  type ArtifactLoader,
} from "./deployment-package.ts";
import { DemoUSDC as usdc } from "./generated/contracts.ts";
import { WrappedMON as wmon } from "./generated/contracts.ts";
import { DemoOracle as demo } from "./generated/contracts.ts";
import { PythExpiryOracle as pyth } from "./generated/contracts.ts";
import { OptionsEngine as engine } from "./generated/contracts.ts";
import { StrategyRouter as router } from "./generated/contracts.ts";
import { OracleRouter as oracleRouter } from "./generated/contracts.ts";
import { DemoSessionOracle as demoSession } from "./generated/contracts.ts";
import { PythSessionCloseOracle as pythSession } from "./generated/contracts.ts";
import { asset, newYorkTime } from "./assets.ts";
import { KuruExactAdapter as adapter } from "./generated/contracts.ts";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const abis: Record<string, unknown> = {
  DemoUSDC: usdc,
  WrappedMON: wmon,
  DemoOracle: demo,
  PythExpiryOracle: pyth,
  DemoSessionOracle: demoSession,
  PythSessionCloseOracle: pythSession,
  OracleRouter: oracleRouter,
  OptionsEngine: engine,
  StrategyRouter: router,
  KuruExactAdapter: adapter,
};
const artifacts: ArtifactLoader = (name) => ({
  abi: abis[name] as Abi,
  bytecode: "0x6000",
});
const intent = {
  version: 1,
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8551",
  deployer: addr(1),
  maker: addr(2),
  demoUser: addr(3),
  factory: addr(4),
  margin: addr(5),
  oracle: { mode: "demo", price: "1.03" },
  feed: monUsdFeed,
  maxPriceAge: 3600,
  series: [
    {
      symbol: "MON-C",
      expiry: 4000,
      kind: "call",
      strike: "1.05",
      cap: "100000000000000000000",
    },
    {
      symbol: "MON-P",
      expiry: 4000,
      kind: "put",
      strike: "1.05",
      cap: "100000000",
    },
  ],
};
function fixture({
  pending = false,
  wrongMargin = false,
  reorg = false,
  nonceDrift = false,
  timestamp = 1000n,
} = {}) {
  let blocks = 0,
    nonceReads = 0;
  return {
    getChainId: async () => 31337,
    getBlockNumber: async () => 10n,
    getBlock: async () => ({
      timestamp,
      hash: `0x${(reorg && ++blocks > 1 ? "bb" : "aa").repeat(32)}`,
    }),
    getTransactionCount: async ({ blockTag }: any) =>
      (nonceDrift && ++nonceReads > 2) || (pending && blockTag === "pending")
        ? 13
        : 12,
    getStorageAt: async () => `0x${"00".repeat(32)}`,
    getCode: async ({ address }: any) =>
      address === addr(1) ? "0x" : "0x6000",
    readContract: async ({ functionName, args }: any) => {
      if (functionName === "marginAccountAddress")
        return wrongMargin ? addr(99) : addr(5);
      if (functionName === "orderBookImplementation") return addr(6);
      if (functionName === "kuruAmmVaultImplementation") return addr(7);
      if (functionName === "computeAddress")
        return getContractAddress({ from: args[0], nonce: 1n });
      throw new Error("Unexpected fixture method");
    },
  } as unknown as PublicClient;
}
describe("unsigned deployment packages (synthetic RPC and bytecode fixtures)", () => {
  it("binds sequential CREATE nonces, internal claim tokens and exact calldata without native value", async () => {
    const pkg = await prepareDeploymentPackage(fixture(), intent, artifacts);
    expect(pkg.steps).toHaveLength(18);
    expect(pkg.steps.map((s) => s.nonce)).toEqual(
      Array.from({ length: 18 }, (_, i) => 12 + i),
    );
    expect(pkg.manifest.engine).toBe(
      getContractAddress({ from: addr(1), nonce: 19n }),
    );
    expect(pkg.manifest.series[0].token).toBe(
      getContractAddress({ from: pkg.manifest.engine, nonce: 1n }),
    );
    expect(
      pkg.steps.every((s) => s.value === "0" && s.data.startsWith("0x")),
    ).toBe(true);
    const { digest, ...body } = pkg;
    expect(packageDigest(body)).toBe(digest);
    expect(
      packageDigest(
        Object.fromEntries(Object.entries(body).reverse()) as typeof body,
      ),
    ).toBe(digest);
    expect(packageDigest({ ...body, nonceStart: 13 })).not.toBe(digest);
  });
  it("routes every asset through one oracle router with its own settlement adapter", async () => {
    // Monday 12 October 2026, 10:00 New York: SPY's week closes Friday 16:00.
    const now = newYorkTime(2026, 10, 12, 10);
    const close = newYorkTime(2026, 10, 16, 16);
    const spy = {
      symbol: "SPY-650-P",
      asset: "SPY",
      expiry: close,
      kind: "put",
      strike: "650",
      cap: "100000000000000",
    };
    const multi = {
      ...intent,
      assets: [{ key: "SPY", reference: "650", volatility: 0.18 }],
      series: [
        ...intent.series.map((s) => ({ ...s, expiry: now + 86400 })),
        spy,
      ],
    };
    const prepare = (changed: object = {}) =>
      prepareDeploymentPackage(
        fixture({ timestamp: BigInt(now) }),
        { ...multi, ...changed },
        artifacts,
      );

    const pkg = await prepare();

    const deployed = (nonce: bigint) =>
      getContractAddress({ from: addr(1), nonce });
    const [crypto, session, oracle] = [14n, 15n, 16n].map(deployed);
    expect(pkg.manifest.oracle).toBe(oracle);
    expect(pkg.manifest.assets).toMatchObject([
      { key: "MON", adapter: crypto, policy: "pyth-first-after-expiry" },
      {
        key: "SPY",
        adapter: session,
        policy: "pyth-latest-before-close",
        assetId: asset("SPY").pythFeedId,
        maxLiveAge: 120,
        challengeWindow: 7200,
        deliverable: false,
      },
    ]);
    expect(pkg.steps.filter((s) => s.label.startsWith("Bind "))).toHaveLength(
      2,
    );
    expect(pkg.manifest.series[2]).toMatchObject({ asset: "SPY", id: 3 });
    // Cash-settled series carry no underlying token.
    expect(
      pkg.steps.find((s) => s.label === "Create SPY-650-P")!.arguments[0],
    ).toBe("0x0000000000000000000000000000000000000000");
    await expect(
      prepare({ series: [{ ...spy, expiry: close - 3600 }] }),
    ).rejects.toThrow("session close");
    for (const series of [
      [{ ...spy, kind: "call" }],
      [{ ...spy, asset: "QQQ" }],
      [{ ...spy, symbol: "MON-650-P" }],
    ])
      expect(() => parseDeploymentIntent({ ...multi, series })).toThrow();
    // Candidate assets are not listed on a public network.
    expect(() =>
      parseDeploymentIntent({
        ...multi,
        chainId: 10143,
        rpcUrl: "https://testnet-rpc.monad.xyz",
        oracle: { mode: "pyth", verifier: addr(20) },
      }),
    ).toThrow();
  });
  it("can bind the primary feed to last-price settlement when first-update proofs are unavailable", async () => {
    const pkg = await prepareDeploymentPackage(
      fixture(),
      { ...intent, feedSettlement: "pyth-latest-before-close" },
      artifacts,
    );

    const session = getContractAddress({ from: addr(1), nonce: 15n });
    expect(pkg.manifest.assets![0]).toMatchObject({
      key: "MON",
      adapter: session,
      policy: "pyth-latest-before-close",
      challengeWindow: 7200,
      deliverable: true,
    });
    expect(() =>
      parseDeploymentIntent({ ...intent, feedSettlement: "anything" }),
    ).toThrow();
  });
  it("rejects duplicate canonical prices, invalid spread bounds and malformed numeric inputs", () => {
    expect(() =>
      parseDeploymentIntent({
        ...intent,
        series: [
          intent.series[0],
          { ...intent.series[0], symbol: "MON-C2", strike: "1.050" },
        ],
      }),
    ).toThrow();
    for (const price of ["invalid", "-1", "0", "1e9", "9".repeat(1000)])
      expect(() =>
        parseDeploymentIntent({
          ...intent,
          series: [{ ...intent.series[0], strike: price }],
        }),
      ).toThrow("Invalid deployment intent");
    expect(() =>
      parseDeploymentIntent({
        ...intent,
        series: [
          { ...intent.series[0], kind: "bull-spread", upperStrike: "1.00" },
        ],
      }),
    ).toThrow();
    expect(
      parseDeploymentIntent({
        ...intent,
        series: [
          {
            ...intent.series[0],
            kind: "bull-spread",
            upperStrike: "1.20",
            symbol: "MON-1.05/1.20-BULL",
          },
        ],
      }).series[0].upperStrike,
    ).toBe("1.20");
  });
  it("rejects pending nonce, changed custody and reorganized anchors", async () => {
    for (const client of [
      fixture({ pending: true }),
      fixture({ wrongMargin: true }),
      fixture({ reorg: true }),
      fixture({ nonceDrift: true }),
    ])
      await expect(
        prepareDeploymentPackage(client, intent, artifacts),
      ).rejects.toThrow();
  });
  it("keeps public native-MON plans tied to Pyth and MON/USD", () => {
    const publicIntent = {
      ...intent,
      chainId: 10143,
      rpcUrl: "https://testnet-rpc.monad.xyz",
      oracle: { mode: "pyth", verifier: addr(20) },
    };
    expect(parseDeploymentIntent(publicIntent).chainId).toBe(10143);
    expect(() =>
      parseDeploymentIntent({ ...publicIntent, oracle: intent.oracle }),
    ).toThrow();
    expect(() =>
      parseDeploymentIntent({
        ...publicIntent,
        feed: `0x${"ab".repeat(32)}` as Hex,
      }),
    ).toThrow();
    expect(() =>
      parseDeploymentIntent({ ...publicIntent, privateKey: "unit-test-key" }),
    ).toThrow();
  });
});
