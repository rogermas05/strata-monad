/** A request funds one pass, never a background trading session. */
export const TRADING_REQUEST_MS = 120_000;
export const TRADING_COOLDOWN_MS = 30_000;
export type TradingDemand = { at: number; marketIds: number[] };

export function pendingTradingDemand(
  demand: TradingDemand | undefined,
  consumedAt: number,
  now = Date.now(),
) {
  return (
    !!demand &&
    Array.isArray(demand.marketIds) &&
    demand.marketIds.length > 0 &&
    demand.at > consumedAt &&
    demand.at <= now &&
    now - demand.at < TRADING_REQUEST_MS
  );
}

export function requestedMarkets(
  input: unknown,
  series: { id: number; expiry: number }[],
  now = Date.now(),
) {
  const ids = (input as { marketIds?: unknown })?.marketIds;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 4 ||
    ids.some(
      (id) =>
        !Number.isSafeInteger(id) ||
        !series.some((s) => s.id === id && s.expiry * 1000 > now),
    )
  )
    throw new Error("Choose one to four unexpired markets");
  return [...new Set(ids)] as number[];
}
