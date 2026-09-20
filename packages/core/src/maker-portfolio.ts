const abs = (n: bigint) => (n < 0n ? -n : n);
const positive = (n: bigint) => (n > 0n ? n : 0n);
const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
export interface MakerRiskPosition {
  marketId: number;
  expiry: number;
  heldClaims: bigint;
  writtenClaims: bigint;
  bidClaims: bigint;
  askClaims: bigint;
}
export interface MakerPortfolioLimits {
  maxGrossClaims: bigint;
  maxExpiryClaims: bigint;
  maxWrittenClaims: bigint;
  maxSeriesClaims: bigint;
}
/** Conservative claim-notional limits. No cross-series hedge or model delta credit. */
export function makerPortfolioRisk(
  positions: MakerRiskPosition[],
  limits: MakerPortfolioLimits,
) {
  if (
    Object.values(limits).some((n) => n <= 0n || n >= 2n ** 256n) ||
    new Set(positions.map((p) => p.marketId)).size !== positions.length ||
    positions.some(
      (p) =>
        !Number.isSafeInteger(p.marketId) ||
        p.marketId <= 0 ||
        !Number.isSafeInteger(p.expiry) ||
        p.expiry < 0 ||
        [p.heldClaims, p.writtenClaims, p.bidClaims, p.askClaims].some(
          (n) => n < 0n || n >= 2n ** 256n,
        ),
    )
  )
    throw new Error("Invalid maker portfolio risk inputs");
  const exposures = positions.map((p) => {
    const netClaims = p.heldClaims - p.writtenClaims;
    const grossClaims = abs(netClaims);
    // Any partial fill of either side lies inside these two endpoints.
    const endpoints = [
      grossClaims,
      abs(netClaims + p.bidClaims),
      abs(netClaims - p.askClaims),
    ];
    const reservedGrossClaims = endpoints.reduce((a, b) => (a > b ? a : b));
    return { ...p, netClaims, grossClaims, reservedGrossClaims };
  });
  const grossClaims = exposures.reduce((sum, p) => sum + p.grossClaims, 0n);
  const reservedGrossClaims = exposures.reduce(
    (sum, p) => sum + p.reservedGrossClaims,
    0n,
  );
  const writtenClaims = exposures.reduce((sum, p) => sum + p.writtenClaims, 0n);
  const expiries = [...new Set(exposures.map((p) => p.expiry))]
    .sort((a, b) => a - b)
    .map((expiry) => {
      const group = exposures.filter((p) => p.expiry === expiry);
      return {
        expiry,
        grossClaims: group.reduce((sum, p) => sum + p.grossClaims, 0n),
        reservedGrossClaims: group.reduce(
          (sum, p) => sum + p.reservedGrossClaims,
          0n,
        ),
      };
    });
  const markets = exposures.map((p) => {
    const group = expiries.find((e) => e.expiry === p.expiry)!;
    const budget = min(
      limits.maxSeriesClaims,
      positive(
        limits.maxGrossClaims - (reservedGrossClaims - p.reservedGrossClaims),
      ),
      positive(
        limits.maxExpiryClaims -
          (group.reservedGrossClaims - p.reservedGrossClaims),
      ),
    );
    // A pre-existing breach permits only the side that reduces toward flat.
    // Do not allow crossing through flat until the portfolio is within budget.
    const bidClaims =
      p.netClaims < -budget
        ? -p.netClaims
        : p.netClaims > budget
          ? 0n
          : budget - p.netClaims;
    const askClaims =
      p.netClaims > budget
        ? p.netClaims
        : p.netClaims < -budget
          ? 0n
          : budget + p.netClaims;
    return { marketId: p.marketId, bidClaims, askClaims };
  });
  return {
    grossClaims,
    reservedGrossClaims,
    writtenClaims,
    expiries,
    markets,
    issuanceCapacity: positive(limits.maxWrittenClaims - writtenClaims),
    actualBreached:
      grossClaims > limits.maxGrossClaims ||
      expiries.some((e) => e.grossClaims > limits.maxExpiryClaims) ||
      exposures.some((p) => p.grossClaims > limits.maxSeriesClaims),
    reservationBreached:
      reservedGrossClaims > limits.maxGrossClaims ||
      expiries.some((e) => e.reservedGrossClaims > limits.maxExpiryClaims) ||
      exposures.some((p) => p.reservedGrossClaims > limits.maxSeriesClaims),
    issuanceBreached: writtenClaims > limits.maxWrittenClaims,
  };
}
