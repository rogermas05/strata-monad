import { expect, it } from "vitest";
import { markSeries, quoteDepth } from "./valuation.ts";
it("uses the immutable expiry reference for settled claims while valuing WMON at live spot", () => {
  const c = markSeries("call", 1.03, 1.05, 0, 0, 0.85, 1.2);
  expect(c.price).toBeCloseTo(0.12875, 10);
  expect(c.delta).toBeCloseTo(0.125, 10);
  const p = markSeries("put", 0.9, 1.05, 0, 0, 0.85, 1.2);
  expect(p.price).toBe(0);
  expect(p.delta).toBe(0);
});
it("leaves a market without any reference price unmarked instead of failing", () => {
  // A scheduled asset listed while its session is closed has no price yet.
  const unpriced = markSeries("put", 0, 650, 0, 0.02, 0.18, null);

  expect(unpriced).toEqual({ price: 0, delta: 0, gamma: 0, vega: 0, theta: 0 });
});
it("quotes the actual depth ladder and detects insufficient depth", () => {
  const levels = [
    { price: 0.11, quantity: 5, total: 5, orders: 1 },
    { price: 0.12, quantity: 10, total: 15, orders: 1 },
  ];
  expect(quoteDepth(levels, 10).total).toBeCloseTo(1.15, 10);
  expect(quoteDepth(levels, 16).complete).toBe(false);
  expect(quoteDepth(levels, NaN).complete).toBe(false);
});
