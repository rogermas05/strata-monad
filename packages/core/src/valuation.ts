import { expiryPayoff, priceOption } from "./analytics.ts";
import type { Greeks, Kind, DepthLevel } from "./types.ts";
export function markSeries(
  kind: Kind,
  spot: number,
  strike: number,
  upperStrike: number,
  years: number,
  volatility: number,
  settlementPrice: number | null,
): Greeks {
  if (settlementPrice !== null) {
    const payoff = expiryPayoff(kind, settlementPrice, strike, upperStrike);
    const delta = kind === "call" ? payoff / settlementPrice : 0;
    return {
      price: kind === "call" ? delta * spot : payoff,
      delta,
      gamma: 0,
      vega: 0,
      theta: 0,
    };
  }
  // No reference yet (e.g. listed while the session is closed): nothing to mark.
  if (!(spot > 0)) return { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0 };
  return priceOption(kind, spot, strike, upperStrike, years, volatility);
}
export function quoteDepth(levels: DepthLevel[], quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0)
    return { total: 0, filled: 0, complete: false };
  let left = quantity,
    total = 0;
  for (const l of levels) {
    const fill = Math.min(left, l.quantity);
    total += fill * l.price;
    left -= fill;
    if (left <= 0) break;
  }
  return { total, filled: quantity - left, complete: left < 1e-9 };
}
