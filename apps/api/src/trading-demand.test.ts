import { expect, it } from "vitest";
import { pendingTradingDemand, requestedMarkets } from "./trading-demand.ts";

it("processes each request once even when cron repeats, and expires abandoned requests", () => {
  const demand = { at: 100_000, marketIds: [48] };
  expect(pendingTradingDemand(demand, 0, 110_000)).toBe(true);
  expect(pendingTradingDemand(demand, 100_000, 110_000)).toBe(false);
  expect(pendingTradingDemand(demand, 0, 220_000)).toBe(false);
  expect(pendingTradingDemand(demand, 0, 90_000)).toBe(false);
  expect(pendingTradingDemand({ at: 100_000 } as any, 0, 110_000)).toBe(false);
});

it("limits demand to explicit unexpired books, including strategy legs", () => {
  const series = [
    { id: 48, expiry: 200 },
    { id: 49, expiry: 200 },
    { id: 1, expiry: 50 },
  ];
  expect(
    requestedMarkets({ marketIds: [48, 49, 48] }, series, 100_000),
  ).toEqual([48, 49]);
  for (const input of [
    {},
    { marketIds: [] },
    { marketIds: [1] },
    { marketIds: [99] },
    { marketIds: ["48"] },
    { marketIds: [48, 48, 48, 48, 48] },
  ])
    expect(() => requestedMarkets(input, series, 100_000)).toThrow();
});
