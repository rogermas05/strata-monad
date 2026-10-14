import {
  client,
  manifest,
  refresh,
  current,
  serialized,
  send,
  oracleAbi,
  workersPaused,
  recordWorkerError,
  setLastQuote,
  assetSessionOpen,
  publishControlledPrice,
  finalizeElapsed,
} from "./runtime.ts";
import { manifestAssets } from "../../../packages/core/src/manifest-assets.ts";
import { cleanupExpiredMaker } from "../../../packages/core/src/expiry-cleanup.ts";
import { startMakerWorker, resetMakerCycle } from "./maker-worker.ts";
import { startPythKeeper } from "./pyth-keeper.ts";
import { startHouseWorker } from "./house-worker.ts";
const cleaned = new Set<number>();
const PATH_AMPLITUDE = 0.0039;
export function resetWorkerState() {
  cleaned.clear();
  resetMakerCycle();
  setLastQuote(0);
}
export function startWorkers() {
  if (manifest.oracleMode !== "demo") {
    startPythKeeper();
    startMakerWorker();
    startHouseWorker();
    return;
  }
  let keeperPending = false;
  // Controlled prices are labelled demo data. This is not an independent external oracle.
  setInterval(() => {
    if (workersPaused || keeperPending) return;
    keeperPending = true;
    void serialized(async () => {
      if (workersPaused) return;
      const block = await client.getBlock();
      const timestamp = Number(block.timestamp);
      for (const [index, asset] of manifestAssets(manifest).entries()) {
        const previous = current()?.underlyings?.[asset.key]?.publishedAt ?? 0;
        if (timestamp <= previous || !assetSessionOpen(asset, timestamp))
          continue;
        // Deterministic controlled path around the asset's labelled reference.
        const price =
          asset.reference *
          (1 + PATH_AMPLITUDE * Math.sin(timestamp / 180 + index * 1.7));
        await publishControlledPrice(asset.key, price);
      }
      await finalizeElapsed(manifest.deployer);
      const snap = await refresh();
      const expiredMarkets = snap.markets.filter(
        (m) => !m.active && m.settlementPrice && !cleaned.has(m.id),
      );
      for (const expired of expiredMarkets) {
        const owned = expired.orders.filter(
          (o) => o.owner.toLowerCase() === manifest.maker.toLowerCase(),
        );
        await cleanupExpiredMaker(
          client,
          manifest,
          manifest.series.find((s) => s.id === expired.id)!,
          owned.map((o) => BigInt(o.id)),
          (address, abi, name, args) =>
            send(manifest.maker, address, abi, name, args),
        );
        cleaned.add(expired.id);
        await refresh();
      }
    })
      .catch((e) =>
        recordWorkerError(
          `Keeper: ${e instanceof Error ? e.message : String(e)}`,
        ),
      )
      .finally(() => {
        keeperPending = false;
      });
  }, 15000).unref();
  startMakerWorker();
  startHouseWorker();
}
