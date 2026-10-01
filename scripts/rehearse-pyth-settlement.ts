import "dotenv/config";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { artifact } from "./artifacts.ts";
import { waitReceipt } from "../packages/core/src/receipts.ts";
import {
  fetchEvidence,
  fetchUpdate,
  type Evidence,
} from "../packages/core/src/hermes.ts";
import { pythAbi } from "../packages/core/src/pyth.ts";
import {
  asset as registryAsset,
  isOpen,
  nextSessionChange,
  parseSchedule,
} from "../packages/core/src/index.ts";
import { pushedUpdateSource } from "../packages/core/src/pushed-updates.ts";
import {
  sessionCloseOracleAbi,
  settleSessionClose,
  type KeeperChain,
  type UpdateSource,
} from "../packages/core/src/settlement-keeper.ts";

/**
 * Settles real Pyth data through the router on an isolated fork of Monad
 * testnet: a 24/7 asset on the first update after expiry and a scheduled asset
 * on its last print before a real session close. Nothing is broadcast publicly.
 */
const SCHEDULED = process.env.REHEARSAL_SCHEDULED_ASSET ?? "XAU";
const CONTINUOUS = process.env.REHEARSAL_CONTINUOUS_ASSET ?? "BTC";
const LOOKBACK = 4 * 86400;
// The longest window the adapter allows, so yesterday's close can still be proposed.
const CHALLENGE_WINDOW = 2 * 86400;
const EARLIER_PRINT_SECONDS = 30;
const CONTINUOUS_EXPIRY_AGE = 600;
const DEFAULT_VERIFIER = "0x2880aB155794e7179c9eE2e38200202908C17B43";
/** Where MON updates are already pushed on Monad testnet; reused as proofs. */
const PUSHED = "MON";
const PUSHED_CONTRACT =
  process.env.PYTH_PUSHED_CONTRACT ||
  "0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379";
const PUSHED_EXPIRY_AGE = 120;

const access = {
  endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
  apiKey: process.env.PYTH_API_KEY ?? "",
};
if (!access.apiKey)
  throw new Error("Configure PYTH_API_KEY in the ignored .env file");
const verifier = getAddress(process.env.PYTH_VERIFIER || DEFAULT_VERIFIER);
const forkUrl = process.env.FORK_RPC_URL ?? "https://testnet-rpc.monad.xyz";

const reservation = createServer();
await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((r) => reservation.close(() => r()));
const node = spawn(
  "anvil",
  [
    "--chain-id",
    "31337",
    "--fork-url",
    forkUrl,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--silent",
  ],
  { stdio: "ignore" },
);
const rpcUrl = `http://127.0.0.1:${port}`;
const chain = defineChain({
  id: 31337,
  name: "Pyth settlement rehearsal",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const transport = http(rpcUrl, { timeout: 30000, retryCount: 0 });
const client = createPublicClient({ chain, transport, pollingInterval: 100 });
const test = createTestClient({ chain, mode: "anvil", transport });

/** Chain errors can quote the fork endpoint; keep reports free of URLs. */
const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .split("\n")
    .slice(0, 2)
    .join(" ")
    .replace(/https?:\/\/[^\s"<>]+/gi, "[endpoint]");

try {
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try {
      ready = (await client.getChainId()) === 31337;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!ready) throw new Error("Isolated testnet fork did not start");
  const code = await client.getCode({ address: verifier });
  if (!code || code === "0x")
    throw new Error("Pyth verifier has no code on the forked network");
  const [deployer] = await createWalletClient({
    chain,
    transport,
  }).getAddresses();
  const wallet = createWalletClient({ account: deployer, chain, transport });

  async function send(
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
    value = 0n,
  ): Promise<Hex> {
    const simulation = await client.simulateContract({
      account: deployer,
      address,
      abi,
      functionName,
      args,
      value,
    });
    const hash = await wallet.writeContract(simulation.request);
    const receipt = await waitReceipt(client, hash);
    if (receipt.status !== "success")
      throw new Error(`Reverted ${functionName}`);
    return hash;
  }
  async function deploy(name: string, args: unknown[] = []) {
    const hash = await wallet.deployContract({ ...artifact(name), args });
    const receipt = await waitReceipt(client, hash);
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw new Error(`Deployment failed ${name}`);
    return receipt.contractAddress;
  }
  const read = (
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
  ) => client.readContract({ address, abi, functionName, args });
  const now = async () => Number((await client.getBlock()).timestamp);
  const keeper: KeeperChain = { read, send, now };
  const source: UpdateSource = (feed, timestamp) =>
    fetchUpdate(access, feed, timestamp);
  const normalized = (e: Evidence) => {
    const shift = e.exponent + 8;
    return shift >= 0
      ? BigInt(e.price) * 10n ** BigInt(shift)
      : BigInt(e.price) / 10n ** BigInt(-shift);
  };
  const fee = (updates: Hex[]) =>
    read(verifier, pythAbi, "getUpdateFee", [updates]) as Promise<bigint>;

  // Arrange: the production adapters behind one router, bound per asset.
  const continuous = registryAsset(CONTINUOUS),
    scheduled = registryAsset(SCHEDULED);
  if (scheduled.settlement !== "pyth-latest-before-close")
    throw new Error(`${SCHEDULED} is not a scheduled asset`);
  const routerAbi = artifact("OracleRouter").abi;
  const firstAdapter = await deploy("PythExpiryOracle", [verifier]),
    closeAdapter = await deploy("PythSessionCloseOracle", [
      verifier,
      LOOKBACK,
      CHALLENGE_WINDOW,
    ]),
    router = await deploy("OracleRouter");
  await send(router, routerAbi, "bind", [
    continuous.pythFeedId,
    firstAdapter,
    continuous.maxLiveAge,
  ]);
  await send(router, routerAbi, "bind", [
    scheduled.pythFeedId,
    closeAdapter,
    scheduled.maxLiveAge,
  ]);

  // Live prices: a real update pushed to the verifier reads through the router.
  const live: Record<string, unknown> = {};
  for (const spec of [continuous, scheduled]) {
    const update = await fetchUpdate(access, spec.pythFeedId);
    if (!update) throw new Error(`No latest update for ${spec.key}`);
    await test.setNextBlockTimestamp({
      timestamp: BigInt(Math.max(update.publishTime, await now()) + 1),
    });
    await send(
      verifier,
      pythAbi,
      "updatePriceFeeds",
      [update.updates],
      await fee(update.updates),
    );
    const [price, publishedAt] = (await read(router, routerAbi, "livePrice", [
      spec.pythFeedId,
    ])) as [bigint, bigint];
    live[spec.key] = {
      routerPrice: price.toString(),
      publishedAt: publishedAt.toString(),
      matchesUpdate: price === normalized(update),
    };
  }

  // A 24/7 asset with no Hermes access: the last update someone else pushed
  // on the real network before expiry, proposed here as the settlement proof.
  const pushed = registryAsset(PUSHED);
  await send(router, routerAbi, "bind", [
    pushed.pythFeedId,
    closeAdapter,
    pushed.maxLiveAge,
  ]);
  const pushedExpiry = (await now()) - PUSHED_EXPIRY_AGE;
  const pushedStep = await settleSessionClose(
    keeper,
    pushedUpdateSource(
      createPublicClient({ transport: http(forkUrl, { timeout: 30000 }) }),
      getAddress(PUSHED_CONTRACT),
    ),
    { assetId: pushed.pythFeedId, adapter: closeAdapter },
    pushedExpiry,
  );
  const pushedCandidate = (await read(
    closeAdapter,
    sessionCloseOracleAbi,
    "candidate",
    [pushed.pythFeedId, BigInt(pushedExpiry)],
  )) as readonly [bigint, bigint, bigint, number, bigint, Hex];

  // 24/7 asset: the unique first update at or after expiry.
  const firstExpiry = (await now()) - CONTINUOUS_EXPIRY_AGE;
  const first = await fetchEvidence({
    ...access,
    feed: continuous.pythFeedId,
    expiry: firstExpiry,
  });
  await send(
    router,
    routerAbi,
    "finalize",
    [continuous.pythFeedId, BigInt(firstExpiry), first.updates],
    await fee(first.updates),
  );
  const firstSettled = (await read(router, routerAbi, "settlementPrice", [
    continuous.pythFeedId,
    BigInt(firstExpiry),
  ])) as bigint;

  // Scheduled asset: its most recent real session close.
  const schedule = parseSchedule(
    scheduled.schedule,
    scheduled.scheduleSnapshot,
  );
  const current = await now();
  let cursor = current - 86400,
    close = 0;
  for (;;) {
    const change = nextSessionChange(schedule, cursor);
    if (change === null || change >= current) break;
    if (!isOpen(schedule, change)) close = change;
    cursor = change;
  }
  if (!close) throw new Error(`${SCHEDULED} had no session close to settle`);
  const args = [scheduled.pythFeedId, BigInt(close)];
  const earlier = await fetchUpdate(
    access,
    scheduled.pythFeedId,
    close - EARLIER_PRINT_SECONDS,
  );
  if (!earlier || earlier.publishTime > close)
    throw new Error("No earlier print to test replacement with");
  const proposeEarlier = async () =>
    send(
      closeAdapter,
      sessionCloseOracleAbi,
      "propose",
      [...args, earlier.updates],
      await fee(earlier.updates),
    );
  await proposeEarlier();
  const afterEarlier = (await read(
    closeAdapter,
    sessionCloseOracleAbi,
    "candidate",
    args,
  )) as readonly [bigint, ...unknown[]];
  // Act: the keeper replaces it with the last print, and nothing can move it back.
  const proposed = await settleSessionClose(
    keeper,
    source,
    { assetId: scheduled.pythFeedId, adapter: closeAdapter },
    close,
  );
  const candidate = (await read(
    closeAdapter,
    sessionCloseOracleAbi,
    "candidate",
    args,
  )) as readonly [bigint, bigint, bigint, number, bigint, Hex];
  let earlierRejected = "";
  try {
    await proposeEarlier();
  } catch (error) {
    earlierRejected = reason(error);
  }
  let earlyFinalizeRejected = "";
  try {
    await send(router, routerAbi, "finalize", [...args, []]);
  } catch (error) {
    earlyFinalizeRejected = reason(error);
  }
  const waiting = await settleSessionClose(
    keeper,
    source,
    { assetId: scheduled.pythFeedId, adapter: closeAdapter },
    close,
  );
  await test.increaseTime({ seconds: CHALLENGE_WINDOW });
  await test.mine({ blocks: 1 });
  const finalized = await settleSessionClose(
    keeper,
    source,
    { assetId: scheduled.pythFeedId, adapter: closeAdapter },
    close,
  );
  const closeSettled = (await read(router, routerAbi, "settlementPrice", [
    ...args,
  ])) as bigint;
  // The same time jump closed the pushed asset's window: fix its candidate too.
  const pushedFinal = await settleSessionClose(
    keeper,
    async () => null,
    { assetId: pushed.pythFeedId, adapter: closeAdapter },
    pushedExpiry,
  );
  const pushedSettled = (await read(router, routerAbi, "settlementPrice", [
    pushed.pythFeedId,
    BigInt(pushedExpiry),
  ])) as bigint;

  // Assert.
  const report = {
    isolatedTestnetFork: true,
    genuinePythSignaturesVerified: true,
    verifier,
    live,
    continuous: {
      asset: continuous.key,
      expiry: firstExpiry,
      publishedAt: first.publishTime,
      settlementPrice: firstSettled.toString(),
      settledOnFirstUpdate: firstSettled === normalized(first),
    },
    pushedOnChain: {
      asset: pushed.key,
      sourceContract: PUSHED_CONTRACT,
      expiry: pushedExpiry,
      keeperSteps: [pushedStep, pushedFinal],
      lastUpdatePublishedAt: Number(pushedCandidate[0]),
      secondsBeforeExpiry: pushedExpiry - Number(pushedCandidate[0]),
      settlementPrice: pushedSettled.toString(),
      settledOnLastPushedUpdate:
        pushedSettled === pushedCandidate[4] && pushedSettled > 0n,
    },
    scheduled: {
      asset: scheduled.key,
      close,
      closeIso: new Date(close * 1000).toISOString(),
      earlierCandidateAccepted: Number(afterEarlier[0]) === earlier.publishTime,
      keeperSteps: [proposed, waiting, finalized],
      lastPrintPublishedAt: Number(candidate[0]),
      secondsBeforeClose: close - Number(candidate[0]),
      rawPrice: candidate[1].toString(),
      confidence: candidate[2].toString(),
      exponent: candidate[3],
      settlementPrice: closeSettled.toString(),
      settledOnLastPrint: closeSettled === candidate[4] && closeSettled > 0n,
      earlierPrintRejected: earlierRejected,
      finalizeInsideWindowRejected: earlyFinalizeRejected,
    },
  };
  if (
    !report.continuous.settledOnFirstUpdate ||
    pushedStep !== "propose" ||
    pushedFinal !== "finalize" ||
    !report.pushedOnChain.settledOnLastPushedUpdate ||
    !report.scheduled.earlierCandidateAccepted ||
    proposed !== "propose" ||
    waiting !== "wait" ||
    finalized !== "finalize" ||
    !report.scheduled.settledOnLastPrint ||
    Number(candidate[0]) <= earlier.publishTime ||
    !earlierRejected ||
    !earlyFinalizeRejected
  )
    throw new Error(
      `Real-data settlement rehearsal failed: ${JSON.stringify(report)}`,
    );
  const directory = resolve(".runtime/pyth-settlement-rehearsals");
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, reportPath: path }, null, 2));
} catch (error) {
  console.error(
    (error instanceof Error ? error.message : String(error))
      .replace(/https?:\/\/[^\s"<>]+/gi, "[endpoint]")
      .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [redacted]")
      .slice(0, 2500),
  );
  process.exitCode = 1;
} finally {
  node.kill("SIGTERM");
}
