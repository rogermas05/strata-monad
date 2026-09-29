import { z } from "zod";
import type {
  MakerConfig,
  SeriesConfig,
} from "../../../packages/core/src/types.ts";

const inventoryTarget = z
  .object({
    targetInventory: z.number().int().min(1).max(100),
    maxWritten: z.number().int().min(1).max(300),
  })
  .strict()
  .refine(
    (value) => value.maxWritten >= value.targetInventory,
    "Maximum written must cover target inventory",
  );

export const makerConfigSchema = z
  .object({
    volatility: z.number().min(0.1).max(2),
    spreadBps: z.number().int().min(100).max(5000),
    edge: z.number().min(0).max(0.1),
    targetInventory: z.number().int().min(1).max(100),
    maxWritten: z.number().int().min(1).max(300),
    maxNetInventory: z.number().int().min(1).max(300).default(150),
    maxPortfolioInventory: z.number().int().min(1).max(50000).default(10000),
    maxExpiryInventory: z.number().int().min(1).max(50000).default(3000),
    maxTotalWritten: z.number().int().min(1).max(100000).default(15000),
    inventorySkewBps: z.number().int().min(0).max(5000).default(2000),
    inventoryTargets: z
      .record(
        z.string().regex(/^[A-Z0-9]{2,10}:(call|put|bull-spread|bear-spread)$/),
        inventoryTarget,
      )
      .optional(),
  })
  .strict()
  .refine(
    (c) => c.maxWritten >= c.targetInventory,
    "Maximum written must cover target inventory",
  );

export function makerInventoryTarget(
  config: MakerConfig,
  market: Pick<SeriesConfig, "asset" | "kind">,
) {
  return (
    config.inventoryTargets?.[`${market.asset}:${market.kind}`] ?? {
      targetInventory: config.targetInventory,
      maxWritten: config.maxWritten,
    }
  );
}
