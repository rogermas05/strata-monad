import type { Address } from "viem";

/**
 * Points rules. Amounts are USDC with 6 decimals, so "points per USDC" times a
 * raw USDC amount yields micro-points (1e6 = one point). One point converts to
 * one STRATA. Every rate decays 10% per trading epoch: early activity earns most.
 */
export const POINTS_RULES = {
  /** Per USDC lost to the house (vault or project maker) on settled contracts. */
  lossPerUsdc: 10n,
  /** Per USDC of vault value held through one trading epoch. */
  depositPerUsdcEpoch: 1n,
  /** One time, per USDC committed during genesis; scaled 1x–2x by how early. */
  genesisPerUsdc: 5n,
  decayNumerator: 9n,
  decayDenominator: 10n,
} as const;
export const MICRO_POINTS = 1_000_000n;
const PPS_UNIT = 10n ** 18n;
const CLAIM_UNIT = 10n ** 18n;

export interface PointsInput {
  genesisStart: number;
  launchTime: number;
  /** One entry per roll; `epoch` is the epoch the roll closed. */
  rolls: { epoch: number; pricePerShare: bigint; timestamp: number }[];
  deposits: {
    account: Address;
    epoch: number;
    amount: bigint;
    timestamp: number;
  }[];
  cancellations: {
    account: Address;
    epoch: number;
    amount: bigint;
    timestamp: number;
  }[];
  withdrawals: { account: Address; epoch: number; shares: bigint }[];
  /** Taker fills against house accounts. `cost` is premium paid or received. */
  fills: {
    account: Address;
    seriesId: number;
    isBuy: boolean;
    quantity: bigint;
    cost: bigint;
  }[];
  /** Settled series: USDC paid per whole claim. */
  settlements: { seriesId: number; expiry: number; payoutPerClaim: bigint }[];
}
export interface MicroPoints {
  genesis: bigint;
  deposits: bigint;
  losses: bigint;
  total: bigint;
}

type Ratio = { n: bigint; d: bigint };
const key = (account: string) => account.toLowerCase();

/** Rate multiplier for a trading epoch (epoch 1 earns the full rate). */
export function epochDecay(epoch: number): Ratio {
  const steps = BigInt(Math.max(0, epoch - 1));
  return {
    n: POINTS_RULES.decayNumerator ** steps,
    d: POINTS_RULES.decayDenominator ** steps,
  };
}

/** Trading epoch a timestamp falls in; genesis activity counts as epoch 1. */
function epochAt(rollTimes: number[], timestamp: number) {
  return Math.max(1, rollTimes.filter((t) => t <= timestamp).length);
}

function genesisPoints(input: PointsInput, account: string) {
  const window = BigInt(Math.max(1, input.launchTime - input.genesisStart));
  const events = [
    ...input.deposits
      .filter((d) => d.epoch === 0 && key(d.account) === account)
      .map((d) => ({ ...d, cancel: false })),
    ...input.cancellations
      .filter((c) => c.epoch === 0 && key(c.account) === account)
      .map((c) => ({ ...c, cancel: true })),
  ].sort(
    (a, b) => a.timestamp - b.timestamp || Number(a.cancel) - Number(b.cancel),
  );
  // Lots keep their own earliness; a cancellation removes the latest lots first.
  const lots: { amount: bigint; early: bigint }[] = [];
  for (const event of events) {
    if (!event.cancel) {
      const before = BigInt(
        Math.min(
          input.launchTime - input.genesisStart,
          Math.max(0, input.launchTime - event.timestamp),
        ),
      );
      lots.push({ amount: event.amount, early: before });
      continue;
    }
    let left = event.amount;
    while (left > 0n && lots.length) {
      const last = lots[lots.length - 1];
      const taken = last.amount < left ? last.amount : left;
      last.amount -= taken;
      left -= taken;
      if (last.amount === 0n) lots.pop();
    }
  }
  return lots.reduce(
    (sum, lot) =>
      sum +
      (lot.amount * POINTS_RULES.genesisPerUsdc * (window + lot.early)) /
        window,
    0n,
  );
}

function depositPoints(
  input: PointsInput,
  account: string,
  prices: Map<number, bigint>,
) {
  const net = new Map<number, bigint>();
  for (const d of input.deposits)
    if (key(d.account) === account)
      net.set(d.epoch, (net.get(d.epoch) ?? 0n) + d.amount);
  for (const c of input.cancellations)
    if (key(c.account) === account)
      net.set(c.epoch, (net.get(c.epoch) ?? 0n) - c.amount);
  let points = 0n;
  // Epoch k is complete once the roll closing it exists; its shares were priced by earlier rolls.
  for (const roll of input.rolls) {
    const k = roll.epoch;
    const start = prices.get(k - 1);
    if (k < 1 || start === undefined) continue;
    let shares = 0n;
    for (const [epoch, amount] of net)
      if (epoch <= k - 1 && amount > 0n && prices.has(epoch))
        shares += (amount * PPS_UNIT) / prices.get(epoch)!;
    for (const w of input.withdrawals)
      if (key(w.account) === account && w.epoch <= k - 1) shares -= w.shares;
    if (shares <= 0n) continue;
    const value = (shares * start) / PPS_UNIT;
    const decay = epochDecay(k);
    points += (value * POINTS_RULES.depositPerUsdcEpoch * decay.n) / decay.d;
  }
  return points;
}

function lossPoints(input: PointsInput, account: string, rollTimes: number[]) {
  const settled = new Map(input.settlements.map((s) => [s.seriesId, s]));
  const books = new Map<
    number,
    { bought: bigint; sold: bigint; cost: bigint; proceeds: bigint }
  >();
  for (const fill of input.fills) {
    if (key(fill.account) !== account || !settled.has(fill.seriesId)) continue;
    const book = books.get(fill.seriesId) ?? {
      bought: 0n,
      sold: 0n,
      cost: 0n,
      proceeds: 0n,
    };
    if (fill.isBuy) {
      book.bought += fill.quantity;
      book.cost += fill.cost;
    } else {
      book.sold += fill.quantity;
      book.proceeds += fill.cost;
    }
    books.set(fill.seriesId, book);
  }
  let points = 0n;
  for (const [seriesId, book] of books) {
    const s = settled.get(seriesId)!;
    const held = book.bought > book.sold ? book.bought - book.sold : 0n;
    const loss =
      book.cost - book.proceeds - (held * s.payoutPerClaim) / CLAIM_UNIT;
    if (loss <= 0n) continue;
    const decay = epochDecay(epochAt(rollTimes, s.expiry));
    points += (loss * POINTS_RULES.lossPerUsdc * decay.n) / decay.d;
  }
  return points;
}

/** Deterministic points per account, keyed by lowercase address. */
export function computePoints(input: PointsInput): Map<string, MicroPoints> {
  const prices = new Map(input.rolls.map((r) => [r.epoch, r.pricePerShare]));
  const rollTimes = input.rolls.map((r) => r.timestamp).sort((a, b) => a - b);
  const accounts = new Set(
    [...input.deposits, ...input.fills].map((e) => key(e.account)),
  );
  const result = new Map<string, MicroPoints>();
  for (const account of [...accounts].sort()) {
    const genesis = genesisPoints(input, account);
    const deposits = depositPoints(input, account, prices);
    const losses = lossPoints(input, account, rollTimes);
    const total = genesis + deposits + losses;
    if (total > 0n) result.set(account, { genesis, deposits, losses, total });
  }
  return result;
}

/** One point is one STRATA (18 decimals). */
export function pointsToStrata(micro: bigint) {
  return micro * 10n ** 12n;
}
