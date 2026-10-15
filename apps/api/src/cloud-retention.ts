import type { Snapshot } from "../../../packages/core/src/types.ts";

/** Persist one observed price per minute, retaining the latest observation. */
export function minutePrices(prices: Snapshot["prices"]): Snapshot["prices"] {
  const buckets = new Map<number, Snapshot["prices"][number]>();
  for (const point of prices)
    buckets.set(Math.floor(point.timestamp / 60), point);
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function retainedSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    prices: minutePrices(snapshot.prices),
    underlyings: Object.fromEntries(
      Object.entries(snapshot.underlyings).map(([key, value]) => [
        key,
        { ...value, prices: minutePrices(value.prices) },
      ]),
    ),
  };
}

/** Sleeping demos refresh once a minute; a wake always bypasses this throttle. */
export function reuseIdlePass(
  now: number,
  wakeUntil: number,
  previous?: { status?: string; mode?: string; lastSuccess?: number },
) {
  const age = now - (previous?.lastSuccess ?? 0);
  return (
    now >= wakeUntil &&
    previous?.status === "ready" &&
    previous.mode === "display" &&
    age >= 0 &&
    age < 60_000
  );
}
