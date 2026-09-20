import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import type { Evidence } from "./hermes.ts";
import { pythAbi } from "./pyth.ts";
import type { UpdateSource } from "./settlement-keeper.ts";

/**
 * Signed Pyth updates that another party has already pushed on-chain. The
 * payload sits in that transaction's calldata and is as valid a proof as one
 * fetched from Hermes, so it can be reused wherever the feed is being pushed.
 * Availability depends entirely on that pusher.
 */
const priceFeedUpdate = parseAbiItem(
  "event PriceFeedUpdate(bytes32 indexed id, uint64 publishTime, int64 price, uint64 conf)",
);
/** "PNAU": magic prefix of a Pyth accumulator update. */
const UPDATE_MAGIC = "504e4155";
const MAX_UPDATE_BYTES = 65536;
const WORD = 64;
const SELECTOR = 8;
const LOG_RANGE = 100n;
/** Chunks scanned backwards before giving up (about ten minutes of blocks). */
const MAX_LOG_CHUNKS = 15;

/** Update payloads embedded as ABI `bytes` values anywhere in a transaction's calldata. */
export function embeddedUpdates(input: Hex): Hex[] {
  const hex = input.slice(2).toLowerCase();
  const found: Hex[] = [];
  for (
    let at = hex.indexOf(UPDATE_MAGIC);
    at !== -1;
    at = hex.indexOf(UPDATE_MAGIC, at + UPDATE_MAGIC.length)
  ) {
    // A bytes value starts on a word boundary, right after its length word.
    if (at < SELECTOR + WORD || (at - SELECTOR) % WORD !== 0) continue;
    const length = Number(BigInt(`0x${hex.slice(at - WORD, at)}`));
    if (length < 4 || length > MAX_UPDATE_BYTES) continue;
    if (at + length * 2 > hex.length) continue;
    found.push(`0x${hex.slice(at, at + length * 2)}`);
  }
  return found;
}

/** Highest block whose timestamp is at or before `timestamp`. */
async function blockAtOrBefore(client: PublicClient, timestamp: number) {
  const tip = await client.getBlock();
  if (Number(tip.timestamp) <= timestamp) return tip.number;
  let lo = 0n,
    hi = tip.number;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) <= timestamp) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * `source(feed)` is the latest pushed update; `source(feed, t)` the latest one
 * published at or before `t`. Every payload is re-verified by the contract it
 * was pushed to before it is returned.
 */
export function pushedUpdateSource(
  client: PublicClient,
  contract: Address,
): UpdateSource {
  return async (feed, timestamp) => {
    let to =
      timestamp === undefined
        ? await client.getBlockNumber({ cacheTime: 0 })
        : await blockAtOrBefore(client, timestamp);
    for (let chunk = 0; chunk < MAX_LOG_CHUNKS && to >= 0n; chunk++) {
      const from = to >= LOG_RANGE ? to - LOG_RANGE + 1n : 0n;
      const logs = await client.getLogs({
        address: contract,
        event: priceFeedUpdate,
        args: { id: feed },
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs.reverse()) {
        const publishTime = Number(log.args.publishTime);
        if (timestamp !== undefined && publishTime > timestamp) continue;
        const evidence = await verified(
          client,
          contract,
          feed,
          log.transactionHash,
          publishTime,
        );
        if (evidence) return evidence;
      }
      if (from === 0n) break;
      to = from - 1n;
    }
    return null;
  };
}

async function verified(
  client: PublicClient,
  contract: Address,
  feed: Hex,
  hash: Hex,
  publishTime: number,
): Promise<Evidence | null> {
  const transaction = await client.getTransaction({ hash });
  for (const update of embeddedUpdates(transaction.input)) {
    try {
      const fee = await client.readContract({
        address: contract,
        abi: pythAbi,
        functionName: "getUpdateFee",
        args: [[update]],
      });
      // The pusher's own account is funded on this chain, so the call can carry the fee.
      const { result } = await client.simulateContract({
        account: transaction.from,
        address: contract,
        abi: pythAbi,
        functionName: "parsePriceFeedUpdates",
        args: [[update], [feed], BigInt(publishTime), BigInt(publishTime)],
        value: fee,
      });
      const price = result[0]?.price;
      if (!price || result[0].id.toLowerCase() !== feed.toLowerCase()) continue;
      return {
        updates: [update],
        feed,
        publishTime: Number(price.publishTime),
        price: price.price.toString(),
        confidence: price.conf.toString(),
        exponent: price.expo,
      };
    } catch {
      // Not a payload for this feed and time; try the next embedded value.
    }
  }
  return null;
}

export interface PricePoint {
  timestamp: number;
  price: number;
}
// Public RPCs rate-limit (Monad testnet: 25 requests a second): three queries
// per quarter second, and one retry after a pause.
const HISTORY_CONCURRENCY = 3;
const HISTORY_BATCH_MS = 250;
const HISTORY_RETRY_MS = 1500;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCK_TIME_SAMPLE = 5000n;

/**
 * Recent prices of pushed feeds, read from the contract's update events, at
 * most one point per `spacing` seconds. For charts only: nothing is verified.
 */
export async function pushedPriceHistory(
  client: PublicClient,
  contract: Address,
  feeds: Hex[],
  seconds: number,
  spacing: number,
): Promise<Map<Hex, PricePoint[]>> {
  const tip = await client.getBlock();
  const earlier = await client.getBlock({
    blockNumber:
      tip.number > BLOCK_TIME_SAMPLE ? tip.number - BLOCK_TIME_SAMPLE : 0n,
  });
  const perBlock =
    Number(tip.timestamp - earlier.timestamp) /
    Number(tip.number - earlier.number || 1n);
  const span = BigInt(Math.ceil(seconds / Math.max(perBlock, 0.05)));
  const start = tip.number > span ? tip.number - span : 0n;
  const exponents = new Map<string, number>();
  for (const feed of feeds)
    try {
      const current = await client.readContract({
        address: contract,
        abi: pythAbi,
        functionName: "getPriceUnsafe",
        args: [feed],
      });
      exponents.set(feed.toLowerCase(), current.expo);
    } catch {
      // Never pushed to this contract: no history for this feed.
    }
  const ranges: bigint[] = [];
  for (let from = start; from <= tip.number; from += LOG_RANGE)
    ranges.push(from);
  const raw: { id: string; timestamp: number; value: bigint }[] = [];
  const query = (from: bigint) =>
    client.getLogs({
      address: contract,
      event: priceFeedUpdate,
      args: { id: feeds },
      fromBlock: from,
      toBlock:
        from + LOG_RANGE - 1n < tip.number ? from + LOG_RANGE - 1n : tip.number,
    });
  for (let i = 0; i < ranges.length; i += HISTORY_CONCURRENCY) {
    const batch = ranges.slice(i, i + HISTORY_CONCURRENCY);
    const started = Date.now();
    let results;
    try {
      results = await Promise.all(batch.map(query));
    } catch {
      await pause(HISTORY_RETRY_MS);
      results = await Promise.all(batch.map(query));
    }
    for (const log of results.flat())
      raw.push({
        id: log.args.id!.toLowerCase(),
        timestamp: Number(log.args.publishTime),
        value: log.args.price!,
      });
    const wait = HISTORY_BATCH_MS - (Date.now() - started);
    if (wait > 0 && i + HISTORY_CONCURRENCY < ranges.length) await pause(wait);
  }
  const history = new Map<Hex, PricePoint[]>(feeds.map((feed) => [feed, []]));
  for (const feed of feeds) {
    const points = history.get(feed)!;
    const exponent = exponents.get(feed.toLowerCase());
    if (exponent === undefined) continue;
    const scale = 10 ** exponent;
    for (const entry of raw
      .filter((r) => r.id === feed.toLowerCase())
      .sort((a, b) => a.timestamp - b.timestamp)) {
      if (points.length && entry.timestamp - points.at(-1)!.timestamp < spacing)
        continue;
      points.push({
        timestamp: entry.timestamp,
        price: Number(entry.value) * scale,
      });
    }
  }
  return history;
}
