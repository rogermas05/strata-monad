import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createTestClient,
  parseAbi,
  parseAbiItem,
  type Address,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import {
  parseDeploymentManifest,
  loopbackRpc,
} from "../packages/core/src/deployment-config.ts";
import { prepareDeploymentPackage } from "../packages/core/src/deployment-package.ts";
import { assetFor } from "../packages/core/src/manifest-assets.ts";
import { artifact } from "./artifacts.ts";
import { prepareMakerBootstrap } from "../packages/core/src/maker-bootstrap.ts";
import { executeMakerBootstrap } from "./bootstrap-maker.ts";
import { cleanupExpiredMaker } from "../packages/core/src/expiry-cleanup.ts";
import { waitReceipt } from "../packages/core/src/receipts.ts";
import {
  executeLocalDeployment,
  writeDeploymentJson,
} from "./deployment-executor.ts";

const parent = parseDeploymentManifest(
  readFileSync(".runtime/manifest.json", "utf8"),
);
if (parent.chainId !== 31337 || !loopbackRpc(parent.rpcUrl))
  throw new Error("Deployment rehearsal requires the existing local fork");
const parentClient = createPublicClient({ transport: http(parent.rpcUrl) });
const forkBlock = await parentClient.getBlockNumber({ cacheTime: 0 });
const reservation = createServer();
await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((r) => reservation.close(() => r()));
const directory = resolve(`.runtime/deployment-rehearsals/${Date.now()}`);
mkdirSync(directory, { recursive: true });
const log = openSync(resolve(directory, "anvil.log"), "a");
const child = spawn(
  "anvil",
  [
    "--chain-id",
    "31337",
    "--fork-url",
    parent.rpcUrl,
    "--fork-block-number",
    String(forkBlock),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--silent",
  ],
  { stdio: ["ignore", log, log] },
);
const rpcUrl = `http://127.0.0.1:${port}`;
const client = createPublicClient({
  transport: http(rpcUrl, { timeout: 15000, retryCount: 0 }),
  pollingInterval: 100,
});
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await client.getChainId()) === 31337;
      if (ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error("Isolated rehearsal fork did not start");
  const block = await client.getBlock();
  const intent = {
    version: 1,
    chainId: 31337,
    rpcUrl,
    deployer: parent.deployer,
    maker: parent.maker,
    demoUser: parent.demoUser,
    factory: parent.kuruFactory,
    margin: parent.kuruMargin,
    oracle: { mode: "demo", price: "1.03" },
    feed: parent.assetId,
    maxPriceAge: 3600,
    assets: (parent.assets ?? [])
      .filter((a) => a.key !== "MON")
      .map((a) => ({
        key: a.key,
        reference: String(a.reference),
        volatility: a.volatility,
      })),
    series: parent.series
      .filter((s) => s.expiry > Number(block.timestamp) + 600)
      .map((s) => ({
        symbol: s.symbol,
        asset: s.asset,
        expiry: s.expiry,
        kind: s.kind,
        strike: String(s.strike),
        ...(s.upperStrike ? { upperStrike: String(s.upperStrike) } : {}),
        cap: s.kind === "call" ? "100000000000000000000000" : "1000000000000",
      })),
  };
  const pkg = await prepareDeploymentPackage(client, intent, artifact);
  writeDeploymentJson(resolve(directory, "intent.json"), intent);
  writeDeploymentJson(resolve(directory, "package.json"), pkg);
  const nonceBefore = await client.getTransactionCount({
    address: pkg.intent.deployer,
  });
  let tamperRejected = false;
  try {
    await executeLocalDeployment(
      {
        ...pkg,
        steps: pkg.steps.map((s, i) => (i === 0 ? { ...s, data: "0x00" } : s)),
      },
      directory,
    );
  } catch (error) {
    tamperRejected =
      error instanceof Error && error.message.includes("digest mismatch");
  }
  if (
    !tamperRejected ||
    (await client.getTransactionCount({ address: pkg.intent.deployer })) !==
      nonceBefore
  )
    throw new Error("Tampered package was not rejected before broadcast");
  const paused = await executeLocalDeployment(pkg, directory, {
    stepLimit: 4,
    progress: console.log,
  });
  if (paused.status !== "paused")
    throw new Error("Partial deployment did not pause at its review boundary");
  // Remove one included hash to exercise the broadcast-to-journal crash window.
  const journal = JSON.parse(
    readFileSync(resolve(directory, "journal.json"), "utf8"),
  );
  const original = JSON.parse(JSON.stringify(journal));
  journal.entries[0].hash = journal.entries[1].hash;
  writeDeploymentJson(resolve(directory, "journal.json"), journal);
  let journalMismatchRejected = false;
  try {
    await executeLocalDeployment(pkg, directory);
  } catch (error) {
    journalMismatchRejected =
      error instanceof Error && error.message.includes("outside the reviewed");
  }
  if (!journalMismatchRejected)
    throw new Error("Wrong journal transaction was not rejected");
  journal.entries = original.entries;
  journal.entries = journal.entries.filter(
    (e: { index: number }) => e.index !== 2,
  );
  writeDeploymentJson(resolve(directory, "journal.json"), journal);
  const beforeResume = await client.getTransactionCount({
    address: pkg.intent.deployer,
  });
  await new Promise<void>((resolvePromise, reject) => {
    const cli = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/deployment-package.ts",
        "execute-local",
        "--input",
        resolve(directory, "package.json"),
        "--out",
        directory,
      ],
      { stdio: "inherit" },
    );
    cli.on("error", reject);
    cli.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`Deployment execution CLI exited ${code}`)),
    );
  });
  const manifestPath = resolve(directory, "manifest.json");
  if (!readFileSync(manifestPath, "utf8"))
    throw new Error("Deployment CLI did not write its verified manifest");
  const manifest = parseDeploymentManifest(readFileSync(manifestPath, "utf8"));
  const after = await client.getTransactionCount({
    address: pkg.intent.deployer,
  });
  if (after - beforeResume !== pkg.steps.length - paused.completed)
    throw new Error("Resume duplicated a deployment transaction");
  const completed = JSON.parse(
    readFileSync(resolve(directory, "journal.json"), "utf8"),
  );
  if (
    completed.entries.length !== pkg.steps.length ||
    completed.entries.some((e: { status: string }) => e.status !== "included")
  )
    throw new Error("Deployment journal is incomplete");
  const bootstrap = await prepareMakerBootstrap(client, manifest, 90);
  writeDeploymentJson(resolve(directory, "bootstrap.json"), bootstrap);
  await executeMakerBootstrap(bootstrap, directory, 4);
  await new Promise<void>((resolvePromise, reject) => {
    const cli = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/maker-bootstrap-cli.ts",
        "execute-local",
        "--input",
        resolve(directory, "bootstrap.json"),
        "--out",
        directory,
      ],
      { stdio: "inherit" },
    );
    cli.on("error", reject);
    cli.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`Maker bootstrap CLI exited ${code}`)),
    );
  });
  const chain = defineChain({
    id: 31337,
    name: "Rehearsal",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const usd = artifact("DemoUSDC"),
    router = artifact("StrategyRouter"),
    token = artifact("OptionToken");
  const send = async (
    address: `0x${string}`,
    abi: typeof usd.abi,
    functionName: string,
    args: unknown[],
    account: Address = manifest.demoUser,
  ) => {
    const taker = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });
    const simulation = await client.simulateContract({
      address,
      abi,
      functionName,
      args,
      account,
    });
    const r = await waitReceipt(
      client,
      await taker.writeContract(simulation.request),
    );
    if (r.status !== "success")
      throw new Error("Rehearsal transaction reverted");
  };
  const market = manifest.series.find((s) => s.kind === "call")!;
  const quote = bootstrap.markets.find((m) => m.id === market.id)!;
  const budget = BigInt(quote.askPrices[0]) * 2n;
  await send(manifest.usdc, usd.abi, "faucet", []);
  await send(manifest.usdc, usd.abi, "approve", [manifest.router, budget]);
  const expiryDeadline = (await client.getBlock()).timestamp + 120n;
  await send(manifest.router, router.abi, "execute", [
    [
      {
        seriesId: BigInt(market.id),
        isBuy: true,
        quantity: 10n ** 18n,
        premiumLimit: budget,
      },
    ],
    budget,
    budget,
    0n,
    expiryDeadline,
  ]);
  const received = await client.readContract({
    address: market.token,
    abi: token.abi,
    functionName: "balanceOf",
    args: [manifest.demoUser],
  });
  if (received !== 10n ** 18n)
    throw new Error("Bootstrapped market did not deliver exact claims");
  const writer = (await client.readContract({
    address: manifest.engine,
    abi: artifact("OptionsEngine").abi,
    functionName: "writers",
    args: [BigInt(market.id), manifest.maker],
  })) as [bigint, bigint];
  if (writer[0] !== 90n * 10n ** 18n || writer[1] !== BigInt(quote.collateral))
    throw new Error("Buyer fill changed funded writer backing");
  // Exercise the same custody cleanup used by the local expiry worker.
  // Time moves only on this isolated node; the running terminal is unaffected.
  const test = createTestClient({
    chain,
    mode: "anvil",
    transport: http(rpcUrl),
  });
  await test.setNextBlockTimestamp({ timestamp: BigInt(market.expiry) + 1n });
  await test.mine({ blocks: 1 });
  const oracle = artifact("DemoOracle").abi;
  // Controlled prices are published on the asset's adapter behind the router.
  const adapter = assetFor(manifest, market).adapter;
  await send(
    adapter,
    oracle,
    "publish",
    [manifest.assetId, 130000000n],
    manifest.deployer,
  );
  const firstObservationBlock = await client.getBlock({
    blockNumber: await client.getBlockNumber({ cacheTime: 0 }),
  });
  await test.setNextBlockTimestamp({
    timestamp: firstObservationBlock.timestamp + 1n,
  });
  await test.mine({ blocks: 1 });
  await send(
    adapter,
    oracle,
    "publish",
    [manifest.assetId, 140000000n],
    manifest.deployer,
  );
  await send(
    manifest.oracle,
    oracle,
    "finalize",
    [manifest.assetId, BigInt(market.expiry), []],
    manifest.deployer,
  );
  const reference = await client.readContract({
    address: manifest.oracle,
    abi: oracle,
    functionName: "settlementPrice",
    args: [manifest.assetId, BigInt(market.expiry)],
  });
  if (reference !== 130000000n)
    throw new Error("Expiry did not retain the first post-expiry observation");
  const engine = artifact("OptionsEngine").abi;
  const balance = (account: Address) =>
    client.readContract({
      address: manifest.wmon,
      abi: token.abi,
      functionName: "balanceOf",
      args: [account],
    }) as Promise<bigint>;
  const margin = parseAbi([
    "function getBalance(address,address) view returns(uint256)",
  ]);
  const freeQuote = () =>
    client.readContract({
      address: manifest.kuruMargin!,
      abi: margin,
      functionName: "getBalance",
      args: [manifest.maker, manifest.usdc],
    });
  const [buyerBefore, makerBefore, ownerBefore, quoteBefore] =
    await Promise.all([
      balance(manifest.demoUser),
      balance(manifest.maker),
      balance(manifest.deployer),
      freeQuote(),
    ]);
  const buyerPayout = (await client.readContract({
    address: manifest.engine,
    abi: engine,
    functionName: "previewPayout",
    args: [BigInt(market.id), 10n ** 18n, reference],
  })) as bigint;
  const makerPayout = (await client.readContract({
    address: manifest.engine,
    abi: engine,
    functionName: "previewPayout",
    args: [BigInt(market.id), 89n * 10n ** 18n, reference],
  })) as bigint;
  const terms = (await client.readContract({
    address: manifest.engine,
    abi: engine,
    functionName: "getSeries",
    args: [BigInt(market.id)],
  })) as { strike: bigint };
  const obligation =
    (writer[0] * (reference - terms.strike) + reference - 1n) / reference;
  const returnedBacking = writer[1] - obligation;
  await send(manifest.engine, engine, "redeemLong", [
    BigInt(market.id),
    10n ** 18n,
    manifest.demoUser,
  ]);
  const created = await client.getLogs({
    address: market.market,
    event: parseAbiItem(
      "event OrderCreated(uint40 orderId,address owner,uint96 size,uint32 price,bool isBuy)",
    ),
    fromBlock: BigInt(manifest.deployedBlock),
    toBlock: "latest",
  });
  const ids = created
    .filter((l) => l.args.owner?.toLowerCase() === manifest.maker.toLowerCase())
    .map((l) => BigInt(l.args.orderId!));
  await cleanupExpiredMaker(
    client,
    manifest,
    market,
    ids,
    (address, abi, name, args) =>
      send(address, abi, name, args, manifest.maker),
  );
  // A second cycle reads zero claims/obligations and sends no transactions.
  let repeatedTransactions = 0;
  await cleanupExpiredMaker(client, manifest, market, [], async () => {
    repeatedTransactions++;
  });
  if (repeatedTransactions)
    throw new Error("Completed expiry cleanup repeated transactions");
  const settled = (await client.readContract({
    address: manifest.engine,
    abi: engine,
    functionName: "writers",
    args: [BigInt(market.id), manifest.maker],
  })) as [bigint, bigint];
  const supply = await client.readContract({
    address: market.token,
    abi: token.abi,
    functionName: "totalSupply",
  });
  if (settled[0] !== 0n || settled[1] !== 0n || supply !== 0n)
    throw new Error("Expiry cleanup left claims or writer obligations");
  if (
    (await balance(manifest.demoUser)) !== buyerBefore + buyerPayout ||
    (await balance(manifest.maker)) !==
      makerBefore + makerPayout + returnedBacking
  )
    throw new Error("Expiry payout did not match exact collateral accounting");
  if ((await freeQuote()) < quoteBefore || (await freeQuote()) === 0n)
    throw new Error("Expiry cleanup drained shared quote custody");
  await send(
    manifest.engine,
    engine,
    "sweepDust",
    [BigInt(market.id)],
    manifest.deployer,
  );
  const finalTerms = (await client.readContract({
    address: manifest.engine,
    abi: engine,
    functionName: "getSeries",
    args: [BigInt(market.id)],
  })) as { escrow: bigint };
  const released =
    (await balance(manifest.demoUser)) -
    buyerBefore +
    ((await balance(manifest.maker)) - makerBefore) +
    ((await balance(manifest.deployer)) - ownerBefore);
  if (finalTerms.escrow !== 0n || released !== writer[1])
    throw new Error(
      "Expired collateral did not conserve through payouts, writer return and dust",
    );
  const proof = {
    isolatedLocalFork: true,
    deploymentTransactions: pkg.steps.length,
    series: pkg.manifest.series.length,
    resumedWithoutDuplicateBroadcast: true,
    recoveredMissingJournalHash: true,
    tamperedPackageRejectedBeforeBroadcast: true,
    wrongJournalTransactionRejected: true,
    digest: pkg.digest,
    manifestPath,
    executionCliValidated: true,
    fundedMakerBootstrapTransactions: bootstrap.steps.length,
    actualRouterFillDeliveredClaims: true,
    bootstrapCliValidated: true,
    writerBackingPreservedThroughFill: true,
    expiredHolderAndMakerClaimsRedeemed: true,
    writerObligationCleared: true,
    sharedQuoteCustodyPreserved: true,
    fullCollateralConservation: true,
    repeatedCleanupSentNoTransactions: true,
    canonicalControlledExpiryPrice: reference.toString(),
    genuinePythAdmission: false,
  };
  writeDeploymentJson(resolve(directory, "rehearsal.json"), proof);
  console.log(JSON.stringify(proof, null, 2));
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null)
    await Promise.race([
      once(child, "exit"),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
}
