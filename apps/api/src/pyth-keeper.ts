import {
  createPublicClient,
  getAddress,
  http,
  type Abi,
  type Address,
  encodeAbiParameters,
  keccak256,
} from "viem";
import {
  fetchEvidence,
  fetchUpdate,
  fetchUpdates,
} from "../../../packages/core/src/hermes.ts";
import { pythAbi } from "../../../packages/core/src/pyth.ts";
import { expiryOracleAbi } from "../../../packages/core/src/oracle-proof.ts";
import {
  settleSessionClose,
  type KeeperChain,
  type UpdateSource,
} from "../../../packages/core/src/settlement-keeper.ts";
import {
  pushedUpdateSource,
  pushedPriceHistory,
} from "../../../packages/core/src/pushed-updates.ts";
import { manifestAssets } from "../../../packages/core/src/manifest-assets.ts";
import {
  assetFor,
  type ManifestAsset,
} from "../../../packages/core/src/index.ts";
import {
  client,
  manifest,
  send,
  serialized,
  workersPaused,
  recordWorkerError,
  seedObservedPrices,
  setDisplayPrices,
  runtimeDirectory,
} from "./runtime.ts";
import { cloudEnabled, cloudRequest } from "./cloud-store.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { rateLimitedHttp } from "../../../packages/core/src/rpc-transport.ts";

const KEEPER_INTERVAL_MS = 30000;
const RELAY_INTERVAL_MS = 5000;
/** Chart history filled in at startup: the chart's two-hour window. */
const BACKFILL_SECONDS = 7200;
const BACKFILL_SPACING = 10;
const HERMES_BACKFILL_SPACING = 60;

interface Access {
  endpoint: string;
  apiKey: string;
}
/**
 * Feeds listed in PYTH_PUSHED_FEEDS are not fetched from Hermes: their signed
 * updates are reused from a contract where another party already pushes them.
 */
/**
 * Fills each chart with the last two hours of real prices: on-chain update
 * events where the feed is pushed, one Hermes update a minute otherwise.
 */
async function backfillCharts(access: Access) {
  const rpc = process.env.PYTH_PUSHED_RPC_URL,
    contract = process.env.PYTH_PUSHED_CONTRACT;
  const assets = manifestAssets(manifest);
  const filled = new Set<string>();
  // The pushed contract carries more feeds than the ones settled from it.
  if (rpc && contract) {
    const history = await pushedPriceHistory(
      createPublicClient({ transport: http(rpc, { timeout: 15000 }) }),
      getAddress(contract),
      assets.map((a) => a.assetId),
      BACKFILL_SECONDS,
      BACKFILL_SPACING,
    );
    for (const asset of assets) {
      const points = history.get(asset.assetId) ?? [];
      if (!points.length) continue;
      seedObservedPrices(asset.key, points);
      filled.add(asset.key);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  for (const asset of assets.filter((a) => !filled.has(a.key))) {
    const points = [];
    for (
      let t = now - BACKFILL_SECONDS;
      t < now;
      t += HERMES_BACKFILL_SPACING
    ) {
      // No update at a timestamp means the market was closed then.
      const update = await fetchUpdate(access, asset.assetId, t);
      if (update)
        points.push({
          timestamp: update.publishTime,
          price: Number(update.price) * 10 ** update.exponent,
        });
    }
    seedObservedPrices(asset.key, points);
  }
}

function updateSources(access: Access) {
  const pushedKeys = (process.env.PYTH_PUSHED_FEEDS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const hermes: UpdateSource = async (feed, timestamp) => {
    try {
      return await fetchUpdate(access, feed, timestamp);
    } catch (error) {
      if (!process.env.HERMES_BACKUP_URL) throw error;
      return fetchUpdate(
        {
          endpoint: process.env.HERMES_BACKUP_URL,
          apiKey: process.env.PYTH_BACKUP_API_KEY ?? access.apiKey,
        },
        feed,
        timestamp,
      );
    }
  };
  if (!pushedKeys.length) return () => hermes;
  const rpc = process.env.PYTH_PUSHED_RPC_URL,
    contract = process.env.PYTH_PUSHED_CONTRACT;
  if (!rpc || !contract)
    throw new Error(
      "PYTH_PUSHED_FEEDS needs PYTH_PUSHED_RPC_URL and PYTH_PUSHED_CONTRACT",
    );
  const pushed = pushedUpdateSource(
    createPublicClient({ transport: rateLimitedHttp(rpc) }),
    getAddress(contract),
  );
  return (asset: ManifestAsset) =>
    pushedKeys.includes(asset.key) ? pushed : hermes;
}

const chain: KeeperChain = {
  read: (address, abi, functionName, args = []) =>
    client.readContract({ address, abi, functionName, args }),
  send: async (address, abi, functionName, args, value) => {
    const updates = args[
      functionName === "updatePriceFeeds" ? 0 : 2
    ] as `0x${string}`[];
    if (updates?.length) {
      const hash = keccak256(
        encodeAbiParameters([{ type: "bytes[]" }], [updates]),
      );
      const record = {
        chainId: manifest.chainId,
        engine: manifest.engine,
        target: address,
        functionName,
        args: args.map((a) => (typeof a === "bigint" ? String(a) : a)),
        payloadHash: hash,
        retainedBeforeBroadcast: true,
      };
      const id = `${manifest.chainId}:${manifest.engine.toLowerCase()}:${hash}`;
      if (cloudEnabled)
        await cloudRequest("strata_proofs", "POST", { id, value: record });
      else {
        const directory = `${runtimeDirectory}/keeper-proofs`;
        mkdirSync(directory, { recursive: true });
        writeFileSync(`${directory}/${hash}.json`, JSON.stringify(record), {
          mode: 0o600,
        });
      }
    }
    return send(manifest.deployer, address, abi, functionName, args, value);
  },
  now: async () => Number((await client.getBlock()).timestamp),
};

/** 24/7 assets: the unique first update at or after expiry, with its exact fee. */
async function settleFirstUpdate(
  access: Access,
  asset: ManifestAsset,
  expiry: number,
) {
  const read = (address: Address, abi: Abi, name: string, args: unknown[]) =>
    chain.read(address, abi, name, args);
  if (
    (await read(asset.adapter, expiryOracleAbi, "settlementPrice", [
      asset.assetId,
      BigInt(expiry),
    ])) !== 0n
  )
    return;
  let evidence;
  try {
    evidence = await fetchEvidence({ ...access, feed: asset.assetId, expiry });
  } catch (error) {
    if (!process.env.HERMES_BACKUP_URL) throw error;
    evidence = await fetchEvidence({
      endpoint: process.env.HERMES_BACKUP_URL,
      apiKey: process.env.PYTH_BACKUP_API_KEY ?? access.apiKey,
      feed: asset.assetId,
      expiry,
    });
  }
  const verifier = (await read(
    asset.adapter,
    expiryOracleAbi,
    "pyth",
    [],
  )) as Address;
  const fee = (await read(verifier, pythAbi, "getUpdateFee", [
    evidence.updates,
  ])) as bigint;
  await chain.send(
    asset.adapter,
    expiryOracleAbi,
    "finalize",
    [asset.assetId, BigInt(expiry), evidence.updates],
    fee,
  );
}

/** One pass over every elapsed (asset, expiry). A failed pair never blocks the rest. */
export async function runPythKeeper(
  access: Access,
  sourceFor: (asset: ManifestAsset) => UpdateSource,
) {
  const now = await chain.now();
  const pending = new Map<string, { asset: ManifestAsset; expiry: number }>();
  for (const series of manifest.series) {
    if (series.expiry > now) continue;
    const asset = assetFor(manifest, series);
    pending.set(`${asset.key}:${series.expiry}`, {
      asset,
      expiry: series.expiry,
    });
  }
  for (const [key, { asset, expiry }] of pending)
    try {
      if (asset.policy === "pyth-latest-before-close")
        await settleSessionClose(chain, sourceFor(asset), asset, expiry);
      else await settleFirstUpdate(access, asset, expiry);
    } catch (error) {
      recordWorkerError(
        `Settlement ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
}

/**
 * Pushes each asset's newest signed update to the deployment's verifier so
 * live prices stay fresh. A provider failure leaves the price to go stale,
 * which pauses new exposure; it never substitutes a value.
 */
export async function relayLivePrices(
  sourceFor: (asset: ManifestAsset) => UpdateSource,
  access?: Access,
) {
  const updates: `0x${string}`[] = [];
  let verifier: Address | undefined;
  const pushed = new Set(
    (process.env.PYTH_PUSHED_FEEDS ?? "").split(",").map((key) => key.trim()),
  );
  const feeds = manifestAssets(manifest)
    .filter((asset) => !pushed.has(asset.key))
    .map((asset) => asset.assetId);
  let batch: Awaited<ReturnType<typeof fetchUpdates>> | undefined;
  if (access && feeds.length) {
    try {
      batch = await fetchUpdates(access, feeds);
    } catch {
      // Attribute failures per feed through the existing source/backup path.
    }
  }
  for (const asset of manifestAssets(manifest))
    try {
      verifier ??= (await chain.read(
        asset.adapter,
        expiryOracleAbi,
        "pyth",
      )) as Address;
      const latest =
        batch?.get(asset.assetId) ?? (await sourceFor(asset)(asset.assetId));
      if (!latest) continue;
      let current = 0n;
      try {
        current = (
          (await chain.read(verifier, pythAbi, "getPriceUnsafe", [
            asset.assetId,
          ])) as { publishTime: bigint }
        ).publishTime;
      } catch {
        // Never pushed to this verifier yet.
      }
      // Do not spend gas replacing an already fresh price on the shared verifier.
      // Refresh within half the immutable live window, leaving time for inclusion.
      const age = Math.min(60, asset.maxLiveAge);
      if (
        BigInt(latest.publishTime) > current &&
        (!current ||
          latest.publishTime - Number(current) >= Math.floor(age / 2))
      )
        updates.push(...latest.updates);
    } catch (error) {
      recordWorkerError(
        `Live price ${asset.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  if (!verifier || !updates.length) return;
  const unique = [...new Set(updates)];
  const fee = (await chain.read(verifier, pythAbi, "getUpdateFee", [
    unique,
  ])) as bigint;
  await chain.send(verifier, pythAbi, "updatePriceFeeds", [unique], fee);
}

function every(ms: number, label: string, task: () => Promise<unknown>) {
  let pending = false;
  setInterval(() => {
    if (workersPaused || pending) return;
    pending = true;
    void serialized(task)
      .catch((error) =>
        recordWorkerError(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        pending = false;
      });
  }, ms).unref();
}

/** Pyth-mode workers. They need provider access and never invent a price. */
export function startPythKeeper() {
  const apiKey = process.env.PYTH_API_KEY;
  if (!apiKey && !process.env.PYTH_PUSHED_FEEDS) return;
  const access = {
    endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
    apiKey: apiKey ?? "",
  };
  const sourceFor = updateSources(access);
  void backfillCharts(access).catch((error) =>
    recordWorkerError(
      `Chart backfill: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  every(RELAY_INTERVAL_MS, "Live prices", () =>
    relayLivePrices(sourceFor, access),
  );
  every(KEEPER_INTERVAL_MS, "Keeper", () => runPythKeeper(access, sourceFor));
}

/** One bounded scheduled invocation; safe to repeat after a process restart. */
/** Latest off-chain Pyth prices for display only; signs and sends nothing. */
export async function refreshDisplayPrices() {
  const access = {
    endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
    apiKey: process.env.PYTH_API_KEY ?? "",
  };
  const sources = updateSources(access);
  const results = await Promise.allSettled(
    manifestAssets(manifest).map(async (asset) => {
      const update = await sources(asset)(asset.assetId);
      return update
        ? ([
            asset.key,
            {
              price: Number(update.price) * 10 ** update.exponent,
              publishedAt: update.publishTime,
            },
          ] as const)
        : null;
    }),
  );
  setDisplayPrices(
    new Map(
      results.flatMap((r) =>
        r.status === "fulfilled" && r.value ? [r.value] : [],
      ),
    ),
  );
}
export async function refreshLivePrices() {
  const access = {
    endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
    apiKey: process.env.PYTH_API_KEY ?? "",
  };
  await relayLivePrices(updateSources(access), access);
}

export async function runPythPass() {
  const access = {
    endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
    apiKey: process.env.PYTH_API_KEY ?? "",
  };
  const sources = updateSources(access);
  await relayLivePrices(sources, access);
  await runPythKeeper(access, sources);
}

/** Expiry maintenance while trading sleeps; does not relay live prices. */
export async function runSettlementPass() {
  const access = {
    endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
    apiKey: process.env.PYTH_API_KEY ?? "",
  };
  await runPythKeeper(access, updateSources(access));
}
