const DEFAULT_LEVEL_STEP = 3000;
const DEFAULT_TOLERANCE = 200;

/** Level spacing: the usual step, tightened for premiums it would dwarf. */
export function ladderStep(ask: number) {
  return Math.max(1, Math.min(DEFAULT_LEVEL_STEP, Math.round(ask * 0.1)));
}

/**
 * How far (micro-units) a resting quote may sit from its target before it is
 * replaced: 2% for small premiums, 0.2% for large ones, 200 in between.
 */
export function requoteTolerance(price: number, publicSpreadBps?: number) {
  return Math.max(
    1,
    Math.min(DEFAULT_TOLERANCE, Math.round(price * 0.02)),
    Math.round(price * 0.002),
    // Public gas is scarce: reprice after half the configured spread moves.
    publicSpreadBps === undefined
      ? 0
      : Math.floor((price * publicSpreadBps) / 20_000),
  );
}

/**
 * Quote size in lots (0.001 contracts) per side: the configured target, capped
 * so one side's underlying notional stays within `maxNotional` dollars.
 */
export function targetLots(
  targetContracts: number,
  spot: number,
  maxNotional: number,
) {
  const configured = BigInt(targetContracts) * 1000n;
  if (!(spot > 0)) return configured;
  const capped = BigInt(Math.max(1, Math.floor((maxNotional / spot) * 1000)));
  return capped < configured ? capped : configured;
}

/** Keep funded depth through small size changes while honoring current risk limits. */
export function restingDepthSufficient(
  resting: bigint,
  desired: bigint,
  capacity: bigint,
) {
  return desired === 0n
    ? resting === 0n
    : resting * 10n >= desired * 7n && resting <= capacity;
}

/** Highest price a book can hold: uint32 micro-units, about 4,294.97 dUSDC. */
export const MAX_VENUE_PRICE = 2 ** 32 - 1;

/**
 * Native Kuru sizes: one lot is 0.001 contracts; prices are dUSDC micro-units.
 * An ask above the venue's price limit is simply not offered.
 */
export function makerLadder(input: {
  bid: number;
  ask: number;
  targetLots: bigint;
  availableAskLots: bigint;
  bidCapacityLots?: bigint;
  askCapacityLots?: bigint;
  externalBid?: number;
  externalAsk?: number;
  /** Price distance between ladder levels in micro-units. */
  levelStep?: number;
}) {
  const maxPrice = 2 ** 32 - 1;
  const step = input.levelStep ?? DEFAULT_LEVEL_STEP;
  if (
    !Number.isSafeInteger(input.bid) ||
    !Number.isSafeInteger(input.ask) ||
    input.bid < 1 ||
    input.ask < 1 ||
    input.bid > maxPrice ||
    input.targetLots < 1n ||
    input.availableAskLots < 0n ||
    (input.bidCapacityLots !== undefined && input.bidCapacityLots < 0n) ||
    (input.askCapacityLots !== undefined && input.askCapacityLots < 0n)
  )
    throw new Error("Invalid maker ladder inputs");
  const bid = Math.min(
    input.bid,
    input.externalAsk === undefined ? maxPrice : input.externalAsk - 1,
  );
  const ask = Math.max(input.ask, bid + 1, (input.externalBid ?? 0) + 1);
  function sizes(total: bigint) {
    const a = total < 10000n ? total : 10000n;
    const b = total - a < 25000n ? total - a : 25000n;
    return [a, b, total - a - b].filter((x) => x > 0n);
  }
  const buyTotal =
    input.bidCapacityLots !== undefined &&
    input.bidCapacityLots < input.targetLots
      ? input.bidCapacityLots
      : input.targetLots;
  const buySizes = bid > 0 ? sizes(buyTotal) : [];
  const buyPrices = buySizes.map((_, i) => Math.max(1, bid - i * step));
  let offered =
    input.availableAskLots < input.targetLots
      ? input.availableAskLots
      : input.targetLots;
  if (input.askCapacityLots !== undefined && offered > input.askCapacityLots)
    offered = input.askCapacityLots;
  const sellSizes = ask <= maxPrice ? sizes(offered) : [];
  const sellPrices = sellSizes.map((_, i) =>
    Math.min(maxPrice, ask + i * step),
  );
  const quoteReserve = buyPrices.reduce(
    (sum, price, i) => sum + (BigInt(price) * buySizes[i] + 999n) / 1000n,
    0n,
  );
  return { buyPrices, buySizes, sellPrices, sellSizes, quoteReserve };
}

/** Self-issued inventory offsets its own writer obligation; selling it creates net short exposure. */
export function makerInventoryPolicy(input: {
  heldClaims: bigint;
  writtenClaims: bigint;
  maxNetInventory: bigint;
  inventorySkewBps: number;
  fair: number;
}) {
  if (
    input.heldClaims < 0n ||
    input.writtenClaims < 0n ||
    input.maxNetInventory <= 0n ||
    !Number.isInteger(input.inventorySkewBps) ||
    input.inventorySkewBps < 0 ||
    input.inventorySkewBps > 5000 ||
    !Number.isFinite(input.fair) ||
    input.fair < 0
  )
    throw new Error("Invalid maker inventory policy inputs");
  const netClaims = input.heldClaims - input.writtenClaims;
  const buyCapacity = input.maxNetInventory - netClaims;
  const sellCapacity = input.maxNetInventory + netClaims;
  const boundedNet =
    netClaims > input.maxNetInventory
      ? input.maxNetInventory
      : netClaims < -input.maxNetInventory
        ? -input.maxNetInventory
        : netClaims;
  // Ratio is converted only after bounding; all custody and capacity arithmetic stays integer.
  const ratio =
    Number((boundedNet * 1_000_000n) / input.maxNetInventory) / 1_000_000;
  const priceSkewBps = -ratio * input.inventorySkewBps;
  return {
    netClaims,
    bidCapacityLots: buyCapacity > 0n ? buyCapacity / 10n ** 15n : 0n,
    askCapacityLots: sellCapacity > 0n ? sellCapacity / 10n ** 15n : 0n,
    priceSkewBps,
    reservationPrice: input.fair * (1 + priceSkewBps / 10_000),
  };
}
