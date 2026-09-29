import { expect, it } from "vitest";
import { makerConfigSchema, makerInventoryTarget } from "./maker-config.ts";
it("rejects risk settings that could overrun the funded target or native venue limits", () => {
  const config = {
    volatility: 0.85,
    spreadBps: 1200,
    edge: 0.001,
    targetInventory: 90,
    maxWritten: 180,
  };
  expect(makerConfigSchema.parse(config)).toEqual({
    ...config,
    maxNetInventory: 150,
    maxPortfolioInventory: 10000,
    maxExpiryInventory: 3000,
    maxTotalWritten: 15000,
    inventorySkewBps: 2000,
  });
  for (const change of [
    { maxWritten: 80 },
    { targetInventory: 90.5 },
    { volatility: Infinity },
    { edge: -1 },
    { spreadBps: 0 },
    { maxNetInventory: 0 },
    { maxPortfolioInventory: 0 },
    { maxExpiryInventory: 1.5 },
    { maxTotalWritten: 100001 },
    { inventorySkewBps: 5001 },
  ])
    expect(makerConfigSchema.safeParse({ ...config, ...change }).success).toBe(
      false,
    );
});

it("allocates cheaper puts more depth while preserving call backing and fallback limits", () => {
  const config = makerConfigSchema.parse({
    volatility: 0.85,
    spreadBps: 1200,
    edge: 0,
    targetInventory: 1,
    maxWritten: 1,
    inventoryTargets: {
      "MON:put": { targetInventory: 20, maxWritten: 40 },
      "MON:call": { targetInventory: 1, maxWritten: 1 },
      "BTC:bull-spread": { targetInventory: 3, maxWritten: 6 },
    },
  });
  expect(makerInventoryTarget(config, { asset: "MON", kind: "put" })).toEqual({
    targetInventory: 20,
    maxWritten: 40,
  });
  expect(makerInventoryTarget(config, { asset: "MON", kind: "call" })).toEqual({
    targetInventory: 1,
    maxWritten: 1,
  });
  expect(makerInventoryTarget(config, { asset: "BTC", kind: "put" })).toEqual({
    targetInventory: 1,
    maxWritten: 1,
  });
  expect(
    makerConfigSchema.safeParse({
      ...config,
      inventoryTargets: { "MON:put": { targetInventory: 20, maxWritten: 19 } },
    }).success,
  ).toBe(false);
  expect(
    makerConfigSchema.safeParse({
      ...config,
      inventoryTargets: {
        "MON:put": { targetInventory: 20.5, maxWritten: 40 },
      },
    }).success,
  ).toBe(false);
  expect(
    makerConfigSchema.safeParse({
      ...config,
      inventoryTargets: {
        "MON:unknown": { targetInventory: 1, maxWritten: 1 },
      },
    }).success,
  ).toBe(false);
});
