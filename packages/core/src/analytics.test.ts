import { describe, it, expect } from "vitest";
import {
  vanilla,
  impliedVolatility,
  priceOption,
  expiryPayoff,
  collateral,
} from "./analytics.ts";
describe("financial model", () => {
  it("matches the standard ATM call and put-call parity", () => {
    const call = vanilla(100, 100, 1, 0.2, true, 0.05),
      put = vanilla(100, 100, 1, 0.2, false, 0.05);
    expect(call.price).toBeCloseTo(10.45058, 4);
    expect(call.price - put.price).toBeCloseTo(100 - 100 * Math.exp(-0.05), 6);
  });
  it("inverts an admissible premium and rejects impossible premiums", () => {
    expect(
      impliedVolatility(
        vanilla(1.05, 1, 0.03, 0.85, true).price,
        1.05,
        1,
        0.03,
        true,
      ),
    ).toBeCloseTo(0.85, 6);
    expect(impliedVolatility(2, 1, 1, 0.03, true)).toBeNull();
  });
  it("native complementary spreads sum to width at expiry", () => {
    for (const spot of [0, 0.5, 1, 1.1, 1.2, 2])
      expect(
        expiryPayoff("bull-spread", spot, 1, 1.2) +
          expiryPayoff("bear-spread", spot, 1, 1.2),
      ).toBeCloseTo(0.2, 10);
    expect(
      priceOption("bull-spread", 1.1, 1, 1.2, 0.1, 0.85).price,
    ).toBeLessThan(0.2);
  });
  it("reports backing in the correct currency", () => {
    expect(collateral("call", 100, 1)).toEqual({
      amount: 100,
      currency: "WMON",
    });
    expect(collateral("bull-spread", 100, 1, 1.2).amount).toBeCloseTo(20);
  });
});
