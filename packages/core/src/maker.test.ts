import { describe, it, expect } from "vitest";
import {
  makerLadder,
  makerInventoryPolicy,
  ladderStep,
  requoteTolerance,
  targetLots,
  restingDepthSufficient,
} from "./maker.ts";
describe("maker quoting across price scales", () => {
  it("keeps the usual ladder for ordinary premiums and tightens it for tiny ones", () => {
    expect(ladderStep(50000)).toBe(3000);
    expect(ladderStep(1000)).toBe(100);
    expect(ladderStep(3)).toBe(1);
    const ladder = makerLadder({
      bid: 900,
      ask: 1100,
      targetLots: 90000n,
      availableAskLots: 90000n,
      levelStep: ladderStep(1100),
    });
    expect(ladder.buyPrices).toEqual([900, 790, 680]);
    expect(ladder.sellPrices).toEqual([1100, 1210, 1320]);
  });
  it("replaces quotes on a relative move, not a fixed tick count", () => {
    expect(requoteTolerance(50000)).toBe(200);
    expect(requoteTolerance(1000)).toBe(20);
    expect(requoteTolerance(10)).toBe(1);
    expect(requoteTolerance(1_500_000_000)).toBe(3_000_000);
  });
  it("keeps public repricing inside half the quoted spread across price scales", () => {
    for (const price of [10, 1000, 50_000, 550_000_000]) {
      const tolerance = requoteTolerance(price, 1200);
      expect(tolerance).toBe(
        Math.max(requoteTolerance(price), Math.floor(price * 0.06)),
      );
      expect(tolerance).toBeLessThanOrEqual(Math.max(1, price * 0.12));
    }
    expect(requoteTolerance(50_000, 100)).toBe(250);
  });
  it("offers no asks above the venue price limit but still bids", () => {
    const ladder = makerLadder({
      bid: 4_000_000_000,
      ask: 4_400_000_000,
      targetLots: 1000n,
      availableAskLots: 1000n,
    });
    expect(ladder.sellSizes).toEqual([]);
    expect(ladder.buySizes).toEqual([1000n]);
  });
  it("caps quote size by underlying notional", () => {
    expect(targetLots(90, 1.03, 100_000)).toBe(90000n);
    expect(targetLots(90, 4000, 100_000)).toBe(25000n);
    expect(targetLots(90, 82_000, 100_000)).toBe(1219n);
    expect(targetLots(90, 0, 100_000)).toBe(90000n);
  });
});
describe("maker funding limits", () => {
  it("scales both sides down and caps excess inventory offered", () => {
    const l = makerLadder({
      bid: 30000,
      ask: 40000,
      targetLots: 1000n,
      availableAskLots: 90000n,
    });
    expect(l.buySizes).toEqual([1000n]);
    expect(l.sellSizes).toEqual([1000n]);
    expect(l.quoteReserve).toBe(30000n);
  });
  it("uses available claims and funds all bid levels exactly", () => {
    const l = makerLadder({
      bid: 30000,
      ask: 40000,
      targetLots: 90000n,
      availableAskLots: 27000n,
    });
    expect(l.buySizes).toEqual([10000n, 25000n, 55000n]);
    expect(l.sellSizes).toEqual([10000n, 17000n]);
    expect(l.quoteReserve).toBe(2295000n);
  });
  it("keeps every level post-only against other makers", () => {
    const l = makerLadder({
      bid: 30000,
      ask: 40000,
      targetLots: 100000n,
      availableAskLots: 100000n,
      externalAsk: 20000,
      externalBid: 50000,
    });
    expect(l.buyPrices.every((p) => p < 20000)).toBe(true);
    expect(l.sellPrices.every((p) => p > 50000)).toBe(true);
  });
  it("omits bids when there is no valid noncrossing tick", () => {
    const l = makerLadder({
      bid: 1,
      ask: 2,
      targetLots: 90000n,
      availableAskLots: 0n,
      externalAsk: 1,
    });
    expect(l.buySizes).toEqual([]);
    expect(l.quoteReserve).toBe(0n);
    expect(l.sellSizes).toEqual([]);
  });
});
describe("net maker option inventory", () => {
  const limit = 150n * 10n ** 18n;
  const policy = (held: bigint, written: bigint) =>
    makerInventoryPolicy({
      heldClaims: held * 10n ** 18n,
      writtenClaims: written * 10n ** 18n,
      maxNetInventory: limit,
      inventorySkewBps: 2000,
      fair: 0.1,
    });
  it("does not mistake fully funded self-issued claims for a directional option position", () => {
    const neutral = policy(90n, 90n);
    expect(neutral.netClaims).toBe(0n);
    expect(neutral.reservationPrice).toBe(0.1);
    const sold = policy(50n, 90n);
    const replenished = policy(90n, 130n);
    expect(sold).toEqual(replenished);
    expect(sold.priceSkewBps).toBeGreaterThan(0);
    expect(sold.reservationPrice).toBeGreaterThan(neutral.reservationPrice);
  });
  it("limits aggregate outstanding asks so a full fill cannot exceed the net short budget", () => {
    const p = policy(90n, 180n);
    const ladder = makerLadder({
      bid: 30000,
      ask: 40000,
      targetLots: 90000n,
      availableAskLots: 90000n,
      ...p,
    });
    const soldLots = ladder.sellSizes.reduce((sum, value) => sum + value, 0n);
    expect(soldLots).toBe(60000n);
    expect(p.netClaims - soldLots * 10n ** 15n).toBe(-limit);
    expect(policy(0n, 180n).askCapacityLots).toBe(0n);
  });
  it("bounds long accumulation, retains a reducing side after a limit is lowered, and skews oppositely", () => {
    const long = policy(200n, 0n);
    expect(long.bidCapacityLots).toBe(0n);
    expect(long.askCapacityLots).toBeGreaterThan(0n);
    expect(long.priceSkewBps).toBe(-2000);
    expect(long.reservationPrice).toBeCloseTo(0.08);
    expect(policy(0n, 200n).askCapacityLots).toBe(0n);
    expect(policy(0n, 200n).bidCapacityLots).toBeGreaterThan(0n);
  });
  it("rounds remaining risk capacity down to executable lots", () => {
    const p = makerInventoryPolicy({
      heldClaims: 0n,
      writtenClaims: limit - 10n ** 15n + 1n,
      maxNetInventory: limit,
      inventorySkewBps: 0,
      fair: 0,
    });
    expect(p.askCapacityLots).toBe(0n);
    expect(p.reservationPrice).toBe(0);
  });
});

describe("public resting depth", () => {
  it("keeps a buffered BTC book through small spot moves without exceeding the hard cap", () => {
    const resting = targetLots(3, 83000, 90000);
    for (const spot of [82900, 83000, 83100]) {
      expect(
        restingDepthSufficient(
          resting,
          targetLots(3, spot, 90000),
          targetLots(3, spot, 100000),
        ),
      ).toBe(true);
    }
    expect(
      restingDepthSufficient(
        resting,
        targetLots(3, 95000, 90000),
        targetLots(3, 95000, 100000),
      ),
    ).toBe(false);
  });
  it("replenishes depleted depth and removes quotes beyond a tightened risk budget", () => {
    expect(restingDepthSufficient(35n, 50n, 50n)).toBe(true);
    expect(restingDepthSufficient(34n, 50n, 50n)).toBe(false);
    expect(restingDepthSufficient(50n, 50n, 49n)).toBe(false);
    expect(restingDepthSufficient(1n, 0n, 50n)).toBe(false);
  });
});
