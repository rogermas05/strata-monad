import type { Manifest, ManifestAsset, SeriesConfig } from "./types.ts";
import { ASSETS } from "./assets.ts";

export const LEGACY_VOLATILITY = 0.85;
export const LEGACY_REFERENCE = 1.03;

/** Assets of a deployment; legacy single-oracle manifests list MON only. */
export function manifestAssets(manifest: Manifest): ManifestAsset[] {
  if (manifest.assets?.length) return manifest.assets;
  const mon = ASSETS.find((a) => a.key === "MON")!;
  return [
    {
      key: "MON",
      name: mon.name,
      assetClass: "crypto",
      assetId: manifest.assetId,
      adapter: manifest.oracle,
      policy: "pyth-first-after-expiry",
      maxLiveAge: mon.maxLiveAge,
      challengeWindow: 0,
      schedule: mon.schedule,
      scheduleSnapshot: mon.scheduleSnapshot,
      volatility: LEGACY_VOLATILITY,
      reference: LEGACY_REFERENCE,
      deliverable: true,
    },
  ];
}

export function assetFor(
  manifest: Manifest,
  series: Pick<SeriesConfig, "asset">,
): ManifestAsset {
  const assets = manifestAssets(manifest);
  // Legacy single-oracle manifests predate per-series assets: everything is MON.
  if (!manifest.assets?.length && !series.asset) return assets[0];
  const found = assets.find((a) => a.key === series.asset);
  if (!found) throw new Error(`Series asset ${series.asset} is not listed`);
  return found;
}
