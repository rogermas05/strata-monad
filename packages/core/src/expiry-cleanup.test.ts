import { expect, it } from "vitest";
import type { Address, PublicClient } from "viem";
import type { Manifest } from "./types.ts";
import {
  cleanupExpiredMaker,
  type ExpiryCleanupSend,
} from "./expiry-cleanup.ts";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const series = {
  id: 1,
  token: addr(7),
  market: addr(8),
  expiry: 1000,
} as Manifest["series"][number];
const manifest = {
  chainId: 31337,
  venueMode: "kuru",
  maker: addr(1),
  engine: addr(2),
  oracle: addr(3),
  usdc: addr(4),
  kuruMargin: addr(5),
  assetId: `0x${"aa".repeat(32)}`,
  series: [series],
} as Manifest;
function fixture(
  options: {
    pending?: boolean;
    early?: boolean;
    wrongChain?: boolean;
    interrupted?: boolean;
    empty?: boolean;
  } = {},
) {
  let wallet = options.empty ? 0n : 1n,
    custody = options.empty ? 0n : 89n,
    writer = options.empty ? 0n : 90n;
  let interruptions = options.interrupted ? 1 : 0;
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const client = {
    getChainId: async () => (options.wrongChain ? 10143 : 31337),
    getBlock: async () => ({ timestamp: options.early ? 999n : 1001n }),
    readContract: async ({ functionName, args }: any) => {
      if (functionName === "settlementPrice")
        return options.pending ? 0n : 130000000n;
      if (functionName === "getBalance") {
        if (args[1] !== series.token)
          throw new Error("Shared quote custody must not be accessed");
        return custody;
      }
      if (functionName === "balanceOf") return wallet;
      if (functionName === "writers") return [writer, writer];
      throw new Error("Unknown synthetic expiry read");
    },
  } as unknown as PublicClient;
  const send: ExpiryCleanupSend = async (_, __, name, args) => {
    calls.push({ name, args });
    if (name === "cancel") {
      wallet += custody;
      custody = 0n;
    }
    if (name === "withdraw") {
      wallet += custody;
      custody = 0n;
    }
    if (name === "redeemLong") {
      if (interruptions > 0) {
        interruptions--;
        throw new Error("Redemption interrupted");
      }
      wallet = 0n;
    }
    if (name === "settleWriter") writer = 0n;
  };
  return { client, send, calls };
}
it("recovers expired claims while preserving shared quote custody with synthetic reads", async () => {
  const f = fixture();
  const result = await cleanupExpiredMaker(
    f.client,
    manifest,
    series,
    [1n, 1n, 2n],
    f.send,
  );
  expect(f.calls.map((c) => c.name)).toEqual([
    "batchCancelOrdersNoRevert",
    "withdraw",
    "redeemLong",
    "settleWriter",
  ]);
  expect(f.calls[1].args).toEqual([89n, series.token]);
  expect(result.redeemedClaims).toBe("90");
  expect(result.cancelledOrderIds).toEqual(["1", "2"]);
});
it("does not touch custody before finalization, expiry or chain validation", async () => {
  for (const options of [
    { pending: true },
    { early: true },
    { wrongChain: true },
  ]) {
    const f = fixture(options);
    await expect(
      cleanupExpiredMaker(f.client, manifest, series, [1n], f.send),
    ).rejects.toThrow("finalized expired reference");
    expect(f.calls).toEqual([]);
  }
});
it("resumes from actual custody and writer state after an interrupted claim", async () => {
  const f = fixture({ interrupted: true });
  await expect(
    cleanupExpiredMaker(f.client, manifest, series, [1n], f.send),
  ).rejects.toThrow("interrupted");
  // Previously withdrawn claims are read from the wallet; no second withdrawal.
  const resumed = await cleanupExpiredMaker(
    f.client,
    manifest,
    series,
    [],
    f.send,
  );
  expect(resumed.redeemedClaims).toBe("90");
  expect(f.calls.filter((c) => c.name === "withdraw")).toHaveLength(1);
  expect(f.calls.filter((c) => c.name === "settleWriter")).toHaveLength(1);
  const count = f.calls.length;
  await cleanupExpiredMaker(f.client, manifest, series, [], f.send);
  expect(f.calls).toHaveLength(count);
});
it("is a no-op when cleanup is already complete and rejects unlisted or malformed inputs", async () => {
  const f = fixture({ empty: true });
  await cleanupExpiredMaker(f.client, manifest, series, [], f.send);
  expect(f.calls).toEqual([]);
  await expect(
    cleanupExpiredMaker(
      f.client,
      manifest,
      { ...series, token: addr(99) },
      [],
      f.send,
    ),
  ).rejects.toThrow("listed series");
  await expect(
    cleanupExpiredMaker(f.client, manifest, series, [2n ** 40n], f.send),
  ).rejects.toThrow("bounds");
});

it("recovers standalone demo-book escrow without using Kuru custody", async () => {
  const f = fixture();
  await cleanupExpiredMaker(
    f.client,
    { ...manifest, venueMode: "demo", kuruMargin: undefined },
    series,
    [1n],
    f.send,
  );
  expect(f.calls.map((c) => c.name)).toEqual([
    "cancel",
    "redeemLong",
    "settleWriter",
  ]);
  expect(f.calls[1].args[1]).toBe(90n);
});
