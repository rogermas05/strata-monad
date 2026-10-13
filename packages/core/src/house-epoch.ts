import type { SeriesConfig } from "./types.ts";

/** One epoch spans the first eligible expiry and anything within six days of it. */
export const EPOCH_WINDOW = 6 * 86400;
/** Series this close to expiry are not worth admitting. */
export const MIN_TIME_TO_EXPIRY = 3600;
/** Must match HouseVault.MAX_SERIES. */
export const MAX_EPOCH_SERIES = 64;
/** Vault quotes are pulled this long before expiry (the contract stops new ones at 60s). */
export const HOUSE_QUOTE_CUTOFF = 300;
/** Share of a series budget held as ask collateral; the rest funds bids. */
const ASK_SHARE = 8n;
const BUDGET_PARTS = 10n;

/** Cash-settled series the vault should trade next, nearest expiry window first. */
export function selectEpochSeries(
  series: SeriesConfig[],
  now: number,
  alreadyTraded: Set<number>,
): number[] {
  const candidates = series.filter(
    (s) =>
      s.kind !== "call" &&
      s.expiry > now + MIN_TIME_TO_EXPIRY &&
      !alreadyTraded.has(s.id),
  );
  if (!candidates.length) return [];
  const first = Math.min(...candidates.map((s) => s.expiry));
  return candidates
    .filter((s) => s.expiry < first + EPOCH_WINDOW)
    .map((s) => s.id)
    .sort((a, b) => a - b)
    .slice(0, MAX_EPOCH_SERIES);
}

/**
 * Lots (0.001 claims) the vault can afford on each side of one book. Managed
 * capital is split evenly across the epoch's series; within a series most of
 * it collateralizes asks and the rest reserves bids.
 */
export function houseQuoteBudget(input: {
  managedAssets: bigint;
  seriesCount: number;
  /** USDC (6 decimals) locked per whole claim written. */
  collateralPerClaim: bigint;
  /** Best bid in micro-USDC per whole claim. */
  bidPrice: number;
  targetLots: bigint;
}) {
  if (
    input.managedAssets < 0n ||
    !Number.isSafeInteger(input.seriesCount) ||
    input.seriesCount < 1 ||
    input.collateralPerClaim <= 0n ||
    !Number.isSafeInteger(input.bidPrice) ||
    input.bidPrice < 0 ||
    input.targetLots < 0n
  )
    throw new Error("Invalid house quote budget inputs");
  const perSeries = input.managedAssets / BigInt(input.seriesCount);
  const askBudget = (perSeries * ASK_SHARE) / BUDGET_PARTS;
  const bidBudget = perSeries - askBudget;
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  return {
    askLots: min(
      input.targetLots,
      (askBudget * 1000n) / input.collateralPerClaim,
    ),
    bidLots:
      input.bidPrice > 0
        ? min(input.targetLots, (bidBudget * 1000n) / BigInt(input.bidPrice))
        : 0n,
  };
}
