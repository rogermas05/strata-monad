import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import {
  embeddedUpdates,
  pushedUpdateSource,
  pushedPriceHistory,
} from "./pushed-updates.ts";

const FEED = `0x${"ab".repeat(32)}` as Hex;
const CONTRACT = `0x${"11".repeat(20)}` as const;
const PUSHER = `0x${"22".repeat(20)}` as const;
const blob = (tag: string): Hex => `0x504e4155${tag.repeat(40)}`;
/** A relayer-style call: updates nested inside another contract's arguments. */
const relayAbi = parseAbi([
  "function relay(address target, bytes[] updates, uint256 nonce)",
]);
const calldata = (updates: Hex[]) =>
  encodeFunctionData({
    abi: relayAbi,
    functionName: "relay",
    args: [CONTRACT, updates, 7n],
  });

describe("reusing Pyth updates already pushed on-chain (synthetic RPC fixtures)", () => {
  it("extracts every embedded update and ignores look-alike bytes", () => {
    const input = calldata([blob("01"), blob("02")]);
    // The magic inside a word that is not a bytes value must not be picked up.
    const decoy = encodeAbiParameters(
      [{ type: "uint256" }],
      [BigInt(`0x504e4155${"00".repeat(28)}`)],
    );

    expect(embeddedUpdates(input)).toEqual([blob("01"), blob("02")]);
    expect(embeddedUpdates(`${input}${decoy.slice(2)}` as Hex)).toEqual([
      blob("01"),
      blob("02"),
    ]);
    expect(embeddedUpdates("0x1234")).toEqual([]);
  });

  it("returns the latest pushed update at or before a time, verified by the contract", async () => {
    // Blocks tick every second from 1000; an update lands every 7th block.
    const TIP = 1300n;
    const pushes = new Map<bigint, number>();
    for (let b = 1000n; b <= TIP; b += 7n) pushes.set(b, Number(b) - 1);
    const simulated: number[] = [];
    const client = {
      getBlockNumber: async () => TIP,
      getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({
        number: blockNumber ?? TIP,
        timestamp: blockNumber ?? TIP,
      }),
      getLogs: async ({ fromBlock, toBlock }: any) =>
        [...pushes]
          .filter(([b]) => b >= fromBlock && b <= toBlock)
          .map(([b, publishTime]) => ({
            transactionHash: `0x${b.toString(16).padStart(64, "0")}`,
            args: { publishTime: BigInt(publishTime) },
          })),
      getTransaction: async ({ hash }: { hash: Hex }) => ({
        from: PUSHER,
        // The first embedded payload belongs to another feed.
        input: calldata([blob("ee"), blob(hash.slice(-2))]),
      }),
      readContract: async () => 1n,
      simulateContract: async ({ account, args, value }: any) => {
        const [[update], , minTime] = args;
        if (account !== PUSHER || value !== 1n || update === blob("ee"))
          throw new Error("Not this feed");
        simulated.push(Number(minTime));
        return {
          result: [
            {
              id: FEED,
              price: {
                price: 2488346n,
                conf: 1447n,
                expo: -8,
                publishTime: minTime,
              },
            },
          ],
        };
      },
    } as unknown as PublicClient;
    const source = pushedUpdateSource(client, CONTRACT);

    const latest = await source(FEED);
    const before = await source(FEED, 1100);

    expect(latest?.publishTime).toBe(1293);
    // Pushes publish at 999, 1006, … (7 apart): the last at or before 1100 is 1097.
    expect(before).toMatchObject({
      publishTime: 1097,
      exponent: -8,
      price: "2488346",
    });
    expect(before!.updates).toHaveLength(1);
    expect(simulated).toEqual([1293, 1097]);
  });

  it("reads recent chart history from update events, thinned to the requested spacing", async () => {
    // Half-second blocks; the feed is pushed every 4 blocks (2 seconds).
    const TIP = 20_000n;
    const time = (block: bigint) => 1_000_000n + block / 2n;
    const requested: [bigint, bigint][] = [];
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({
        number: blockNumber ?? TIP,
        timestamp: time(blockNumber ?? TIP),
      }),
      readContract: async () => ({ expo: -8 }),
      getLogs: async ({ fromBlock, toBlock }: any) => {
        requested.push([fromBlock, toBlock]);
        const logs = [];
        for (let b = fromBlock; b <= toBlock; b++)
          if (b % 4n === 0n)
            logs.push({
              args: { id: FEED, publishTime: time(b), price: 2_500_000n + b },
            });
        return logs;
      },
    } as unknown as PublicClient;

    const history = await pushedPriceHistory(client, CONTRACT, [FEED], 600, 10);

    const points = history.get(FEED)!;
    // Ten minutes at one point per ten seconds.
    expect(points.length).toBeGreaterThanOrEqual(60);
    expect(points.length).toBeLessThanOrEqual(61);
    expect(points[1].timestamp - points[0].timestamp).toBe(10);
    expect(points.at(-1)!.timestamp).toBe(Number(time(TIP)));
    expect(points.at(-1)!.price).toBeCloseTo((2_500_000 + 20_000) / 1e8, 12);
    expect(requested.every(([from, to]) => to - from < 100n)).toBe(true);
    expect(requested[0][0]).toBe(TIP - 1200n);
  });

  it("returns nothing when the feed was not pushed in the searched range", async () => {
    const client = {
      getBlockNumber: async () => 5000n,
      getLogs: async () => [],
    } as unknown as PublicClient;

    expect(await pushedUpdateSource(client, CONTRACT)(FEED)).toBeNull();
  });
});
