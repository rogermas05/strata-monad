import { expect, it } from "vitest";
import { minutePrices, reuseIdlePass } from "./cloud-retention.ts";

it("retains the newest real observation per minute without changing original history", () => {
  const prices = [
    { timestamp: 60, price: 1 },
    { timestamp: 70, price: 2 },
    { timestamp: 130, price: 3 },
  ];
  expect(minutePrices(prices)).toEqual([prices[1], prices[2]]);
  expect(prices).toHaveLength(3);
});

it("bypasses idle throttling for a wake, stale data, missing data, and clock reversal", () => {
  const previous = { status: "ready", mode: "display", lastSuccess: 100_000 };
  expect(reuseIdlePass(120_000, 0, previous)).toBe(true);
  expect(reuseIdlePass(120_000, 130_000, previous)).toBe(false);
  expect(reuseIdlePass(160_000, 0, previous)).toBe(false);
  expect(reuseIdlePass(90_000, 0, previous)).toBe(false);
  expect(reuseIdlePass(120_000, 0)).toBe(false);
  expect(reuseIdlePass(120_000, 0, { ...previous, status: "failed" })).toBe(
    false,
  );
  expect(reuseIdlePass(120_000, 0, { ...previous, mode: "trading" })).toBe(
    false,
  );
});
