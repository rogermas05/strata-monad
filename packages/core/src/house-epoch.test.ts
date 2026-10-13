import { describe, expect, test } from "vitest";
import type { Address } from "viem";
import type { SeriesConfig } from "./types.ts";
import { houseQuoteBudget, selectEpochSeries } from "./house-epoch.ts";

const zero = "0x0000000000000000000000000000000000000001" as Address;
const day = 86400;
const series = (
  id: number,
  kind: SeriesConfig["kind"],
  expiry: number,
): SeriesConfig => ({
  id,
  kind,
  expiry,
  token: zero,
  market: zero,
  venue: zero,
  symbol: `S${id}`,
  strike: 100,
  upperStrike: kind.endsWith("spread") ? 110 : 0,
  asset: "SPY",
});

describe("selectEpochSeries", () => {
  const now = 1_000_000;
  const shelf = [
    series(1, "call", now + 2 * day),
    series(2, "put", now + 2 * day),
    series(3, "bull-spread", now + 5 * day),
    series(4, "bear-spread", now + 8 * day + 1),
    series(5, "put", now + 1800),
    series(6, "put", now + 3 * day),
  ];

  test("takes cash-settled series inside the nearest window", () => {
    expect(selectEpochSeries(shelf, now, new Set())).toEqual([2, 3, 6]);
  });

  test("skips traded series and moves to the next window", () => {
    expect(selectEpochSeries(shelf, now, new Set([2, 3, 6]))).toEqual([4]);
  });

  test("returns nothing when no series qualifies", () => {
    expect(
      selectEpochSeries([series(1, "call", now + day)], now, new Set()),
    ).toEqual([]);
  });
});

describe("houseQuoteBudget", () => {
  test("splits capital across series and sides", () => {
    // 10,000 USDC over 4 series = 2,500 each: 2,000 for asks, 500 for bids.
    const budget = houseQuoteBudget({
      managedAssets: 10_000_000_000n,
      seriesCount: 4,
      collateralPerClaim: 100_000_000n,
      bidPrice: 2_000_000,
      targetLots: 100_000n,
    });
    expect(budget).toEqual({ askLots: 20_000n, bidLots: 100_000n });
  });

  test("never exceeds the target and handles a missing bid", () => {
    const budget = houseQuoteBudget({
      managedAssets: 10n ** 15n,
      seriesCount: 1,
      collateralPerClaim: 1_000_000n,
      bidPrice: 0,
      targetLots: 5_000n,
    });
    expect(budget).toEqual({ askLots: 5_000n, bidLots: 0n });
  });

  test("rejects invalid inputs", () => {
    expect(() =>
      houseQuoteBudget({
        managedAssets: 1n,
        seriesCount: 0,
        collateralPerClaim: 1n,
        bidPrice: 1,
        targetLots: 1n,
      }),
    ).toThrow();
  });
});
