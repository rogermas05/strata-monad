import { expect, it } from "vitest";
import type { Address, PublicClient } from "viem";
import type { Manifest } from "./types.ts";
import { prepareMakerBootstrap, bootstrapDigest } from "./maker-bootstrap.ts";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const manifest = {
  chainId: 31337,
  venueMode: "kuru",
  engine: addr(1),
  oracle: addr(2),
  usdc: addr(3),
  wmon: addr(4),
  maker: addr(5),
  kuruMargin: addr(6),
  assetId: `0x${"aa".repeat(32)}`,
  deployedBlock: "1",
  series: [
    {
      id: 1,
      token: addr(7),
      market: addr(8),
      expiry: 300000,
      kind: "call",
      strike: 1,
      upperStrike: 0,
      symbol: "MON-C",
    },
    {
      id: 2,
      token: addr(9),
      market: addr(10),
      expiry: 300000,
      kind: "put",
      strike: 1,
      upperStrike: 0,
      symbol: "MON-P",
    },
  ],
} as Manifest;
function fixture(
  options: {
    stale?: boolean;
    inventory?: boolean;
    history?: boolean;
    cap?: boolean;
    native?: boolean;
    cooldown?: boolean;
  } = {},
) {
  return {
    getChainId: async () => 31337,
    getBlockNumber: async () => 10n,
    getBlock: async () => ({
      timestamp: 100000n,
      hash: `0x${"bb".repeat(32)}`,
    }),
    getTransactionCount: async () => 5,
    getBalance: async () => (options.native ? 1n : 1000n * 10n ** 18n),
    getLogs: async () => (options.history ? [{}] : []),
    readContract: async ({ functionName, args }: any) => {
      switch (functionName) {
        case "livePrice":
          return [103000000n, options.stale ? 90000n : 99999n];
        case "maxPriceAge":
          return 3600n;
        case "balanceOf":
        case "getBalance":
          return 0n;
        case "writers":
          return [options.inventory ? 1n : 0n, 0n];
        case "requiredCollateral":
          return args[0] === 1n ? args[1] : args[1] / 10n ** 12n;
        case "getSeries":
          return { cap: options.cap ? 1n : 10n ** 24n };
        case "lastFaucet":
          return options.cooldown ? 99999n : 0n;
        default:
          throw new Error("Unknown synthetic bootstrap read");
      }
    },
  } as unknown as PublicClient;
}
it("prepares exact backing, wrapping, reserves and claim deposits using synthetic reads", async () => {
  const plan = await prepareMakerBootstrap(fixture(), manifest, 90);
  expect(plan.funding.nativeWrap).toBe(String(90n * 10n ** 18n));
  expect(plan.funding.stableCollateral).toBe("90000000");
  expect(BigInt(plan.funding.stableQuotes)).toBeGreaterThan(0n);
  expect(plan.steps.filter((s) => BigInt(s.value) > 0n)).toHaveLength(1);
  expect(plan.steps.map((s) => s.nonce)).toEqual(
    Array.from({ length: plan.steps.length }, (_, i) => i + 5),
  );
  expect(
    plan.markets.every(
      (m) => m.askLots.reduce((a, b) => a + BigInt(b), 0n) === 90000n,
    ),
  ).toBe(true);
  const { digest, ...body } = plan;
  expect(bootstrapDigest(body)).toBe(digest);
});
it("rejects stale references, prior inventory/orders, inadequate caps/funds and cooldown before wrapping", async () => {
  for (const options of [
    { stale: true },
    { inventory: true },
    { history: true },
    { cap: true },
    { native: true },
    { cooldown: true },
  ])
    await expect(
      prepareMakerBootstrap(fixture(options), manifest, 90),
    ).rejects.toThrow();
  await expect(prepareMakerBootstrap(fixture(), manifest, 0)).rejects.toThrow();
});
