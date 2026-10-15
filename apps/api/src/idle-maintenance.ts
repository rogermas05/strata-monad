import type { Snapshot } from "../../../packages/core/src/types.ts";

/** Keep expiry claims and vault rolls moving without refreshing trading quotes. */
export async function maintainIdleDemo(
  snapshot: Snapshot,
  operations: {
    settle: () => Promise<unknown>;
    refresh: () => Promise<Snapshot>;
    house: (options: { marketIds: number[] }) => Promise<unknown>;
  },
) {
  if (
    snapshot.markets.some(
      (market) =>
        market.expiry <= snapshot.timestamp && market.settlementPrice === null,
    )
  ) {
    await operations.settle();
    snapshot = await operations.refresh();
  }
  if (snapshot.house && snapshot.timestamp >= snapshot.house.launchTime)
    await operations.house({ marketIds: [] });
}
