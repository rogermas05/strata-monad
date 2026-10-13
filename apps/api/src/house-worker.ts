import type { Hex } from "viem";
import {
  client,
  manifest,
  refresh,
  send,
  serialized,
  engineAbi,
  marginAbi,
  makerConfig,
  makerEnabled,
  workersPaused,
  recordWorkerError,
  readMakerInventory,
  indexedEvents,
} from "./runtime.ts";
import { vaultAbi, publishRewards } from "./house.ts";
import { quotePrices } from "./maker-worker.ts";
import { makerInventoryTarget } from "./maker-config.ts";
import {
  makerInventoryPolicy,
  makerLadder,
  requoteTolerance,
  restingDepthSufficient,
  targetLots,
  MAX_VENUE_PRICE,
  type Market,
  type Snapshot,
} from "../../../packages/core/src/index.ts";
import {
  selectEpochSeries,
  houseQuoteBudget,
  HOUSE_QUOTE_CUTOFF,
} from "../../../packages/core/src/house-epoch.ts";

const house = manifest.house;
const unit = 10n ** 18n,
  lot = 10n ** 15n;
/** Same per-side notional ceiling as the project maker. */
const MAX_QUOTE_NOTIONAL = 100_000;
const MARKETS_PER_CYCLE = 4;
const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
let index = 0;

const operate = (functionName: string, args: unknown[] = []) =>
  send(house!.operator, house!.vault, vaultAbi, functionName, args);
const own = (market: Market) =>
  market.orders.filter(
    (o) => o.owner.toLowerCase() === house!.vault.toLowerCase(),
  );

async function readVault<T>(functionName: string, args: unknown[] = []) {
  return (await client.readContract({
    address: house!.vault,
    abi: vaultAbi,
    functionName,
    args,
  })) as T;
}

async function cancelOwn(market: Market) {
  const orders = own(market);
  if (orders.length)
    await operate("cancelQuotes", [
      market.market,
      orders.map((o) => BigInt(o.id)),
    ]);
}

/** Series the vault has ever admitted; each series can only be traded in one epoch. */
function tradedSeries() {
  return new Set(
    indexedEvents(house!.vault)
      .filter((e) => e.event === "EpochSeries")
      .flatMap((e) => (JSON.parse(e.args).seriesIds as string[]).map(Number)),
  );
}

async function roll(snapshot: Snapshot) {
  const next = selectEpochSeries(
    manifest.series,
    snapshot.timestamp,
    tradedSeries(),
  );
  const hash = await operate("roll", [next.map(BigInt)]);
  await publishRewards(await refresh());
  return hash;
}

/** Quotes one admitted book from the vault's own capital and inventory. */
async function quote(market: Market, snapshot: Snapshot) {
  const state = snapshot.house!;
  const external = market.orders.filter(
    (o) => o.owner.toLowerCase() !== house!.vault.toLowerCase(),
  );
  const orders = own(market);
  const block = BigInt(snapshot.block);
  const before = await readMakerInventory(market, orders, block, house!.vault);
  const policy = makerInventoryPolicy({
    heldClaims: before.heldClaims,
    writtenClaims: before.writtenClaims,
    maxNetInventory: BigInt(makerConfig.maxNetInventory) * unit,
    inventorySkewBps: makerConfig.inventorySkewBps,
    fair: market.mark,
  });
  const prices = quotePrices(policy, external);
  if (prices.bid > MAX_VENUE_PRICE) return;
  const allocation = makerInventoryTarget(makerConfig, market);
  const target = targetLots(
    allocation.targetInventory,
    snapshot.underlyings[market.asset]?.spot ?? 0,
    MAX_QUOTE_NOTIONAL,
  );
  const collateralPerClaim = (await client.readContract({
    address: manifest.engine,
    abi: engineAbi,
    functionName: "requiredCollateral",
    args: [BigInt(market.id), unit],
  })) as bigint;
  const budget = houseQuoteBudget({
    managedAssets: BigInt(Math.round(state.epochStartAssets * 1e6)),
    seriesCount: Math.max(1, state.series.length),
    collateralPerClaim,
    bidPrice: prices.bid,
    targetLots: target,
  });
  const plan = (heldClaims: bigint, bidLots: bigint) =>
    makerLadder({
      ...prices,
      targetLots: target,
      availableAskLots: heldClaims / lot,
      bidCapacityLots: min(policy.bidCapacityLots, bidLots),
      askCapacityLots: min(policy.askCapacityLots, budget.askLots),
    });
  const expected = plan(
    before.heldClaims + budget.askLots * lot,
    budget.bidLots,
  );
  const resting = (isBuy: boolean) =>
    orders
      .filter((o) => o.isBuy === isBuy)
      .reduce((sum, o) => sum + BigInt(Math.round(o.remaining * 1000)), 0n);
  const top = (isBuy: boolean) =>
    orders
      .filter((o) => o.isBuy === isBuy)
      .map((o) => Math.round(o.price * 1e6))
      .reduce(
        (a, b) => (isBuy ? Math.max(a, b) : Math.min(a, b)),
        isBuy ? 0 : Infinity,
      );
  const sum = (sizes: bigint[]) => sizes.reduce((a, b) => a + b, 0n);
  const close = (isBuy: boolean, prices: number[], sizes: bigint[]) =>
    sum(sizes) === 0n
      ? resting(isBuy) === 0n
      : Math.abs(top(isBuy) - prices[0]) < requoteTolerance(prices[0]) &&
        restingDepthSufficient(resting(isBuy), sum(sizes), sum(sizes));
  if (
    close(true, expected.buyPrices, expected.buySizes) &&
    close(false, expected.sellPrices, expected.sellSizes)
  )
    return;

  // Cancel first, then reread custody so racing fills shrink the next quote.
  await cancelOwn(market);
  let position = await readMakerInventory(market, [], undefined, house!.vault);
  const wanted = min(budget.askLots, policy.askCapacityLots) * lot;
  let idle = await readVault<bigint>("idleAssets");
  if (wanted > position.heldClaims) {
    const affordable = ((idle * unit) / collateralPerClaim / lot) * lot;
    const add = min(wanted - position.heldClaims, affordable);
    if (add > 0n) {
      await operate("write", [BigInt(market.id), add]);
      idle = await readVault<bigint>("idleAssets");
    }
  }
  position = await readMakerInventory(market, [], undefined, house!.vault);
  if (position.walletClaims > 0n)
    await operate("depositToVenue", [market.token, position.walletClaims]);
  const venueCash = (await client.readContract({
    address: manifest.kuruMargin!,
    abi: marginAbi,
    functionName: "getBalance",
    args: [house!.vault, manifest.usdc],
  })) as bigint;
  let ladder = plan(position.heldClaims, budget.bidLots);
  if (ladder.quoteReserve > venueCash + idle)
    // Not enough cash for the planned bids: quote asks only this round.
    ladder = plan(position.heldClaims, 0n);
  if (ladder.quoteReserve > venueCash)
    await operate("depositToVenue", [
      manifest.usdc,
      ladder.quoteReserve - venueCash,
    ]);
  if (ladder.buySizes.length || ladder.sellSizes.length)
    await operate("updateQuotes", [
      market.market,
      ladder.buyPrices,
      ladder.buySizes,
      ladder.sellPrices,
      ladder.sellSizes,
      [],
    ]);
}

/** One pass: launch or roll when due, pull quotes near expiry, then refresh a few books. */
export async function runHouseCycle({
  marketIds,
}: { marketIds?: number[] } = {}): Promise<Hex | undefined> {
  if (!house) return;
  let snapshot = await refresh();
  const state = snapshot.house;
  if (!state) return;
  const now = snapshot.timestamp;
  if (state.epoch === 0) {
    if (now >= state.launchTime) return roll(snapshot);
    return;
  }
  const admitted = snapshot.markets.filter((m) => state.series.includes(m.id));
  for (const market of admitted)
    if (market.expiry - now <= HOUSE_QUOTE_CUTOFF || !market.healthy)
      await cancelOwn(market);
  if (admitted.every((m) => now >= m.expiry)) {
    // An idle epoch only rolls once there is something to trade; otherwise
    // every pass would open another empty epoch.
    const idle =
      !admitted.length &&
      !selectEpochSeries(manifest.series, now, tradedSeries()).length;
    if (!idle && admitted.every((m) => m.settlementPrice !== null))
      return roll(await refresh());
    return;
  }
  if (!makerEnabled || !snapshot.service.newExposureAllowed) return;
  snapshot = await refresh();
  const live = snapshot.markets.filter(
    (m) =>
      state.series.includes(m.id) &&
      m.active &&
      m.healthy &&
      m.expiry - now > HOUSE_QUOTE_CUTOFF,
  );
  const chosen = marketIds
    ? live.filter((m) => marketIds.includes(m.id))
    : Array.from(
        { length: Math.min(MARKETS_PER_CYCLE, live.length) },
        () => live[index++ % live.length],
      );
  for (const market of chosen) {
    snapshot = await refresh();
    const latest = snapshot.markets.find((m) => m.id === market.id)!;
    if (latest.active && latest.healthy) await quote(latest, snapshot);
  }
}

export function startHouseWorker() {
  if (!house) return;
  let pending = false;
  setInterval(() => {
    if (workersPaused || pending) return;
    pending = true;
    void serialized(() => runHouseCycle())
      .catch((error) =>
        recordWorkerError(
          `House: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        pending = false;
      });
  }, 5000).unref();
}
