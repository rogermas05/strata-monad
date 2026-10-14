import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { Address, Hex } from "viem";
import {
  abi,
  client,
  manifest,
  marginAbi,
  tokenAbi,
  runtimeDirectory,
  indexedEvents,
  readMakerInventory,
  extendSnapshot,
  tradeHistory,
  current,
  send,
  recordWorkerError,
} from "./runtime.ts";
import { cloudEnabled, loadCloudState, saveCloudState } from "./cloud-store.ts";
import {
  computePoints,
  pointsToStrata,
  MICRO_POINTS,
  type PointsInput,
} from "../../../packages/core/src/points.ts";
import {
  buildRewardTree,
  type RewardTree,
} from "../../../packages/core/src/merkle.ts";
import type {
  HouseAccount,
  HouseState,
  Market,
  PointsBreakdown,
  RewardsAccount,
  Snapshot,
} from "../../../packages/core/src/index.ts";

export const vaultAbi = abi("HouseVault"),
  stakingAbi = abi("StrataStaking"),
  distributorAbi = abi("StrataDistributor"),
  strataAbi = abi("StrataToken");
const PPS = 1e18;
const usd = (raw: bigint) => Number(raw) / 1e6;
const house = manifest.house;

type VaultEvent = Record<string, string> & { at: number };
/** Decoded vault events of one kind; `at` is the block timestamp. */
const events = (name: string): VaultEvent[] =>
  house
    ? indexedEvents(house.vault)
        .filter((e) => e.event === name)
        .map((e) => ({ ...JSON.parse(e.args), at: e.timestamp }))
    : [];

/** Payoff in USD per whole claim at a settlement price (calls valued at delivery). */
function payoffPerClaim(market: Market, price: number) {
  const width = market.upperStrike - market.strike;
  switch (market.kind) {
    case "call":
      return Math.max(price - market.strike, 0);
    case "put":
      return Math.max(market.strike - price, 0);
    case "bull-spread":
      return Math.min(Math.max(price - market.strike, 0), width);
    case "bear-spread":
      return Math.min(Math.max(market.upperStrike - price, 0), width);
  }
}

function maxPayoffPerClaim(market: Market) {
  if (market.kind === "put") return market.strike;
  if (market.kind === "call") return Infinity;
  return market.upperStrike - market.strike;
}

async function readVault<T>(
  functionName: string,
  args: unknown[] = [],
  blockNumber?: bigint,
) {
  return (await client.readContract({
    address: house!.vault,
    abi: vaultAbi,
    functionName,
    args,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })) as T;
}

export async function houseState(
  snapshot: Snapshot,
  blockNumber: bigint,
): Promise<HouseState> {
  if (!house) throw new Error("This deployment has no house vault");
  const [
    epoch,
    lastRollTime,
    epochStartAssets,
    pendingDeposits,
    queuedShares,
    reservedWithdrawals,
    totalShares,
    depositCap,
    depositsPaused,
    performanceFeeBps,
    series,
    idleAssets,
  ] = await Promise.all([
    readVault<bigint>("epoch", [], blockNumber),
    readVault<bigint>("lastRollTime", [], blockNumber),
    readVault<bigint>("epochStartAssets", [], blockNumber),
    readVault<bigint>("pendingDeposits", [], blockNumber),
    readVault<bigint>("queuedShares", [], blockNumber),
    readVault<bigint>("reservedWithdrawals", [], blockNumber),
    readVault<bigint>("totalSupply", [], blockNumber),
    readVault<bigint>("depositCap", [], blockNumber),
    readVault<boolean>("depositsPaused", [], blockNumber),
    readVault<number>("performanceFeeBps", [], blockNumber),
    readVault<readonly bigint[]>("epochSeries", [], blockNumber),
    readVault<bigint>("idleAssets", [], blockNumber),
  ]);
  const [venueCash, rootEpoch] = (await Promise.all([
    client.readContract({
      address: manifest.kuruMargin!,
      abi: marginAbi,
      functionName: "getBalance",
      args: [house.vault, manifest.usdc],
      blockNumber,
    }),
    client.readContract({
      address: house.distributor,
      abi: distributorAbi,
      functionName: "rootEpoch",
      blockNumber,
    }),
  ])) as [bigint, bigint];
  const ids = series.map(Number);
  let marked = usd(idleAssets) + usd(venueCash);
  let maxLoss = 0;
  for (const market of snapshot.markets.filter((m) => ids.includes(m.id))) {
    const position = await readMakerInventory(
      market,
      market.orders,
      blockNumber,
      house.vault,
    );
    const held = Number(position.heldClaims) / 1e18;
    const written = Number(position.writtenClaims) / 1e18;
    const bidReserve = market.orders
      .filter(
        (o) => o.isBuy && o.owner.toLowerCase() === house.vault.toLowerCase(),
      )
      .reduce((sum, o) => sum + o.remaining * o.price, 0);
    const value =
      market.settlementPrice === null
        ? market.mark
        : payoffPerClaim(market, market.settlementPrice);
    marked += usd(position.collateral) + bidReserve + (held - written) * value;
    if (written > held) maxLoss += (written - held) * maxPayoffPerClaim(market);
  }
  const history = events("Rolled").map((e) => ({
    epoch: Number(e.epoch),
    pricePerShare: Number(e.pricePerShare) / PPS,
    assets: usd(BigInt(e.assets)),
    fee: usd(BigInt(e.fee)),
    timestamp: e.at,
  }));
  const shares = usd(totalShares);
  return {
    address: house.vault,
    epoch: Number(epoch),
    launchTime: house.launchTime,
    genesisStart: house.genesisStart,
    lastRollTime: Number(lastRollTime),
    epochStartAssets: usd(epochStartAssets),
    pendingDeposits: usd(pendingDeposits),
    queuedShares: usd(queuedShares),
    reservedWithdrawals: usd(reservedWithdrawals),
    totalShares: shares,
    depositCap: usd(depositCap),
    depositsPaused,
    performanceFeeBps: Number(performanceFeeBps),
    depositors: new Set(events("Deposited").map((e) => e.account.toLowerCase()))
      .size,
    estimatedAssets: marked,
    estimatedPricePerShare: shares > 0 ? marked / shares : 1,
    maxLoss,
    lastPricePerShare: history.at(-1)?.pricePerShare ?? 1,
    series: ids,
    history,
    totalFees: history.reduce((sum, h) => sum + h.fee, 0),
    rootEpoch: Number(rootEpoch),
  };
}

if (house)
  extendSnapshot(async (snapshot, blockNumber) => {
    try {
      return { house: await houseState(snapshot, blockNumber) };
    } catch (error) {
      // Keep serving the last confirmed vault view rather than dropping it.
      recordWorkerError(
        `House state: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { house: current()?.house };
    }
  });

export async function houseAccount(address: Address): Promise<HouseAccount> {
  if (!house) throw new Error("This deployment has no house vault");
  const [epoch, shares, receipt, withdrawal, withdrawable, cash] =
    await Promise.all([
      readVault<bigint>("epoch"),
      readVault<bigint>("shareBalance", [address]),
      readVault<readonly [bigint, bigint, bigint]>("depositReceipts", [
        address,
      ]),
      readVault<readonly [bigint, bigint]>("withdrawals", [address]),
      readVault<bigint>("withdrawableAssets", [address]),
      client.readContract({
        address: manifest.usdc,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [address],
      }) as Promise<bigint>,
    ]);
  const price = current()?.house?.estimatedPricePerShare ?? 1;
  return {
    address,
    usdc: usd(cash),
    shares: usd(shares),
    value: usd(shares) * price,
    pendingDeposit: receipt[0] === epoch ? usd(receipt[1]) : 0,
    withdrawal: {
      epoch: Number(withdrawal[0]),
      shares: usd(withdrawal[1]),
      ready: withdrawal[1] > 0n && withdrawal[0] < epoch,
      assets: usd(withdrawable),
    },
  };
}

// ------------------------------------------------------------------ points

const houseAccounts = () =>
  new Set([manifest.maker.toLowerCase(), house?.vault.toLowerCase()]);

/** Points from indexed vault activity and settled fills against the house. */
export function pointsInput(snapshot: Snapshot): PointsInput {
  if (!house) throw new Error("This deployment has no house vault");
  const makers = houseAccounts();
  return {
    genesisStart: house.genesisStart,
    launchTime: house.launchTime,
    rolls: events("Rolled").map((e) => ({
      epoch: Number(e.epoch),
      pricePerShare: BigInt(e.pricePerShare),
      timestamp: e.at,
    })),
    deposits: events("Deposited").map((e) => ({
      account: e.account as Address,
      epoch: Number(e.epoch),
      amount: BigInt(e.amount),
      timestamp: e.at,
    })),
    cancellations: events("DepositCancelled").map((e) => ({
      account: e.account as Address,
      epoch: Number(e.epoch),
      amount: BigInt(e.amount),
      timestamp: e.at,
    })),
    withdrawals: events("WithdrawRequested").map((e) => ({
      account: e.account as Address,
      epoch: Number(e.epoch),
      shares: BigInt(e.shares),
    })),
    fills: tradeHistory()
      .filter(
        (t) =>
          makers.has(t.maker.toLowerCase()) &&
          !makers.has(t.taker.toLowerCase()),
      )
      .map((t) => ({
        account: t.taker,
        seriesId: t.marketId,
        isBuy: t.isBuy,
        quantity: BigInt(Math.round(t.quantity * 1000)) * 10n ** 15n,
        cost: BigInt(Math.round(t.quote * 1e6)),
      })),
    settlements: snapshot.markets
      .filter((m) => m.settlementPrice !== null)
      .map((m) => ({
        seriesId: m.id,
        expiry: m.expiry,
        payoutPerClaim: BigInt(
          Math.round(payoffPerClaim(m, m.settlementPrice!) * 1e6),
        ),
      })),
  };
}

interface PublishedRewards {
  epoch: number;
  root: Hex;
  tree: RewardTree;
}
const rewardsKey = house
  ? `house-rewards:${manifest.chainId}:${house.vault.toLowerCase()}`
  : "";
const rewardsPath = house
  ? `${runtimeDirectory}/house-rewards-${house.vault.toLowerCase()}.json`
  : "";
let published: PublishedRewards | undefined;

export async function loadPublishedRewards() {
  if (published || !house) return published;
  if (cloudEnabled)
    published = await loadCloudState<PublishedRewards>(rewardsKey);
  else if (existsSync(rewardsPath))
    published = JSON.parse(readFileSync(rewardsPath, "utf8"));
  return published;
}

async function savePublishedRewards(value: PublishedRewards) {
  if (cloudEnabled) await saveCloudState(rewardsKey, value);
  else {
    const temporary = `${rewardsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
    renameSync(temporary, rewardsPath);
  }
  published = value;
}

/**
 * Publishes cumulative STRATA for every account with points. Cumulative amounts
 * never decrease, so a later root can only add to what was claimable before.
 */
export async function publishRewards(snapshot: Snapshot) {
  if (!house) return;
  const epoch = snapshot.house?.epoch ?? 0;
  const [root, rootEpoch] = (await Promise.all(
    ["root", "rootEpoch"].map((functionName) =>
      client.readContract({
        address: house.distributor,
        abi: distributorAbi,
        functionName,
      }),
    ),
  )) as [Hex, bigint];
  if (rootEpoch >= BigInt(epoch)) return;
  // A cached tree only counts if the distributor still holds it (local
  // checkpoint restores rewind the chain but not this cache).
  const cached = await loadPublishedRewards();
  const previous = cached?.root === root ? cached.tree.proofs : {};
  const cumulative = new Map(
    Object.entries(previous).map(([account, p]) => [
      account,
      BigInt(p.cumulative),
    ]),
  );
  for (const [account, p] of computePoints(pointsInput(snapshot))) {
    const next = pointsToStrata(p.total);
    if (next > (cumulative.get(account) ?? 0n)) cumulative.set(account, next);
  }
  if (!cumulative.size) return;
  const tree = buildRewardTree(
    [...cumulative].map(([account, value]) => ({
      account: account as Address,
      cumulative: value,
    })),
  );
  await send(house.operator, house.distributor, distributorAbi, "publish", [
    tree.root,
    BigInt(epoch),
  ]);
  await savePublishedRewards({ epoch, root: tree.root, tree });
}

const toPoints = (micro: bigint) => Number(micro) / Number(MICRO_POINTS);

export async function rewardsAccount(
  address: Address,
  snapshot: Snapshot,
): Promise<RewardsAccount> {
  if (!house) throw new Error("This deployment has no house vault");
  const live = computePoints(pointsInput(snapshot)).get(address.toLowerCase());
  const points: PointsBreakdown = {
    genesis: toPoints(live?.genesis ?? 0n),
    deposits: toPoints(live?.deposits ?? 0n),
    losses: toPoints(live?.losses ?? 0n),
    total: toPoints(live?.total ?? 0n),
  };
  const rewards = await loadPublishedRewards();
  const onchainRoot = (await client.readContract({
    address: house.distributor,
    abi: distributorAbi,
    functionName: "root",
  })) as Hex;
  // Only serve proofs for the root the distributor actually holds.
  const entry =
    rewards && rewards.root === onchainRoot
      ? rewards.tree.proofs[address.toLowerCase()]
      : undefined;
  const [claimed, strata, staked, cooling, unlockAt, earned, totalStaked] =
    (await Promise.all([
      client.readContract({
        address: house.distributor,
        abi: distributorAbi,
        functionName: "claimed",
        args: [address],
      }),
      client.readContract({
        address: house.strata,
        abi: strataAbi,
        functionName: "balanceOf",
        args: [address],
      }),
      ...["staked", "cooling", "unlockAt", "earned"].map((functionName) =>
        client.readContract({
          address: house.staking,
          abi: stakingAbi,
          functionName,
          args: [address],
        }),
      ),
      client.readContract({
        address: house.staking,
        abi: stakingAbi,
        functionName: "totalStaked",
      }),
    ])) as bigint[];
  const token = (raw: bigint) => Number(raw) / 1e18;
  const cumulative = BigInt(entry?.cumulative ?? "0");
  return {
    address,
    points,
    unpublished: Math.max(0, points.total - token(cumulative)),
    claim: entry
      ? {
          epoch: rewards!.epoch,
          cumulative: entry.cumulative,
          proof: entry.proof,
        }
      : null,
    claimed: token(claimed),
    claimable: token(cumulative > claimed ? cumulative - claimed : 0n),
    strata: token(strata),
    staked: token(staked),
    cooling: token(cooling),
    unlockAt: Number(unlockAt),
    earned: usd(earned),
    totalStaked: token(totalStaked),
  };
}
