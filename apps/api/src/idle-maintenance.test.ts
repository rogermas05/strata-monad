import { expect, it, vi } from "vitest";
import type { Snapshot } from "../../../packages/core/src/types.ts";
import { maintainIdleDemo } from "./idle-maintenance.ts";

it("settles an expiry while trading sleeps, then runs the vault against the settled view without quoting", async () => {
  let settled = false;
  const before = {
    timestamp: 1_000,
    markets: [{ id: 1, expiry: 1_000, settlementPrice: null }],
    house: { launchTime: 100, epoch: 1, series: [1] },
  } as Snapshot;
  const after = {
    ...before,
    markets: [{ ...before.markets[0], settlementPrice: 1.04 }],
  };
  const settle = vi.fn(async () => {
    settled = true;
  });
  const refresh = vi.fn(async () => {
    expect(settled).toBe(true);
    return after;
  });
  const house = vi.fn(async ({ marketIds }) => {
    expect(settled).toBe(true);
    expect(marketIds).toEqual([]);
  });
  await maintainIdleDemo(before, { settle, refresh, house });
  expect(settle).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
  expect(house).toHaveBeenCalledOnce();
});

it("launches the vault without visitors and never submits orders through the maintenance pass", async () => {
  const operations = {
    settle: vi.fn(),
    refresh: vi.fn(),
    house: vi.fn(),
  };
  const snapshot = {
    timestamp: 1_000,
    markets: [{ expiry: 2_000, settlementPrice: null }],
    house: { epoch: 0, launchTime: 1_000 },
  } as Snapshot;
  await maintainIdleDemo(snapshot, operations);
  expect(operations.settle).not.toHaveBeenCalled();
  expect(operations.house).toHaveBeenCalledWith({ marketIds: [] });
});

it("does no maintenance before genesis launch when there are no unsettled expired contracts", async () => {
  const operations = {
    settle: vi.fn(),
    refresh: vi.fn(),
    house: vi.fn(),
  };
  await maintainIdleDemo(
    {
      timestamp: 1_000,
      markets: [
        { expiry: 999, settlementPrice: 1.04 },
        { expiry: 2_000, settlementPrice: null },
      ],
      house: { epoch: 0, launchTime: 1_001 },
    } as Snapshot,
    operations,
  );
  expect(operations.settle).not.toHaveBeenCalled();
  expect(operations.house).not.toHaveBeenCalled();
});
