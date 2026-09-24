import type { Greeks, Kind } from "./types.ts";
const pdf = (x: number) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
export function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const p =
    1 -
    pdf(x) *
      t *
      (0.31938153 +
        t *
          (-0.356563782 +
            t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? p : 1 - p;
}
export function vanilla(
  spot: number,
  strike: number,
  years: number,
  volatility: number,
  isCall: boolean,
  rate = 0,
): Greeks {
  if (
    ![spot, strike, years, volatility, rate].every(Number.isFinite) ||
    spot <= 0 ||
    strike <= 0 ||
    volatility < 0
  )
    throw new Error("Invalid pricing input");
  if (years <= 0 || volatility === 0) {
    const discountedStrike = strike * Math.exp(-rate * Math.max(years, 0));
    return {
      price: Math.max(
        isCall ? spot - discountedStrike : discountedStrike - spot,
        0,
      ),
      delta: isCall
        ? Number(spot > discountedStrike)
        : -Number(spot < discountedStrike),
      gamma: 0,
      vega: 0,
      theta: 0,
    };
  }
  const root = Math.sqrt(years),
    d1 =
      (Math.log(spot / strike) + (rate + volatility ** 2 / 2) * years) /
      (volatility * root),
    d2 = d1 - volatility * root;
  const discounted = strike * Math.exp(-rate * years),
    density = pdf(d1);
  return {
    price: Math.max(
      isCall
        ? spot * normalCDF(d1) - discounted * normalCDF(d2)
        : discounted * normalCDF(-d2) - spot * normalCDF(-d1),
      0,
    ),
    delta: isCall ? normalCDF(d1) : normalCDF(d1) - 1,
    gamma: density / (spot * volatility * root),
    vega: (spot * density * root) / 100,
    theta:
      ((-spot * density * volatility) / (2 * root) +
        (isCall
          ? -rate * discounted * normalCDF(d2)
          : rate * discounted * normalCDF(-d2))) /
      365,
  };
}
export function priceOption(
  kind: Kind,
  spot: number,
  strike: number,
  upper: number,
  years: number,
  iv: number,
): Greeks {
  const lower = vanilla(
    spot,
    strike,
    years,
    iv,
    kind === "call" || kind === "bull-spread",
  );
  if (kind === "call" || kind === "put") return lower;
  if (upper <= strike) throw new Error("Invalid spread strikes");
  const higher = vanilla(spot, upper, years, iv, kind === "bull-spread");
  const a = kind === "bull-spread" ? lower : higher,
    b = kind === "bull-spread" ? higher : lower;
  return {
    price: Math.max(a.price - b.price, 0),
    delta: a.delta - b.delta,
    gamma: a.gamma - b.gamma,
    vega: a.vega - b.vega,
    theta: a.theta - b.theta,
  };
}
export function impliedVolatility(
  premium: number,
  spot: number,
  strike: number,
  years: number,
  isCall: boolean,
): number | null {
  if (
    ![premium, spot, strike, years].every(Number.isFinite) ||
    years <= 0 ||
    spot <= 0 ||
    strike <= 0 ||
    premium <= Math.max(isCall ? spot - strike : strike - spot, 0) ||
    premium >= (isCall ? spot : strike)
  )
    return null;
  let lo = 0.00001,
    hi = 10;
  if (vanilla(spot, strike, years, hi, isCall).price < premium) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (vanilla(spot, strike, years, mid, isCall).price < premium) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
/** Quote-value payoff; call receipts onchain are denominated in underlying, not USDC. */
export function expiryPayoff(
  kind: Kind,
  spot: number,
  strike: number,
  upper = 0,
): number {
  if (kind === "call") return Math.max(spot - strike, 0);
  if (kind === "put") return Math.max(strike - spot, 0);
  return kind === "bull-spread"
    ? Math.min(Math.max(spot - strike, 0), upper - strike)
    : Math.min(Math.max(upper - spot, 0), upper - strike);
}
export function collateral(
  kind: Kind,
  quantity: number,
  strike: number,
  upper = 0,
): { amount: number; currency: "WMON" | "dUSDC" } {
  return kind === "call"
    ? { amount: quantity, currency: "WMON" }
    : {
        amount: quantity * (kind === "put" ? strike : upper - strike),
        currency: "dUSDC",
      };
}
