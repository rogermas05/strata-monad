import { config as loadEnv } from "dotenv";
import { makerConfigSchema } from "./maker-config.ts";
import { backfillRanges, replayLogRanges } from "./index-backfill.ts";
import { waitReceipt } from "../../../packages/core/src/receipts.ts";
import { coalesceFresh } from "../../../packages/core/src/fresh-coalescer.ts";
import { minutePrices, retainedSnapshot } from "./cloud-retention.ts";
import {
  parseDeploymentManifest,
  serviceRpcUrl,
  localSigningAllowed,
  redactDiagnostic,
  rpcDiagnosticSecrets,
} from "../../../packages/core/src/deployment-config.ts";
import { checkRpcPair } from "../../../packages/core/src/deployment-check.ts";
import {
  readFileSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  encodeFunctionData,
  keccak256,
  parseAbi,
  decodeEventLog,
  TransactionReceiptNotFoundError,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { configuredSigner } from "../../../scripts/lib/public-signer.ts";
import { workerAuthorizer } from "./worker-policy.ts";
import { reserveWorkerGas } from "./worker-gas-budget.ts";
import {
  cloudEnabled,
  loadCloudState,
  saveCloudState,
  cloudSignerJournal,
  assertWorkerLease,
  cloudRequest,
  hasWorkerLease,
} from "./cloud-store.ts";
import type { ManagedSigner } from "../../../scripts/lib/managed-signer.ts";
import { monadTestnet } from "viem/chains";
import { rateLimitedHttp } from "../../../packages/core/src/rpc-transport.ts";
import {
  priceOption,
  assessReadiness,
  makerInventoryPolicy,
  makerSnapshotRisk,
  markSeries,
  type Manifest,
  type Snapshot,
  type Market,
  type BookOrder,
  type DepthLevel,
  type Portfolio,
  type TradeRecord,
  type MakerConfig,
  type MakerInventory,
  type TransactionRecord,
  type SeriesConfig,
  type UnderlyingState,
  manifestAssets,
  assetFor,
  parseSchedule,
  isOpen,
  nextSessionChange,
} from "../../../packages/core/src/index.ts";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
loadEnv({ path: `${root}.env`, quiet: true });
export const serverless = process.env.STRATA_SERVERLESS === "1";
export const runtimeDirectory =
  process.env.STRATA_RUNTIME_DIRECTORY ?? `${root}.runtime`;
mkdirSync(runtimeDirectory, { recursive: true });
/** A second stack (e.g. real Pyth prices) points MANIFEST_PATH at its own manifest. */
const manifestPath = process.env.MANIFEST_PATH
  ? resolve(root, process.env.MANIFEST_PATH)
  : `${runtimeDirectory}/manifest.json`;
const makerConfigPath = process.env.MANIFEST_PATH
  ? resolve(dirname(manifestPath), "maker-config.json")
  : `${runtimeDirectory}/maker-config.json`;
export const manifest: Manifest = parseDeploymentManifest(
  process.env.STRATA_MANIFEST_JSON ?? readFileSync(manifestPath, "utf8"),
);
export const serviceRpc = serviceRpcUrl(manifest, process.env.SERVICE_RPC_URL);
export const localSigning = localSigningAllowed(
  manifest,
  serviceRpc,
  process.env.API_READ_ONLY ?? "0",
);
export const publicWorkers =
  process.env.STRATA_PUBLIC_WORKERS === "1" &&
  process.env.API_READ_ONLY !== "1";
if (
  publicWorkers &&
  (manifest.chainId !== 10143 ||
    manifest.oracleMode !== "pyth" ||
    manifest.venueMode !== "kuru")
)
  throw new Error(
    "Public workers require a Pyth/Kuru Monad testnet deployment",
  );
if (serverless && !cloudEnabled)
  throw new Error("Serverless operation requires durable cloud state");
export function safeDiagnostic(value: unknown) {
  return redactDiagnostic(value, [
    ...rpcDiagnosticSecrets(serviceRpc),
    ...rpcDiagnosticSecrets(process.env.FORK_RPC_URL ?? ""),
    process.env.PYTH_API_KEY ?? "",
    process.env.PYTH_BACKUP_API_KEY ?? "",
    process.env.STRATA_DEPLOYER_PRIVATE_KEY ?? "",
    process.env.STRATA_MAKER_PRIVATE_KEY ?? "",
    process.env.STRATA_SUPABASE_SERVICE_KEY ?? "",
    process.env.STRATA_STATE_DATABASE_URL ?? "",
    process.env.STRATA_STATE_DATABASE_URL_UNPOOLED ?? "",
    process.env.STRATA_WORKER_TOKEN ?? "",
  ]);
}
export const chain = defineChain({
  id: manifest.chainId,
  name:
    manifest.mode === "testnet"
      ? "Monad testnet"
      : manifest.mode === "local-fork"
        ? "Local Monad fork"
        : "Local development chain",
  nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [manifest.rpcUrl] } },
  ...(manifest.chainId === 10143 ? { contracts: monadTestnet.contracts } : {}),
});
export const client = createPublicClient({
  chain,
  ...(manifest.chainId === 10143
    ? { batch: { multicall: { wait: 20, batchSize: 8192 } } }
    : {}),
  pollingInterval: 100,
  transport:
    manifest.chainId === 10143
      ? rateLimitedHttp(serviceRpc)
      : http(serviceRpc, { timeout: 5000, retryCount: 0 }),
});
if (serviceRpc !== manifest.rpcUrl) {
  try {
    await checkRpcPair(
      client,
      createPublicClient({
        transport: http(manifest.rpcUrl, { timeout: 5000, retryCount: 0 }),
      }),
      manifest,
    );
  } catch (error) {
    throw new Error(safeDiagnostic(error));
  }
}
export const wallet = (account: Address) => {
  if (!localSigning)
    throw new Error(
      "Unlocked signing is restricted to loopback local services",
    );
  return createWalletClient({ account, chain, transport: http(serviceRpc) });
};
export const abi = (name: string): Abi =>
  JSON.parse(
    readFileSync(`${root}packages/core/src/generated/${name}.json`, "utf8"),
  );
export const engineAbi = abi("OptionsEngine"),
  oracleAbi = abi("DemoOracle"),
  tokenAbi = abi("OptionToken"),
  routerAbi = abi("StrategyRouter");
export const kuruAbi = parseAbi([
  "event OrderCreated(uint40 orderId,address owner,uint96 size,uint32 price,bool isBuy)",
  "event Trade(uint40 orderId,address makerAddress,bool isBuy,uint256 price,uint96 updatedSize,address takerAddress,address txOrigin,uint96 filledSize)",
  "event OrdersCanceled(uint40[] orderId,address owner)",
  "event OrderCanceled(uint40 orderId,address owner,uint32 price,uint96 size,bool isBuy)",
  "function batchCancelOrders(uint40[] orderIds)",
  "function batchCancelOrdersNoRevert(uint40[] orderIds)",
  "function addBuyOrder(uint32 price,uint96 size,bool postOnly)",
  "function addSellOrder(uint32 price,uint96 size,bool postOnly)",
  "function batchUpdate(uint32[] buyPrices,uint96[] buySizes,uint32[] sellPrices,uint96[] sellSizes,uint40[] orderIdsToCancel,bool postOnly)",
]);
export const marginAbi = parseAbi([
  "function deposit(address user,address token,uint256 amount) payable",
  "function withdraw(uint256 amount,address token)",
  "function getBalance(address user,address token) view returns (uint256)",
]);
export const max = 2n ** 256n - 1n;
export function json(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}
const db = new DatabaseSync(
  `${runtimeDirectory}/events-${manifest.engine.toLowerCase()}.sqlite`,
);
const stateKey = `read-model:${manifest.chainId}:${manifest.engine.toLowerCase()}`;
type ReadModelState = {
  events: unknown[][];
  cursor: unknown[][];
  transactions: unknown[][];
  charts?: Record<string, Snapshot["prices"]>;
  houseBackfill?: { vault: string; nextBlock: number; complete: boolean };
};
let houseBackfill: ReadModelState["houseBackfill"];
export async function reloadCloudReadModel() {
  if (!cloudEnabled) return;
  const state = await loadCloudState<ReadModelState>(stateKey);
  if (!state) return;
  db.exec("BEGIN");
  try {
    for (const [table, columns] of [
      ["events", 8],
      ["cursor", 3],
      ["transactions", 7],
    ] as const) {
      const rows = state[table];
      if (!Array.isArray(rows)) throw new Error("Malformed cloud read model");
      db.exec(`DELETE FROM ${table}`);
      const insert = db.prepare(
        `INSERT INTO ${table} VALUES(${Array(columns).fill("?").join(",")})`,
      );
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== columns)
          throw new Error("Malformed cloud read model row");
        insert.run(...(row as any[]));
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  cloudCharts = state.charts ?? {};
  houseBackfill = state.houseBackfill;
  for (const [key, prices] of Object.entries(state.charts ?? {}))
    seedObservedPrices(key, prices);
}
export async function persistCloudReadModel() {
  if (!cloudEnabled) return;
  const rows = (table: string) =>
    db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => Object.values(row));
  await saveCloudState(stateKey, {
    events: rows("events"),
    cursor: rows("cursor"),
    transactions: rows("transactions"),
    houseBackfill,
    // Before the first snapshot (e.g. mid catch-up), keep the stored charts.
    charts: current()
      ? Object.fromEntries(
          Object.entries(current()!.underlyings).map(([key, value]) => [
            key,
            minutePrices(value.prices),
          ]),
        )
      : cloudCharts,
  });
}
let cloudCharts: ReadModelState["charts"] = {};
const signers = new Map<string, ManagedSigner>();
async function workerSigner(account: Address) {
  if (!publicWorkers) throw new Error("Public worker signing is disabled");
  const role =
    account.toLowerCase() === manifest.maker.toLowerCase()
      ? "maker"
      : account.toLowerCase() === manifest.deployer.toLowerCase()
        ? "deployer"
        : undefined;
  if (!role) throw new Error("No worker role for this account");
  let signer = signers.get(role);
  if (!signer) {
    const asset = manifestAssets(manifest)[0];
    const verifier = await client.readContract({
      address: asset.adapter,
      abi: parseAbi(["function pyth() view returns(address)"]),
      functionName: "pyth",
    });
    const policy = workerAuthorizer(manifest, role, verifier);
    signer = configuredSigner(
      role,
      client,
      chain,
      serviceRpc,
      `${runtimeDirectory}/signers`,
      async (intent) => {
        if (cloudEnabled) await assertWorkerLease();
        await policy(intent);
      },
      {
        ...(cloudEnabled
          ? {
              journal: cloudSignerJournal(manifest.chainId, account),
              reserveCost: (id: string, cost: bigint, balance: bigint) =>
                reserveWorkerGas(
                  `${manifest.chainId}:${account}`,
                  id,
                  cost,
                  balance,
                ),
            }
          : {}),
        receiptTimeout: 45000,
      },
    );
    if (signer.address.toLowerCase() !== account.toLowerCase()) {
      signer.close();
      throw new Error("Worker signer differs from manifest role");
    }
    signers.set(role, signer);
  }
  return signer;
}
export function workerSignerStatus() {
  return [...signers].map(([role, signer]) => ({ role, ...signer.status() }));
}
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,block INTEGER,hash TEXT,tx TEXT,address TEXT,event TEXT,args TEXT,timestamp INTEGER); CREATE TABLE IF NOT EXISTS cursor(id INTEGER PRIMARY KEY,block INTEGER,hash TEXT); CREATE TABLE IF NOT EXISTS transactions(hash TEXT PRIMARY KEY,account TEXT,target TEXT,operation TEXT,status TEXT,block TEXT,created INTEGER);",
);
type StoredEvent = {
  id: string;
  block: number;
  hash: Hex;
  tx: Hex;
  address: Address;
  event: string;
  args: string;
  timestamp: number;
};
let queue: Promise<unknown> = Promise.resolve();
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}
/** Series whose new exposure a transaction would create, for pre-trade price checks. */
function seriesForCall(
  address: Address,
  functionName: string,
  args: unknown[],
): SeriesConfig[] {
  const target = address.toLowerCase();
  if (manifest.house && target === manifest.house.vault.toLowerCase()) {
    // Vault operator calls name their series or book in the first argument.
    const first = String(args[0]).toLowerCase();
    return manifest.series.filter((s) =>
      functionName === "updateQuotes"
        ? s.market.toLowerCase() === first
        : functionName === "write" &&
          BigInt(s.id) === BigInt(args[0] as bigint),
    );
  }
  const byVenue = manifest.series.filter(
    (s) =>
      s.market.toLowerCase() === target || s.venue.toLowerCase() === target,
  );
  if (byVenue.length) return byVenue;
  const byId = (id: unknown) =>
    manifest.series.find((s) => BigInt(s.id) === BigInt(id as bigint));
  if (target === manifest.engine.toLowerCase() && functionName === "write") {
    const series = byId(args[0]);
    return series ? [series] : [];
  }
  if (target === manifest.router.toLowerCase() && functionName === "execute")
    return ((args[0] as { seriesId: bigint }[]) ?? [])
      .map((leg) => byId(leg.seriesId))
      .filter((series): series is SeriesConfig => !!series);
  return [];
}
export async function send(
  account: Address,
  address: Address,
  contractAbi: Abi,
  functionName: string,
  args: unknown[] = [],
  value = 0n,
): Promise<Hex> {
  if (
    [
      "execute",
      "write",
      "addBuyOrder",
      "addSellOrder",
      "place",
      "batchUpdate",
      "updateQuotes",
    ].includes(functionName)
  ) {
    let block = await client.getBlock();
    const involved = seriesForCall(address, functionName, args);
    for (const series of involved)
      if (BigInt(series.expiry) <= block.timestamp)
        throw new Error("Expired market does not accept new orders");
    const assets = involved.length
      ? [...new Set(involved.map((series) => assetFor(manifest, series)))]
      : manifestAssets(manifest).slice(0, 1);
    const age = (await client.readContract({
      address: manifest.engine,
      abi: engineAbi,
      functionName: "maxPriceAge",
      blockNumber: block.number,
    })) as bigint;
    if (publicWorkers) {
      const prices = await Promise.all(
        assets.map(async (asset) => {
          const [, published] = (await client.readContract({
            address: manifest.oracle,
            abi: oracleAbi,
            functionName: "livePrice",
            args: [asset.assetId],
            blockNumber: block.number,
          })) as [bigint, bigint];
          return { asset, published };
        }),
      );
      // Long book-funding passes can consume the original live-price window.
      // Relay genuine signed evidence, then repeat the unchanged oracle checks.
      if (
        prices.some(
          ({ asset, published }) =>
            block.timestamp - published >=
            BigInt(Math.max(1, Math.min(Number(age), asset.maxLiveAge) - 20)),
        )
      ) {
        const { refreshLivePrices } = await import("./pyth-keeper.ts");
        await refreshLivePrices(assets.map((asset) => asset.key));
        block = await client.getBlock();
      }
    }
    for (const asset of assets) {
      const [value, published] = (await client.readContract({
        address: manifest.oracle,
        abi: oracleAbi,
        functionName: "livePrice",
        args: [asset.assetId],
        blockNumber: block.number,
      })) as [bigint, bigint];
      const limit = BigInt(Math.min(Number(age), asset.maxLiveAge));
      if (
        value <= 0n ||
        published > block.timestamp ||
        block.timestamp - published > limit
      )
        throw new Error(
          asset.policy === "pyth-latest-before-close"
            ? `${asset.key} market is closed or its price is stale`
            : "Current oracle price is unavailable or stale",
        );
    }
  }
  const simulation = await client.simulateContract({
    account,
    address,
    abi: contractAbi,
    functionName,
    args,
    value,
  });
  const hash = localSigning
    ? await wallet(account).writeContract({
        ...simulation.request,
        gas: 12000000n,
      })
    : await (async () => {
        const signer = await workerSigner(account);
        const nonce = await client.getTransactionCount({
          address: account,
          blockTag: "pending",
        });
        const data = encodeFunctionData({
          abi: contractAbi,
          functionName,
          args,
        });
        return signer.send({
          id: `worker/${manifest.engine}/${nonce}/${keccak256(data)}`,
          to: address,
          data,
          value,
        });
      })();
  db.prepare("INSERT OR REPLACE INTO transactions VALUES(?,?,?,?,?,?,?)").run(
    hash,
    account,
    address,
    functionName,
    "pending",
    null,
    Date.now(),
  );
  let receipt;
  try {
    receipt = await waitReceipt(client, hash, 45000);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    throw Object.assign(error, { transactionHash: hash });
  }
  db.prepare("UPDATE transactions SET status=?,block=? WHERE hash=?").run(
    receipt.status === "success" ? "included" : "reverted",
    receipt.blockNumber.toString(),
    hash,
  );
  if (receipt.status !== "success")
    throw Object.assign(new Error(`Transaction reverted: ${hash}`), {
      transactionHash: hash,
    });
  return hash;
}
let snapshot: Snapshot | undefined;
let lastSuccessfulRefreshAt = 0;
let lastAttemptAt = 0;
let lastProgressAt = Date.now();
let lastTipHash: Hex | undefined;
let refreshFailed = false;
let oracleValid = false;
let maxPriceAge = 0;
export function readiness() {
  return assessReadiness({
    now: Date.now(),
    lastSuccessfulRefreshAt,
    lastAttemptAt,
    lastProgressAt,
    refreshFailed,
    oracleValid,
    maxPriceAge,
    chainTimestamp: snapshot?.timestamp ?? 0,
    pricePublishedAt: snapshot?.pricePublishedAt ?? 0,
    localMaintenance: manifest.chainId === 31337 && workersPaused,
  });
}
let allTrades: TradeRecord[] = [];
/** Every indexed fill since deployment (snapshots carry only the latest 200). */
export function tradeHistory(): readonly TradeRecord[] {
  return allTrades;
}
const makerStatePath = `${runtimeDirectory}/maker-state-${manifest.engine.toLowerCase()}.json`;
export let makerEnabled = true;
if (existsSync(makerStatePath)) {
  const state = JSON.parse(readFileSync(makerStatePath, "utf8"));
  if (typeof state.enabled !== "boolean")
    throw new Error("Invalid persisted maker state");
  makerEnabled = state.enabled;
}
export let workersPaused = false;
export function setWorkersPaused(value: boolean) {
  workersPaused = value;
}
export let makerConfig: MakerConfig = {
  volatility: 0.85,
  spreadBps: 1200,
  edge: 0.001,
  targetInventory: 90,
  maxWritten: 180,
  maxNetInventory: 150,
  maxPortfolioInventory: 10000,
  maxExpiryInventory: 3000,
  maxTotalWritten: 15000,
  inventorySkewBps: 2000,
};
if (existsSync(makerConfigPath))
  makerConfig = makerConfigSchema.parse({
    ...makerConfig,
    ...JSON.parse(readFileSync(makerConfigPath, "utf8")),
  });
if (process.env.STRATA_MAKER_CONFIG_JSON)
  makerConfig = makerConfigSchema.parse({
    ...makerConfig,
    ...JSON.parse(process.env.STRATA_MAKER_CONFIG_JSON),
  });
export function setMakerConfig(config: MakerConfig) {
  config = makerConfigSchema.parse(config);
  writeFileSync(makerConfigPath, JSON.stringify(config, null, 2));
  makerConfig = config;
}
export let lastQuote = 0;
export const workerErrors: string[] = [];
export function recordWorkerError(message: string) {
  // RPC errors can contain authenticated transport URLs. Never expose them in snapshots.
  workerErrors.push(safeDiagnostic(message).slice(0, 350));
  if (workerErrors.length > 50)
    workerErrors.splice(0, workerErrors.length - 50);
}
export async function transactions(address: Address) {
  if (cloudEnabled) {
    const rows = await cloudRequest<{ value: TransactionRecord }[]>(
      `strata_transactions?domain=eq.${manifest.chainId}:${manifest.engine.toLowerCase()}&account=eq.${address.toLowerCase()}&select=value&order=created.desc&limit=100`,
    );
    return rows.map((row) => row.value);
  }
  return db
    .prepare(
      "SELECT * FROM transactions WHERE lower(account)=lower(?) ORDER BY created DESC LIMIT 100",
    )
    .all(address) as unknown as TransactionRecord[];
}
export async function recordTransaction(record: TransactionRecord) {
  if (cloudEnabled)
    await cloudRequest("strata_transactions", "POST", {
      domain: `${manifest.chainId}:${manifest.engine.toLowerCase()}`,
      hash: record.hash,
      account: record.account.toLowerCase(),
      created: record.created,
      value: record,
    });
  db.prepare(
    "INSERT INTO transactions VALUES(?,?,?,?,?,?,?) ON CONFLICT(hash) DO UPDATE SET status=excluded.status,block=excluded.block",
  ).run(
    record.hash,
    record.account,
    record.target,
    record.operation,
    record.status,
    record.block,
    record.created,
  );
}
export function setMakerEnabled(value: boolean) {
  const temporary = `${makerStatePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ enabled: value }) + "\n");
  renameSync(temporary, makerStatePath);
  makerEnabled = value;
}
export function setLastQuote(timestamp: number) {
  lastQuote = timestamp;
}
export function rewindReadModel(block: bigint, hash: Hex) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM events WHERE block>?").run(Number(block));
    db.prepare("INSERT OR REPLACE INTO cursor VALUES(1,?,?)").run(
      Number(block),
      hash,
    );
    db.prepare(
      "UPDATE transactions SET status='orphaned' WHERE CAST(block AS INTEGER)>?",
    ).run(Number(block));
    db.exec("COMMIT");
    snapshot = undefined;
    allTrades = [];
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
const adapters = [
  ...new Set(
    manifestAssets(manifest)
      .map((a) => a.adapter.toLowerCase())
      .filter((a) => a !== manifest.oracle.toLowerCase()),
  ),
] as Address[];
const addresses = [
  manifest.engine,
  manifest.oracle,
  ...adapters,
  ...manifest.series.map((s) => s.market),
  ...(manifest.house ? [manifest.house.vault] : []),
];
const contractAbis = new Map<string, Abi>([
  ...(manifest.house
    ? [[manifest.house.vault.toLowerCase(), abi("HouseVault")] as [string, Abi]]
    : []),
  [manifest.engine.toLowerCase(), engineAbi],
  [manifest.oracle.toLowerCase(), oracleAbi],
  ...adapters.map((a) => [a, oracleAbi] as [string, Abi]),
  ...manifest.series.map(
    (s) =>
      [
        s.market.toLowerCase(),
        manifest.venueMode === "kuru" ? kuruAbi : abi("DemoOrderBook"),
      ] as [string, Abi],
  ),
]);

async function indexTo(latest: bigint) {
  let cursor = db.prepare("SELECT block,hash FROM cursor WHERE id=1").get() as
    { block: number; hash: string } | undefined;
  if (cursor) {
    const b =
      cursor.block <= latest
        ? await client.getBlock({ blockNumber: BigInt(cursor.block) })
        : null;
    if (!b || b.hash !== cursor.hash) {
      // Rebuild from the deployment boundary: a guessed 64-block ancestor
      // could retain orphaned trades after a deeper reorganization.
      db.prepare("DELETE FROM events").run();
      db.prepare("DELETE FROM cursor").run();
      db.prepare(
        "UPDATE transactions SET status='unconfirmed' WHERE status='included' OR status='reverted'",
      ).run();
      cursor = undefined;
      houseBackfill = undefined;
    }
  }
  // A killed batched replay may have stored some ranges beyond its last
  // canonical cursor. Discard those before resuming, including orphaned logs.
  db.prepare("DELETE FROM events WHERE block>?").run(cursor?.block ?? -1);
  // A vault added to an existing deployment needs its earlier logs once.
  const vault = manifest.house?.vault.toLowerCase();
  if (
    manifest.house &&
    cursor &&
    (!houseBackfill || houseBackfill.vault !== vault || !houseBackfill.complete)
  ) {
    const end = BigInt(cursor.block);
    const start =
      houseBackfill && houseBackfill.vault === vault
        ? BigInt(houseBackfill.nextBlock)
        : BigInt(manifest.house.deployedBlock);
    await backfillRanges({
      from: start,
      to: end,
      store: (from, to) => storeLogs([manifest.house!.vault], from, to),
      checkpoint: async (next, complete) => {
        houseBackfill = { vault: vault!, nextBlock: Number(next), complete };
        if (cloudEnabled && hasWorkerLease()) await persistCloudReadModel();
      },
    });
  }
  await replayLogRanges({
    from: BigInt(cursor ? cursor.block + 1 : manifest.deployedBlock),
    to: latest,
    range: manifest.chainId === 10143 ? 100n : 200n,
    fetch: (from, to) =>
      client.getLogs({ address: addresses, fromBlock: from, toBlock: to }),
    store: (logs, from, to, advance) =>
      storeLogs(addresses, from, to, advance, logs),
    checkpoint: async () => {
      if (cloudEnabled && hasWorkerLease()) await persistCloudReadModel();
    },
  });
  if (vault)
    houseBackfill = { vault, nextBlock: Number(latest + 1n), complete: true };
}
async function storeLogs(
  sources: Address[],
  from: bigint,
  to: bigint,
  advanceCursor = false,
  suppliedLogs?: Awaited<ReturnType<typeof client.getLogs>>,
) {
  const logs =
    suppliedLogs ??
    (await client.getLogs({
      address: sources,
      fromBlock: from,
      toBlock: to,
    }));
  const times = new Map<string, number>();
  for (const number of new Set(logs.map((l) => l.blockNumber!.toString()))) {
    const b = await client.getBlock({ blockNumber: BigInt(number) });
    times.set(number, Number(b.timestamp));
  }
  const insert = db.prepare(
    "INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?)",
  );
  const cursorBlock = advanceCursor
    ? await client.getBlock({ blockNumber: to })
    : undefined;
  db.exec("BEGIN");
  try {
    for (const l of logs) {
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: contractAbis.get(l.address.toLowerCase())!,
          data: l.data,
          topics: l.topics,
        });
      } catch {
        continue;
      }
      insert.run(
        `${manifest.chainId}:${l.blockHash}:${l.transactionHash}:${l.logIndex}`,
        Number(l.blockNumber),
        l.blockHash!,
        l.transactionHash!,
        l.address,
        decoded.eventName ?? "Unknown",
        json(decoded.args),
        times.get(l.blockNumber!.toString())!,
      );
    }
    if (advanceCursor) {
      db.prepare("INSERT OR REPLACE INTO cursor VALUES(1,?,?)").run(
        Number(to),
        cursorBlock!.hash!,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function depth(orders: BookOrder[], isBuy: boolean): DepthLevel[] {
  const levels = new Map<number, DepthLevel>();
  for (const o of orders.filter((o) => o.isBuy === isBuy && o.remaining > 0)) {
    const l = levels.get(o.price) ?? {
      price: o.price,
      quantity: 0,
      total: 0,
      orders: 0,
    };
    l.quantity += o.remaining;
    l.orders++;
    levels.set(o.price, l);
  }
  let total = 0;
  return [...levels.values()]
    .sort((a, b) => (isBuy ? b.price - a.price : a.price - b.price))
    .map((l) => ({ ...l, total: (total += l.quantity) }));
}
export async function readMakerInventory(
  market: { id: number; token: Address },
  orders: BookOrder[],
  blockNumber?: bigint,
  owner: Address = manifest.maker,
) {
  const at = blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const [walletClaims, venueClaims, writer] = (await Promise.all([
    client.readContract({
      address: market.token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber: at,
    }),
    manifest.kuruMargin
      ? client.readContract({
          address: manifest.kuruMargin,
          abi: marginAbi,
          functionName: "getBalance",
          args: [owner, market.token],
          blockNumber: at,
        })
      : Promise.resolve(0n),
    client.readContract({
      address: manifest.engine,
      abi: engineAbi,
      functionName: "writers",
      args: [BigInt(market.id), owner],
      blockNumber: at,
    }),
  ])) as [bigint, bigint, readonly [bigint, bigint]];
  const restingClaims = orders
    .filter(
      (order) =>
        !order.isBuy && order.owner.toLowerCase() === owner.toLowerCase(),
    )
    .reduce(
      (sum, order) =>
        sum + BigInt(Math.round(order.remaining * 1000)) * 10n ** 15n,
      0n,
    );
  return {
    walletClaims,
    venueClaims,
    restingClaims,
    writtenClaims: writer[0],
    collateral: writer[1],
    heldClaims: walletClaims + venueClaims + restingClaims,
  };
}
/** Indexed events emitted by one contract, in chain order. */
export function indexedEvents(address: Address) {
  return (
    db
      .prepare("SELECT * FROM events WHERE lower(address)=lower(?)")
      .all(address) as unknown as StoredEvent[]
  ).sort(
    (a, b) =>
      a.block - b.block ||
      Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)),
  );
}
type SnapshotExtension = (
  snapshot: Snapshot,
  blockNumber: bigint,
) => Promise<Partial<Snapshot>>;
const snapshotExtensions: SnapshotExtension[] = [];
/** Adds derived state (e.g. the house vault) to every snapshot built after this call. */
export function extendSnapshot(extension: SnapshotExtension) {
  snapshotExtensions.push(extension);
}
const displayPrices = new Map<string, { price: number; publishedAt: number }>();
/**
 * Off-chain Pyth prices shown on charts and marks while on-chain relays sleep.
 * They never gate trading: readiness and market health use on-chain prices only.
 */
export function setDisplayPrices(
  prices: Map<string, { price: number; publishedAt: number }>,
) {
  for (const [key, value] of prices) displayPrices.set(key, value);
}
const OBSERVED_PRICES = 720;
const observed = new Map<string, Snapshot["prices"]>();
/** Adds earlier chart points for an asset (e.g. a startup backfill). */
export function seedObservedPrices(key: string, points: Snapshot["prices"]) {
  const merged = new Map(
    [...points, ...(observed.get(key) ?? [])].map((p) => [p.timestamp, p]),
  );
  observed.set(
    key,
    [...merged.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-OBSERVED_PRICES),
  );
}
/** Returns a snapshot built after this call began; see coalesceFresh. */
export const refresh: () => Promise<Snapshot> = coalesceFresh(async () => {
  lastAttemptAt = Date.now();
  try {
    await buildSnapshot();
    lastSuccessfulRefreshAt = Date.now();
    refreshFailed = false;
    if (cloudEnabled && hasWorkerLease()) {
      await saveCloudState("public-snapshot", retainedSnapshot(current()!));
      await saveCloudState("public-health", {
        service: current()!.service,
        chainId: manifest.chainId,
      });
    }
    return current()!;
  } catch (error) {
    refreshFailed = true;
    throw error;
  }
});
async function buildSnapshot(): Promise<Snapshot> {
  const previousSnapshot = snapshot;
  const block = await client.getBlock();
  if (block.hash !== lastTipHash) {
    lastTipHash = block.hash!;
    lastProgressAt = Date.now();
  }
  if (!maxPriceAge)
    maxPriceAge = Number(
      await client.readContract({
        address: manifest.engine,
        abi: engineAbi,
        functionName: "maxPriceAge",
        blockNumber: block.number,
      }),
    );
  await indexTo(block.number);
  await reconcileReceipts();
  const events = (
    db
      .prepare("SELECT * FROM events ORDER BY block")
      .all() as unknown as StoredEvent[]
  ).sort(
    (a, b) =>
      a.block - b.block ||
      Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)),
  );
  const timestamp = Number(block.timestamp);
  const assets = manifestAssets(manifest);
  const quotes = new Map<
    string,
    {
      spot: number;
      /** On-chain publish time: the only time that gates trading. */
      published: number;
      /** Publish time of the displayed price (off-chain Pyth while relays sleep). */
      shownAt: number;
      valid: boolean;
      live: boolean;
    }
  >();
  await Promise.all(
    assets.map(async (asset) => {
      const previous = snapshot?.underlyings?.[asset.key];
      let raw = BigInt(Math.round((previous?.spot ?? 0) * 1e8)),
        at = BigInt(previous?.publishedAt ?? 0),
        valid = false;
      try {
        // The adapter keeps the last price readable after a session closes; the
        // router reports it as unavailable, which is what gates new exposure.
        [raw, at] = (await client.readContract({
          address: asset.adapter,
          abi: oracleAbi,
          functionName: "livePrice",
          args: [asset.assetId],
          blockNumber: block.number,
        })) as [bigint, bigint];
        valid = raw > 0n && at > 0n && at <= block.timestamp;
      } catch {
        // Keep contract custody and fixed expiry claims readable during an oracle outage.
      }
      const age = timestamp - Number(at);
      const display = displayPrices.get(asset.key);
      const shown =
        display && display.publishedAt > Number(at) ? display : null;
      quotes.set(asset.key, {
        spot: shown?.price ?? Number(raw) / 1e8,
        published: Number(at),
        shownAt: shown?.publishedAt ?? Number(at),
        valid,
        // A reference recorded outside the session never opens the market.
        live:
          valid &&
          age <= Math.min(maxPriceAge, asset.maxLiveAge) &&
          assetSessionOpen(asset, timestamp),
      });
    }),
  );
  const primary = assets.find((a) => a.key === "MON") ?? assets[0];
  const primaryQuote = quotes.get(primary.key)!;
  oracleValid = primaryQuote.valid;
  const spot = primaryQuote.spot,
    published = BigInt(primaryQuote.published);
  const keyByAssetId = new Map(
    assets.map((a) => [a.assetId.toLowerCase(), a.key]),
  );
  const trades: TradeRecord[] = [];
  const ordersByMarket = new Map<number, Map<string, BookOrder>>(
    manifest.series.map((s) => [s.id, new Map()]),
  );
  const pricesByAsset = new Map<string, Snapshot["prices"]>(
    assets.map((a) => [a.key, []]),
  );
  const settlements: Snapshot["settlements"] = [];
  for (const e of events) {
    const a = JSON.parse(e.args) as Record<string, any>;
    if (e.event === "PricePublished") {
      const key = keyByAssetId.get(String(a.asset).toLowerCase());
      if (key)
        pricesByAsset.get(key)!.push({
          timestamp: Number(a.timestamp),
          price: Number(a.price) / 1e8,
        });
    }
    if (e.event === "Finalized")
      settlements.push({
        asset: a.asset,
        expiry: Number(a.expiry),
        price: Number(a.price) / 1e8,
        publishedAt: Number(a.publishedAt),
        proofHash: a.proofHash,
        hash: e.tx,
      });
    const cfg = manifest.series.find(
      (s) => s.market.toLowerCase() === e.address.toLowerCase(),
    );
    if (!cfg) continue;
    const map = ordersByMarket.get(cfg.id)!;
    if (e.event === "OrderCreated") {
      const id = String(a.orderId ?? a.id),
        q =
          Number(a.size ?? a.quantity) /
          (manifest.venueMode === "kuru" ? 1000 : 1e18),
        p = Number(a.price) / 1e6;
      map.set(id, {
        id,
        owner: a.owner,
        isBuy: a.isBuy,
        price: p,
        remaining: q,
        reserved: a.isBuy ? q * p : q,
      });
    }
    if (e.event === "OrdersCanceled")
      for (const id of a.orderId ?? []) map.delete(String(id));
    if (e.event === "OrderCancelled" || e.event === "OrderCanceled")
      map.delete(String(a.id ?? a.orderId));
    if (e.event === "Trade") {
      const id = String(a.orderId ?? a.id),
        quantity =
          Number(a.filledSize ?? a.quantity) /
          (manifest.venueMode === "kuru" ? 1000 : 1e18);
      const price =
        Number(a.price) / (manifest.venueMode === "kuru" ? 1e18 : 1e6);
      const maker = a.makerAddress ?? a.maker,
        taker = a.txOrigin ?? a.taker;
      const order = map.get(id);
      if (order) {
        order.remaining =
          manifest.venueMode === "kuru"
            ? Number(a.updatedSize) / 1000
            : Math.max(0, order.remaining - quantity);
        order.reserved = order.isBuy
          ? order.remaining * order.price
          : order.remaining;
        if (order.remaining === 0) map.delete(id);
      }
      trades.push({
        hash: e.tx,
        block: String(e.block),
        timestamp: e.timestamp,
        marketId: cfg.id,
        maker,
        taker,
        isBuy: a.isBuy ?? a.takerBuy,
        quantity,
        price,
        quote:
          manifest.venueMode === "kuru"
            ? quantity * price
            : Number(a.quoteAmount) / 1e6,
        controlled: maker.toLowerCase() === manifest.maker.toLowerCase(),
      });
    }
  }
  const markets = await Promise.all(
    manifest.series.map(async (cfg) => {
      const s = (await client.readContract({
        address: manifest.engine,
        abi: engineAbi,
        blockNumber: block.number,
        functionName: "getSeries",
        args: [BigInt(cfg.id)],
      })) as { escrow: bigint; shortQuantity: bigint; cap: bigint };
      const asset = assetFor(manifest, cfg),
        quote = quotes.get(asset.key)!;
      const volatility =
        asset.key === "MON" ? makerConfig.volatility : asset.volatility;
      const settlement = (await client.readContract({
        address: manifest.oracle,
        abi: oracleAbi,
        blockNumber: block.number,
        functionName: "settlementPrice",
        args: [asset.assetId, cfg.expiry],
      })) as bigint;
      const orders = [...ordersByMarket.get(cfg.id)!.values()],
        bids = depth(orders, true),
        asks = depth(orders, false);
      const greeks = markSeries(
        cfg.kind,
        quote.spot,
        cfg.strike,
        cfg.upperStrike,
        Math.max(0, cfg.expiry - timestamp) / 31536000,
        volatility,
        settlement ? Number(settlement) / 1e8 : null,
      );
      return {
        ...cfg,
        bid: bids[0]?.price ?? null,
        ask: asks[0]?.price ?? null,
        mark: greeks.price,
        iv: volatility,
        greeks,
        bids,
        asks,
        orders,
        volume: trades
          .filter((t) => t.marketId === cfg.id)
          .reduce((sum, t) => sum + t.quote, 0),
        openInterest:
          Number(
            await client.readContract({
              address: cfg.token,
              abi: tokenAbi,
              blockNumber: block.number,
              functionName: "totalSupply",
            }),
          ) / 1e18,
        escrow: Number(s.escrow) / (cfg.kind === "call" ? 1e18 : 1e6),
        cap: Number(s.cap) / (cfg.kind === "call" ? 1e18 : 1e6),
        settlementPrice: settlement ? Number(settlement) / 1e8 : null,
        active: cfg.expiry > timestamp,
        healthy: quote.live,
      } satisfies Market;
    }),
  );
  const inventory: MakerInventory[] = await Promise.all(
    markets.map(async (market) => {
      const position = await readMakerInventory(
        market,
        market.orders,
        block.number,
      );
      const policy = makerInventoryPolicy({
        heldClaims: position.heldClaims,
        writtenClaims: position.writtenClaims,
        maxNetInventory: BigInt(makerConfig.maxNetInventory) * 10n ** 18n,
        inventorySkewBps: makerConfig.inventorySkewBps,
        fair: market.mark,
      });
      const netQuantity = Number(policy.netClaims) / 1e18;
      return {
        marketId: market.id,
        walletClaims: position.walletClaims.toString(),
        venueClaims: position.venueClaims.toString(),
        restingClaims: position.restingClaims.toString(),
        writtenClaims: position.writtenClaims.toString(),
        collateral: position.collateral.toString(),
        netQuantity,
        optionDelta: netQuantity * market.greeks.delta,
        optionVega: netQuantity * market.greeks.vega,
        bidCapacity: Number(policy.bidCapacityLots) / 1000,
        askCapacity: Number(policy.askCapacityLots) / 1000,
        priceSkewBps: policy.priceSkewBps,
        reservationPrice: policy.reservationPrice,
      };
    }),
  );
  const [usd, mon, venueUsd] = (await Promise.all([
    client.readContract({
      address: manifest.usdc,
      abi: tokenAbi,
      blockNumber: block.number,
      functionName: "balanceOf",
      args: [manifest.maker],
    }),
    client.readContract({
      address: manifest.wmon,
      abi: tokenAbi,
      blockNumber: block.number,
      functionName: "balanceOf",
      args: [manifest.maker],
    }),
    manifest.kuruMargin
      ? client.readContract({
          address: manifest.kuruMargin,
          abi: marginAbi,
          functionName: "getBalance",
          args: [manifest.maker, manifest.usdc],
          blockNumber: block.number,
        })
      : Promise.resolve(0n),
  ])) as bigint[];
  const portfolioRisk = makerSnapshotRisk(
    markets,
    inventory,
    manifest.maker,
    makerConfig,
  );
  for (const position of inventory) {
    const capacity = portfolioRisk.markets.find(
      (m) => m.marketId === position.marketId,
    )!;
    position.bidCapacity = Math.min(
      position.bidCapacity,
      Number(capacity.bidClaims / 10n ** 15n) / 1000,
    );
    position.askCapacity = Math.min(
      position.askCapacity,
      Number(capacity.askClaims / 10n ** 15n) / 1000,
    );
  }
  allTrades = trades;
  const underlyings: Record<string, UnderlyingState> = {};
  for (const asset of assets) {
    const quote = quotes.get(asset.key)!;
    if (manifest.oracleMode === "pyth" && quote.valid) {
      // Verifier updates are not indexed; chart history is what this service observed.
      const seen = observed.get(asset.key) ?? [];
      if (seen.at(-1)?.timestamp !== quote.shownAt)
        observed.set(
          asset.key,
          [...seen, { timestamp: quote.shownAt, price: quote.spot }].slice(
            -OBSERVED_PRICES,
          ),
        );
      pricesByAsset.set(asset.key, observed.get(asset.key)!);
    }
    let open = quote.live,
      nextChange: number | null = null;
    try {
      const schedule = parseSchedule(asset.schedule, asset.scheduleSnapshot);
      open = isOpen(schedule, timestamp);
      nextChange = nextSessionChange(schedule, timestamp);
    } catch {
      // Outside the schedule snapshot: fall back to live price state.
    }
    underlyings[asset.key] = {
      key: asset.key,
      spot: quote.spot,
      publishedAt: quote.shownAt,
      live: quote.live,
      open,
      nextChange,
      prices: pricesByAsset.get(asset.key)!.slice(-OBSERVED_PRICES),
    };
  }
  const prices = underlyings[primary.key].prices;
  snapshot = {
    service: readiness(),
    underlyings,
    manifest,
    block: block.number.toString(),
    blockHash: block.hash!,
    timestamp,
    spot,
    pricePublishedAt: Number(published),
    markets,
    trades: trades.slice(-200),
    prices: prices.slice(-360),
    settlements,
    maker: {
      address: manifest.maker,
      usdc: Number(usd) / 1e6,
      venueUsdc: Number(venueUsd) / 1e6,
      wmon: Number(mon) / 1e18,
      lastQuote,
      enabled: makerEnabled,
      maintenance: workersPaused,
      errors: workerErrors.slice(-5),
      config: makerConfig,
      inventory,
      risk: {
        grossClaims: portfolioRisk.grossClaims.toString(),
        reservedGrossClaims: portfolioRisk.reservedGrossClaims.toString(),
        writtenClaims: portfolioRisk.writtenClaims.toString(),
        actualBreached: portfolioRisk.actualBreached,
        reservationBreached: portfolioRisk.reservationBreached,
        issuanceBreached: portfolioRisk.issuanceBreached,
        expiries: portfolioRisk.expiries.map((e) => ({
          expiry: e.expiry,
          grossClaims: e.grossClaims.toString(),
          reservedGrossClaims: e.reservedGrossClaims.toString(),
        })),
      },
    },
    indexer: {
      lastBlock: block.number.toString(),
      lag: 0,
      eventCount: events.length,
      status: "healthy",
    },
  };
  // Publish only the complete snapshot; an extension failure keeps the last one.
  let next = snapshot;
  snapshot = previousSnapshot;
  for (const extension of snapshotExtensions)
    next = { ...next, ...(await extension(next, block.number)) };
  snapshot = next;
  return snapshot;
}
let receiptOffset = 0;
async function reconcileReceipts() {
  const count = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM transactions WHERE status IN ('pending','unconfirmed')",
      )
      .get() as { count: number }
  ).count;
  receiptOffset = count ? receiptOffset % count : 0;
  const records = db
    .prepare(
      "SELECT hash,status FROM transactions WHERE status IN ('pending','unconfirmed') ORDER BY created,hash LIMIT 20 OFFSET ?",
    )
    .all(receiptOffset) as { hash: Hex; status: string }[];
  receiptOffset = count ? (receiptOffset + records.length) % count : 0;
  for (const record of records) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: record.hash });
      const canonical = await client.getBlock({
        blockNumber: receipt.blockNumber,
      });
      const status =
        canonical.hash !== receipt.blockHash
          ? "orphaned"
          : receipt.status === "success"
            ? "included"
            : "reverted";
      db.prepare("UPDATE transactions SET status=?,block=? WHERE hash=?").run(
        status,
        receipt.blockNumber.toString(),
        record.hash,
      );
    } catch (e) {
      if (!(e instanceof TransactionReceiptNotFoundError)) throw e;
      if (record.status === "unconfirmed")
        db.prepare(
          "UPDATE transactions SET status='orphaned' WHERE hash=?",
        ).run(record.hash);
    }
  }
}
export function current() {
  if (!snapshot) return undefined;
  const service = readiness();
  return {
    ...snapshot,
    service,
    markets: snapshot.markets.map((market) => ({
      ...market,
      healthy: market.healthy && service.newExposureAllowed,
    })),
    indexer: {
      ...snapshot.indexer,
      status:
        service.status === "offline"
          ? ("error" as const)
          : ("healthy" as const),
      error:
        service.status === "offline"
          ? (service.reason ?? undefined)
          : undefined,
    },
  };
}
const READ_BATCH = manifest.chainId === 10143 ? 32 : 4;
/** Public multicalls batch the shelf; forks bound remote cold-storage fetches. */
async function inBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += READ_BATCH)
    results.push(
      ...(await Promise.all(items.slice(i, i + READ_BATCH).map(fn))),
    );
  return results;
}
export async function portfolio(address: Address): Promise<Portfolio> {
  const snap = snapshot ?? (await refresh());
  const [usd, mon, native] = (await Promise.all([
    client.readContract({
      address: manifest.usdc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [address],
    }),
    client.readContract({
      address: manifest.wmon,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [address],
    }),
    client.getBalance({ address }),
  ])) as bigint[];
  const rawEvents = db
    .prepare("SELECT * FROM events WHERE lower(address)=lower(?)")
    .all(manifest.engine) as unknown as StoredEvent[];
  const positions = await inBatches(snap.markets, async (m) => {
    const [balance, w] = (await Promise.all([
      client.readContract({
        address: m.token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [address],
      }),
      client.readContract({
        address: manifest.engine,
        abi: engineAbi,
        functionName: "writers",
        args: [BigInt(m.id), address],
      }),
    ])) as [bigint, [bigint, bigint]];
    const owned = m.orders.filter(
      (o) => o.owner.toLowerCase() === address.toLowerCase(),
    );
    let venueFree = 0;
    if (manifest.kuruMargin)
      venueFree =
        Number(
          await client.readContract({
            address: manifest.kuruMargin,
            abi: marginAbi,
            functionName: "getBalance",
            args: [address, m.token],
          }),
        ) / 1e18;
    const fills = allTrades
      .filter(
        (t) =>
          t.marketId === m.id &&
          (t.taker.toLowerCase() === address.toLowerCase() ||
            t.maker.toLowerCase() === address.toLowerCase()),
      )
      .map((t) => ({
        ...t,
        isBuy:
          t.taker.toLowerCase() === address.toLowerCase() ? t.isBuy : !t.isBuy,
      }));
    const claims = rawEvents
      .filter((e) => e.event === "Redeemed")
      .map((e) => JSON.parse(e.args))
      .filter(
        (a) =>
          Number(a.id) === m.id &&
          a.holder.toLowerCase() === address.toLowerCase(),
      );
    return {
      marketId: m.id,
      quantity: Number(balance) / 1e18,
      writerQuantity: Number(w[0]) / 1e18,
      collateral: Number(w[1]) / (m.kind === "call" ? 1e18 : 1e6),
      reserved: owned
        .filter((o) => !o.isBuy)
        .reduce((s, o) => s + o.remaining, 0),
      venueFree,
      paidPremium: fills
        .filter((t) => t.isBuy)
        .reduce((s, t) => s + t.quote, 0),
      proceeds: fills.filter((t) => !t.isBuy).reduce((s, t) => s + t.quote, 0),
      claimed: claims.reduce(
        (s, a) => s + Number(a.payout) / (m.kind === "call" ? 1e18 : 1e6),
        0,
      ),
    };
  });
  const venueUsdc = manifest.kuruMargin
    ? Number(
        await client.readContract({
          address: manifest.kuruMargin,
          abi: marginAbi,
          functionName: "getBalance",
          args: [address, manifest.usdc],
        }),
      ) / 1e6
    : 0;
  return {
    address,
    usdc: Number(usd) / 1e6,
    wmon: Number(mon) / 1e18,
    native: Number(native) / 1e18,
    venueUsdc,
    positions,
    orders: snap.markets.flatMap((m) =>
      m.orders
        .filter((o) => o.owner.toLowerCase() === address.toLowerCase())
        .map((o) => ({ ...o, marketId: m.id })),
    ),
  };
}

/** Whether a scheduled asset's session is open at a chain timestamp. */
export function assetSessionOpen(
  asset: ReturnType<typeof manifestAssets>[number],
  timestamp: number,
) {
  try {
    return isOpen(
      parseSchedule(asset.schedule, asset.scheduleSnapshot),
      timestamp,
    );
  } catch {
    return asset.policy !== "pyth-latest-before-close";
  }
}

/** Seconds until an asset's next session open (0 when already open). */
export function secondsUntilOpen(
  asset: ReturnType<typeof manifestAssets>[number],
  timestamp: number,
) {
  if (assetSessionOpen(asset, timestamp)) return 0;
  const next = nextSessionChange(
    parseSchedule(asset.schedule, asset.scheduleSnapshot),
    timestamp,
  );
  if (next === null) throw new Error(`${asset.key} has no upcoming session`);
  return next - timestamp;
}

/** Controlled demo prices only; refuses scheduled assets outside their session. */
export async function publishControlledPrice(key: string, price: number) {
  const asset = manifestAssets(manifest).find((a) => a.key === key);
  if (!asset) throw new Error(`Unknown asset ${key}`);
  const block = await client.getBlock();
  if (!assetSessionOpen(asset, Number(block.timestamp)))
    throw new Error(`${key} market is closed at chain time`);
  return send(manifest.deployer, asset.adapter, oracleAbi, "publish", [
    asset.assetId,
    BigInt(Math.round(price * 1e8)),
  ]);
}

const unresolved = new Set<string>();
/** Finalizes every elapsed (asset, expiry) whose challenge window has passed. */
export async function finalizeElapsed(caller: Address) {
  const timestamp = Number((await client.getBlock()).timestamp);
  const pending = new Map<string, { assetId: Hex; expiry: number }>();
  for (const series of manifest.series) {
    if (series.expiry > timestamp) continue;
    const asset = assetFor(manifest, series);
    if (
      asset.policy === "pyth-latest-before-close" &&
      timestamp < series.expiry + asset.challengeWindow
    )
      continue;
    pending.set(`${asset.assetId}:${series.expiry}`, {
      assetId: asset.assetId,
      expiry: series.expiry,
    });
  }
  for (const { assetId, expiry } of pending.values()) {
    const price = await client.readContract({
      address: manifest.oracle,
      abi: oracleAbi,
      functionName: "settlementPrice",
      args: [assetId, expiry],
    });
    if (price) continue;
    // An expiry without a usable observation stays unresolved (bilateral unwind
    // remains open); it must not block the other settlements.
    try {
      await send(caller, manifest.oracle, oracleAbi, "finalize", [
        assetId,
        expiry,
        [],
      ]);
    } catch (error) {
      const key = `${assetId}:${expiry}`;
      if (!unresolved.has(key))
        recordWorkerError(
          `Settlement ${key} unresolved: ${error instanceof Error ? error.message : String(error)}`,
        );
      unresolved.add(key);
    }
  }
}
