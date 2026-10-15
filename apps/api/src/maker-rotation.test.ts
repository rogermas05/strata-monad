import { expect, it } from "vitest";
import type { Snapshot } from "../../../packages/core/src/types.ts";
import { nextMakerMarket } from "./maker-rotation.ts";

it("prioritizes a newly opened empty book without getting stuck on sold-out capped inventory", () => {
  const snapshot = {
    markets: [
      {
        id: 1,
        asset: "MON",
        kind: "call",
        active: true,
        healthy: true,
        bid: 1,
        ask: null,
      },
      {
        id: 2,
        asset: "MON",
        kind: "call",
        active: true,
        healthy: true,
        bid: 1,
        ask: 2,
      },
      {
        id: 3,
        asset: "TSLA",
        kind: "bull-spread",
        active: true,
        healthy: false,
        bid: null,
        ask: null,
      },
      {
        id: 4,
        asset: "MON",
        kind: "call",
        active: true,
        healthy: true,
        bid: null,
        ask: null,
      },
    ],
    maker: {
      config: { maxWritten: 1, targetInventory: 1, maxTotalWritten: 650 },
      risk: { writtenClaims: "1000000000000000000" },
      inventory: [1, 2, 3, 4].map((marketId) => ({
        marketId,
        walletClaims: "0",
        venueClaims: "0",
        restingClaims: "0",
        writtenClaims: marketId === 1 ? "1000000000000000000" : "0",
        bidCapacity: 1,
        askCapacity: 1,
      })),
    },
  } as unknown as Snapshot;
  expect(nextMakerMarket(snapshot, 1)?.id).toBe(4);
  snapshot.markets[3].bid = 1;
  snapshot.markets[3].ask = 2;
  expect(nextMakerMarket(snapshot, 1)?.id).toBe(2);
  snapshot.markets[2].healthy = true;
  expect(nextMakerMarket(snapshot, 1)?.id).toBe(3);
});
