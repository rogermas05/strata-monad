import type { Hex } from "viem";
import { makerInventoryTarget } from "./maker-config.ts";
import {
  makerLadder,
  ladderStep,
  requoteTolerance,
  restingDepthSufficient,
  targetLots,
  MAX_VENUE_PRICE,
  makerInventoryPolicy,
  makerSnapshotRisk,
  type BookOrder,
  type Market,
  type Snapshot,
} from "../../../packages/core/src/index.ts";
import {
  abi,
  client,
  manifest,
  refresh,
  readMakerInventory,
  serialized,
  send,
  kuruAbi,
  marginAbi,
  tokenAbi,
  engineAbi,
  makerConfig,
  makerEnabled,
  workersPaused,
  recordWorkerError,
  setLastQuote,
} from "./runtime.ts";
let index = 0;
export function resetMakerCycle() {
  index = 0;
}
/** One side of one book never quotes more underlying than this, in dollars. */
const MAX_QUOTE_NOTIONAL = 100_000;
const unit = 10n ** 18n,
  lot = 10n ** 15n;
const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
const ownOrders = (market: Market) =>
  market.orders.filter(
    (order) => order.owner.toLowerCase() === manifest.maker.toLowerCase(),
  );

/** Cancels only this project's orders. Writer escrow and customer claims are untouched. */
export async function cancelMakerMarket(
  market: Market,
  orders = ownOrders(market),
  withdraw = true,
  withdrawQuote = true,
  hashes: Hex[] = [],
) {
  if (manifest.kuruMargin) {
    if (orders.length)
      hashes.push(
        await send(
          manifest.maker,
          market.market,
          kuruAbi,
          "batchCancelOrdersNoRevert",
          [orders.map((order) => BigInt(order.id))],
        ),
      );
    if (withdraw)
      for (const token of [
        market.token,
        ...(withdrawQuote ? [manifest.usdc] : []),
      ]) {
        const free = (await client.readContract({
          address: manifest.kuruMargin,
          abi: marginAbi,
          functionName: "getBalance",
          args: [manifest.maker, token],
        })) as bigint;
        if (free > 0n)
          hashes.push(
            await send(
              manifest.maker,
              manifest.kuruMargin,
              marginAbi,
              "withdraw",
              [free, token],
            ),
          );
      }
  } else
    for (const order of orders)
      hashes.push(
        await send(
          manifest.maker,
          market.market,
          abi("DemoOrderBook"),
          "cancel",
          [BigInt(order.id)],
        ),
      );
  return hashes;
}
export async function drainMakerQuotes(snapshot: Snapshot) {
  const hashes: Hex[] = [];
  try {
    for (const market of snapshot.markets)
      await cancelMakerMarket(market, ownOrders(market), true, false, hashes);
    if (manifest.kuruMargin) {
      const free = (await client.readContract({
        address: manifest.kuruMargin,
        abi: marginAbi,
        functionName: "getBalance",
        args: [manifest.maker, manifest.usdc],
      })) as bigint;
      if (free > 0n)
        hashes.push(
          await send(
            manifest.maker,
            manifest.kuruMargin,
            marginAbi,
            "withdraw",
            [free, manifest.usdc],
          ),
        );
    }
    return hashes;
  } catch (error) {
    const submitted = (error as { transactionHash?: Hex }).transactionHash;
    if (submitted && !hashes.includes(submitted)) hashes.push(submitted);
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      { hashes },
    );
  }
}
async function approveIfNeeded(
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
) {
  if (amount === 0n) return;
  const allowance = (await client.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "allowance",
    args: [manifest.maker, spender],
  })) as bigint;
  if (allowance < amount)
    await send(manifest.maker, token, tokenAbi, "approve", [spender, amount]);
}
function policy(
  position: Awaited<ReturnType<typeof readMakerInventory>>,
  fair: number,
  snapshot: Snapshot,
  marketId: number,
) {
  const local = makerInventoryPolicy({
    heldClaims: position.heldClaims,
    writtenClaims: position.writtenClaims,
    maxNetInventory: BigInt(makerConfig.maxNetInventory) * unit,
    inventorySkewBps: makerConfig.inventorySkewBps,
    fair,
  });
  const risk = makerSnapshotRisk(
    snapshot.markets,
    snapshot.maker.inventory,
    manifest.maker,
    makerConfig,
  );
  const capacity = risk.markets.find((m) => m.marketId === marketId)!;
  return {
    ...local,
    bidCapacityLots: min(local.bidCapacityLots, capacity.bidClaims / lot),
    askCapacityLots: min(local.askCapacityLots, capacity.askClaims / lot),
    issuanceCapacity: risk.issuanceCapacity,
  };
}
export function quotePrices(
  p: { reservationPrice: number },
  external: BookOrder[],
) {
  const fair = p.reservationPrice;
  const bid = Math.max(
    1,
    Math.round(
      Math.max(
        fair * (1 - makerConfig.spreadBps / 10_000) - makerConfig.edge,
        0.000001,
      ) * 1e6,
    ),
  );
  const ask = Math.max(
    bid + 1,
    Math.round(
      (fair * (1 + makerConfig.spreadBps / 10_000) + makerConfig.edge) * 1e6,
    ),
  );
  const bids = external
    .filter((order) => order.isBuy)
    .map((order) => Math.round(order.price * 1e6));
  const asks = external
    .filter((order) => !order.isBuy)
    .map((order) => Math.round(order.price * 1e6));
  return {
    bid,
    ask,
    levelStep: ladderStep(ask),
    externalBid: bids.length ? Math.max(...bids) : undefined,
    externalAsk: asks.length ? Math.min(...asks) : undefined,
  };
}
export async function runMakerCycle({
  allowDuringCheckpoint = false,
  marketIds,
}: { allowDuringCheckpoint?: boolean; marketIds?: number[] } = {}) {
  if (workersPaused && !allowDuringCheckpoint) return;
  let snapshot = await refresh();
  if (!snapshot.service.newExposureAllowed) {
    // Readable oracle failure: remove executable external quotes, even if update scheduling is paused.
    await drainMakerQuotes(snapshot);
    return refresh();
  }
  // A closed session would leave resting quotes exposed to the next open.
  for (const market of snapshot.markets) {
    if (!market.active || market.healthy) continue;
    const orders = ownOrders(market);
    if (orders.length) await cancelMakerMarket(market, orders, false);
  }
  if (!makerEnabled) return snapshot;
  // Tightened budgets may invalidate reservations on books outside this cycle.
  // Cancel project orders across the shelf before allocating the new budget.
  if (snapshot.maker.risk.reservationBreached) {
    for (const market of snapshot.markets) {
      const orders = ownOrders(market);
      if (orders.length) await cancelMakerMarket(market, orders, false);
    }
    snapshot = await refresh();
  }
  const active = snapshot.markets.filter(
    (market) => market.active && market.healthy,
  );
  const chosen = marketIds
    ? active.filter((market) => marketIds.includes(market.id))
    : Array.from(
        { length: Math.min(4, active.length) },
        () => active[index++ % active.length],
      );
  for (const selected of chosen) {
    snapshot = await refresh();
    let market = snapshot.markets.find((m) => m.id === selected.id)!;
    if (
      !market.active ||
      !market.healthy ||
      !snapshot.service.newExposureAllowed
    )
      continue;
    const orders = ownOrders(market);
    const external = market.orders.filter(
      (order) => order.owner.toLowerCase() !== manifest.maker.toLowerCase(),
    );
    const before = await readMakerInventory(
      market,
      orders,
      BigInt(snapshot.block),
    );
    const initial = policy(before, market.mark, snapshot, market.id);
    const initialPrices = quotePrices(initial, external);
    const allocation = makerInventoryTarget(makerConfig, market);
    // Premiums beyond the venue's price range cannot rest on this book at all.
    if (initialPrices.bid > MAX_VENUE_PRICE) continue;
    const publicMarket = manifest.mode === "testnet";
    const spot = snapshot.underlyings[market.asset]?.spot ?? 0;
    const hardTarget = targetLots(
      allocation.targetInventory,
      spot,
      MAX_QUOTE_NOTIONAL,
    );
    // Leave headroom below the hard dollar cap so tiny spot moves do not replace the whole book.
    const target = targetLots(
      allocation.targetInventory,
      spot,
      publicMarket ? MAX_QUOTE_NOTIONAL * 0.9 : MAX_QUOTE_NOTIONAL,
    );

    const issuanceCapacity = min(
      initial.issuanceCapacity,
      BigInt(allocation.maxWritten) * unit > before.writtenClaims
        ? BigInt(allocation.maxWritten) * unit - before.writtenClaims
        : 0n,
    );
    const expected = makerLadder({
      ...initialPrices,
      ...initial,
      targetLots: target,
      availableAskLots: (before.heldClaims + issuanceCapacity) / lot,
    });
    const bidLots = orders
      .filter((order) => order.isBuy)
      .reduce(
        (sum, order) => sum + BigInt(Math.round(order.remaining * 1000)),
        0n,
      );
    const askLots = orders
      .filter((order) => !order.isBuy)
      .reduce(
        (sum, order) => sum + BigInt(Math.round(order.remaining * 1000)),
        0n,
      );
    const expectedBids = expected.buySizes.reduce(
      (sum, value) => sum + value,
      0n,
    );
    const expectedAsks = expected.sellSizes.reduce(
      (sum, value) => sum + value,
      0n,
    );
    const ownBid = orders
      .filter((order) => order.isBuy)
      .reduce(
        (best, order) => Math.max(best, Math.round(order.price * 1e6)),
        0,
      );
    const ownAsk = orders
      .filter((order) => !order.isBuy)
      .reduce(
        (best, order) => Math.min(best, Math.round(order.price * 1e6)),
        Infinity,
      );
    const pricesClose =
      (expectedBids === 0n
        ? bidLots === 0n
        : Math.abs(ownBid - expected.buyPrices[0]) <
          requoteTolerance(
            expected.buyPrices[0],
            manifest.mode === "testnet" ? makerConfig.spreadBps : undefined,
          )) &&
      (expectedAsks === 0n
        ? askLots === 0n
        : Math.abs(ownAsk - expected.sellPrices[0]) <
          requoteTolerance(
            expected.sellPrices[0],
            manifest.mode === "testnet" ? makerConfig.spreadBps : undefined,
          ));
    if (
      pricesClose &&
      (publicMarket
        ? restingDepthSufficient(
            bidLots,
            expectedBids,
            min(hardTarget, initial.bidCapacityLots),
          ) &&
          restingDepthSufficient(
            askLots,
            expectedAsks,
            min(hardTarget, initial.askCapacityLots, before.heldClaims / lot),
          )
        : bidLots === expectedBids &&
          restingDepthSufficient(askLots, expectedAsks, expectedAsks))
    )
      continue;

    // Cancel first, then read custody again. A fill racing the cancellation must reduce the next quote budget.
    await cancelMakerMarket(market, orders, false);
    snapshot = await refresh();
    market = snapshot.markets.find((m) => m.id === selected.id)!;
    let position = await readMakerInventory(market, [], BigInt(snapshot.block));
    const inventoryPolicy = policy(position, market.mark, snapshot, market.id);
    const allowedAsks = min(target, inventoryPolicy.askCapacityLots) * lot;
    const missing =
      allowedAsks > position.heldClaims
        ? allowedAsks - position.heldClaims
        : 0n;
    const capacity =
      BigInt(allocation.maxWritten) * unit > position.writtenClaims
        ? BigInt(allocation.maxWritten) * unit - position.writtenClaims
        : 0n;
    const add = min(missing, capacity, inventoryPolicy.issuanceCapacity);
    if (add > 0n) {
      const nextBacking = (await client.readContract({
        address: manifest.engine,
        abi: engineAbi,
        functionName: "requiredCollateral",
        args: [BigInt(market.id), position.writtenClaims + add],
      })) as bigint;
      await approveIfNeeded(
        market.kind === "call" ? manifest.wmon : manifest.usdc,
        manifest.engine,
        nextBacking - position.collateral,
      );
      await send(manifest.maker, manifest.engine, engineAbi, "write", [
        BigInt(market.id),
        add,
        manifest.maker,
      ]);
      position = await readMakerInventory(market, []);
    }
    if (manifest.kuruMargin && position.walletClaims > 0n) {
      await approveIfNeeded(
        market.token,
        manifest.kuruMargin,
        position.walletClaims,
      );
      await send(manifest.maker, manifest.kuruMargin, marginAbi, "deposit", [
        manifest.maker,
        market.token,
        position.walletClaims,
      ]);
      position = await readMakerInventory(market, []);
    }
    snapshot = await refresh();
    market = snapshot.markets.find((m) => m.id === selected.id)!;
    position = await readMakerInventory(market, [], BigInt(snapshot.block));
    const currentPolicy = policy(position, market.mark, snapshot, market.id);
    const ladder = makerLadder({
      ...quotePrices(currentPolicy, external),
      ...currentPolicy,
      targetLots: target,
      availableAskLots: position.heldClaims / lot,
    });
    if (manifest.kuruMargin) {
      const free = (await client.readContract({
        address: manifest.kuruMargin,
        abi: marginAbi,
        functionName: "getBalance",
        args: [manifest.maker, manifest.usdc],
      })) as bigint;
      const needed =
        ladder.quoteReserve > free ? ladder.quoteReserve - free : 0n;
      if (needed > 0n) {
        const walletBalance = (await client.readContract({
          address: manifest.usdc,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [manifest.maker],
        })) as bigint;
        if (walletBalance < needed)
          throw new Error(
            "Maker quote budget exhausted; quotes remain cancelled.",
          );
        await approveIfNeeded(manifest.usdc, manifest.kuruMargin, needed);
        await send(manifest.maker, manifest.kuruMargin, marginAbi, "deposit", [
          manifest.maker,
          manifest.usdc,
          needed,
        ]);
      }
      if (ladder.buySizes.length || ladder.sellSizes.length)
        await send(manifest.maker, market.market, kuruAbi, "batchUpdate", [
          ladder.buyPrices,
          ladder.buySizes,
          ladder.sellPrices,
          ladder.sellSizes,
          [],
          true,
        ]);
    } else {
      const quote = (await client.readContract({
        address: manifest.usdc,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [manifest.maker],
      })) as bigint;
      if (quote < ladder.quoteReserve)
        throw new Error(
          "Maker quote budget exhausted; quotes remain cancelled.",
        );
      await approveIfNeeded(
        market.token,
        market.market,
        ladder.sellSizes.reduce((sum, n) => sum + n * lot, 0n),
      );
      await approveIfNeeded(manifest.usdc, market.market, ladder.quoteReserve);
      for (const [isBuy, prices, sizes] of [
        [false, ladder.sellPrices, ladder.sellSizes],
        [true, ladder.buyPrices, ladder.buySizes],
      ] as const)
        for (let level = 0; level < prices.length; level++)
          await send(
            manifest.maker,
            market.market,
            abi("DemoOrderBook"),
            "place",
            [isBuy, BigInt(prices[level]), sizes[level] * lot],
          );
    }
    setLastQuote(snapshot.timestamp);
  }
  return refresh();
}
export function startMakerWorker() {
  let pending = false;
  setInterval(() => {
    if (workersPaused || pending) return;
    pending = true;
    void serialized(() => runMakerCycle())
      .catch((error) =>
        recordWorkerError(
          `Maker: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        pending = false;
      });
  }, 3000).unref();
}
