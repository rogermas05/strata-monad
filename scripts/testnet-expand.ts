import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  parseEther,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { monadTestnet } from "viem/chains";
import { asset, weeklyExpiries } from "../packages/core/src/assets.ts";
import type {
  Manifest,
  SeriesConfig,
  Kind,
} from "../packages/core/src/types.ts";
import {
  parseDeploymentManifest,
  redactDiagnostic,
} from "../packages/core/src/deployment-config.ts";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
import {
  factoryDeploymentAbi,
  implementationSlot,
} from "../packages/core/src/deployment-package.ts";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
import { artifact } from "./artifacts.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
import { configuredSigner } from "./lib/public-signer.ts";
import { reviewedStepAuthorizer } from "./signed-executor.ts";
config({ quiet: true });
config({ path: ".runtime/cloud/supabase.env", quiet: true });
const cloud = await import("../apps/api/src/cloud-store.ts");
const directory = ".runtime/testnet/expansion";
const planPath = `${directory}/plan.json`;
const manifestPath = ".runtime/testnet/manifest.json";
const client = createPublicClient({
  chain: monadTestnet,
  batch: { multicall: { wait: 20, batchSize: 8192 } },
  transport: rateLimitedHttp("https://testnet-rpc.monad.xyz"),
  pollingInterval: 500,
});
type Listing = {
  asset: string;
  kind: Kind;
  strike: number;
  upperStrike: number;
  expiry: number;
};
type Step = {
  index: number;
  nonce: number;
  to: Address | null;
  data: Hex;
  value: string;
  label: string;
  expectedAddress?: Address;
};
type Plan = {
  manifest: Manifest;
  timestamp: number;
  nonce: number;
  listings: Listing[];
  series: SeriesConfig[];
  steps: Step[];
  artifactHashes: Record<string, Hex>;
  factoryImplementation: Hex;
  dependencies: Record<string, Hex>;
  digest: Hex;
};
const fingerprint = (value: unknown) =>
  keccak256(new TextEncoder().encode(JSON.stringify(value)));

async function fund(manifest: Manifest) {
  const allowed = new Set<string>();
  const send = async (
    role: "deployer" | "maker",
    name: string,
    to: Address,
    abi: Abi,
    fn: string,
    args: unknown[],
    value = 0n,
  ) => {
    const data = encodeFunctionData({ abi, functionName: fn, args });
    allowed.add(`${role}:${to.toLowerCase()}:${data}:${value}`);
    const signer = configuredSigner(
      role,
      client,
      monadTestnet,
      manifest.rpcUrl,
      `${directory}/signers`,
      async (intent) => {
        await cloud.assertWorkerLease();
        if (
          !allowed.has(
            `${role}:${intent.to?.toLowerCase()}:${intent.data}:${intent.value ?? 0n}`,
          )
        )
          throw new Error(
            "Funding call is outside the exact expansion allocation",
          );
      },
      { journal: cloud.cloudSignerJournal(10143, manifest[role]) },
    );
    try {
      const hash = await signer.send({
        id: `expansion-v1/funding/${name}`,
        to,
        data,
        value,
      });
      console.log(JSON.stringify({ funding: name, hash }));
      return hash;
    } finally {
      signer.close();
    }
  };
  const token = artifact("DemoUSDC").abi;
  const read = (address: Address, abi: Abi, name: string, args: unknown[]) =>
    client.readContract({ address, abi, functionName: name, args });
  const fundingPath = `${directory}/funding.json`;
  const hashes: Record<string, Hex> = existsSync(fundingPath)
    ? JSON.parse(readFileSync(fundingPath, "utf8")).hashes
    : {};
  const retain = () =>
    writeDeploymentJson(fundingPath, {
      hashes,
      stableTransfer: "15000000000",
      nativeWrap: "4000000000000000000",
    });
  if (!hashes.transfer) {
    const balance = (await read(manifest.usdc, token, "balanceOf", [
      manifest.deployer,
    ])) as bigint;
    if (balance < parseUnits("15000", 6)) {
      const last = (await read(manifest.usdc, token, "lastFaucet", [
        manifest.deployer,
      ])) as bigint;
      if ((await client.getBlock()).timestamp < last + 3600n)
        throw new Error("Deployer test faucet is still in cooldown");
      hashes.faucet = await send(
        "deployer",
        "faucet",
        manifest.usdc,
        token,
        "faucet",
        [],
      );
      retain();
    }
    hashes.transfer = await send(
      "deployer",
      "stable-transfer",
      manifest.usdc,
      token,
      "transfer",
      [manifest.maker, parseUnits("15000", 6)],
    );
    retain();
  }
  if (!hashes.wrap) {
    if (
      (await client.getBalance({ address: manifest.maker })) < parseEther("7")
    )
      throw new Error(
        "Maker must retain three native MON beyond the four-MON call allocation",
      );
    hashes.wrap = await send(
      "maker",
      "wrap",
      manifest.wmon,
      artifact("WrappedMON").abi,
      "deposit",
      [],
      parseEther("4"),
    );
    retain();
  }
}

function listings(manifest: Manifest, timestamp: number): Listing[] {
  const result: Listing[] = [];
  const add = (
    key: string,
    kind: Kind,
    strike: number,
    upperStrike: number,
    expiry: number,
  ) => result.push({ asset: key, kind, strike, upperStrike, expiry });
  const terms = (key: string) => {
    const first = Math.min(
      ...manifest.series
        .filter((s) => s.asset === key && s.expiry > timestamp)
        .map((s) => s.expiry),
    );
    const next = weeklyExpiries(asset(key), timestamp, 3).find(
      (time) => time > first,
    );
    if (!Number.isFinite(first) || !next)
      throw new Error("Active weekly shelf required for expansion");
    return [first, next];
  };
  const [mon, nextMon] = terms("MON");
  for (const kind of ["call", "put"] as const) add("MON", kind, 0.024, 0, mon);
  for (const strike of [0.022, 0.024, 0.026])
    for (const kind of ["call", "put"] as const)
      add("MON", kind, strike, 0, nextMon);
  const [btc, nextBtc] = terms("BTC");
  add("BTC", "bear-spread", 83000, 83500, btc);
  add("BTC", "bull-spread", 83500, 84000, nextBtc);
  add("BTC", "bear-spread", 83000, 83500, nextBtc);
  const [eth, nextEth] = terms("ETH");
  add("ETH", "bear-spread", 2500, 2600, eth);
  add("ETH", "bull-spread", 2500, 2600, nextEth);
  add("ETH", "bear-spread", 2500, 2600, nextEth);
  const [gold, nextGold] = terms("XAU");
  add("XAU", "bear-spread", 4150, 4200, gold);
  add("XAU", "bull-spread", 4150, 4200, nextGold);
  return result;
}
async function build(manifest: Manifest, desired: Listing[], nonce: number) {
  const series: SeriesConfig[] = [],
    steps: Step[] = [];
  const call = (to: Address, abi: Abi, fn: string, args: unknown[]) =>
    steps.push({
      index: steps.length,
      nonce: nonce + steps.length,
      to,
      data: encodeFunctionData({ abi, functionName: fn, args }),
      value: "0",
      label: fn,
    });
  for (const listing of desired) {
    const id =
      Math.max(...manifest.series.map((s) => s.id)) + 1 + series.length;
    const binding = manifest.assets?.find((a) => a.key === listing.asset);
    if (!binding || !asset(listing.asset).kinds.includes(listing.kind))
      throw new Error("Listing asset/kind is not admitted on this deployment");
    if (
      manifest.series.some(
        (s) =>
          s.asset === listing.asset &&
          s.kind === listing.kind &&
          s.strike === listing.strike &&
          s.upperStrike === listing.upperStrike &&
          s.expiry === listing.expiry,
      )
    )
      throw new Error("Listing duplicates an existing contract");
    const symbol = `${listing.asset}-${new Date(listing.expiry * 1000).toISOString().slice(5, 10).replace("-", "")}-${listing.strike}${listing.upperStrike ? `/${listing.upperStrike}` : ""}-${listing.kind === "call" ? "C" : listing.kind === "put" ? "P" : listing.kind === "bull-spread" ? "BULL" : "BEAR"}`;
    const token = getContractAddress({
      from: manifest.engine,
      nonce: BigInt(id),
    });
    const bookArgs = [
      token,
      manifest.usdc,
      1000n,
      1000000,
      1,
      1n,
      1000000000n,
      0n,
      0n,
      100n,
    ] as const;
    const market = await client.readContract({
      address: manifest.kuruFactory!,
      abi: factoryDeploymentAbi,
      functionName: "computeAddress",
      args: [...bookArgs, zeroAddress, false],
    });
    const venue = getContractAddress({
      from: manifest.deployer,
      nonce: BigInt(nonce + steps.length + 2),
    });
    call(manifest.engine, artifact("OptionsEngine").abi, "createSeries", [
      binding.deliverable ? manifest.wmon : zeroAddress,
      binding.assetId,
      BigInt(listing.expiry),
      ["call", "put", "bull-spread", "bear-spread"].indexOf(listing.kind),
      parseUnits(String(listing.strike), 8),
      parseUnits(String(listing.upperStrike), 8),
      listing.kind === "call" ? parseEther("1000") : parseUnits("100000", 6),
      symbol,
    ]);
    call(manifest.kuruFactory!, factoryDeploymentAbi, "deployProxy", [
      0,
      ...bookArgs,
    ]);
    steps.push({
      index: steps.length,
      nonce: nonce + steps.length,
      to: null,
      data: encodeDeployData({
        ...artifact("KuruExactAdapter"),
        args: [market, manifest.kuruMargin!, BigInt(listing.expiry)],
      }),
      value: "0",
      label: "Deploy KuruExactAdapter",
      expectedAddress: venue,
    });
    call(manifest.router, artifact("StrategyRouter").abi, "register", [
      BigInt(id),
      venue,
    ]);
    series.push({ id, token, market, venue, symbol, ...listing });
  }
  return { series, steps };
}
async function main() {
  const mode = process.argv[2];
  if (!["fund", "prepare", "execute"].includes(mode))
    throw new Error("Use testnet-expand fund|prepare|execute");
  if ((await client.getChainId()) !== 10143)
    throw new Error("Expansion requires Monad testnet");
  if (!(await cloud.claimWorker(randomUUID())))
    throw new Error(
      "Worker lease is busy; pause cron and wait before running the operator",
    );
  try {
    const current = parseDeploymentManifest(readFileSync(manifestPath, "utf8"));
    if (mode === "fund") return await fund(current);
    if (mode === "prepare") {
      if (existsSync(planPath))
        throw new Error(
          "Expansion plan already exists; execute or resume the existing plan",
        );
      if (
        (await client.getBalance({ address: current.deployer })) <
        parseEther("9")
      )
        throw new Error(
          "Expansion needs nine deployer MON including keeper reserve",
        );
      await checkDeployment(client, client, current);
      const timestamp = Number((await client.getBlock()).timestamp),
        nonce = await client.getTransactionCount({
          address: current.deployer,
          blockTag: "pending",
        });
      const desired = listings(current, timestamp);
      const original = JSON.parse(
        readFileSync(".runtime/testnet/package.json", "utf8"),
      );
      const value = {
        manifest: current,
        timestamp,
        nonce,
        listings: desired,
        ...(await build(current, desired, nonce)),
        artifactHashes: Object.fromEntries(
          ["OptionsEngine", "StrategyRouter", "KuruExactAdapter"].map(
            (name) => [name, keccak256(artifact(name).bytecode)],
          ),
        ),
        factoryImplementation: original.dependencies.factoryImplementation,
        dependencies: original.dependencies.codeHashes,
      };
      writeDeploymentJson(planPath, { ...value, digest: fingerprint(value) });
      console.log(
        JSON.stringify({
          prepared: true,
          listings: desired.length,
          transactions: value.steps.length,
          initialNonce: nonce,
          series: value.series.map((s) => s.symbol),
        }),
      );
      return;
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
    const { digest, ...value } = plan;
    if (
      fingerprint(value) !== digest ||
      fingerprint(listings(plan.manifest, plan.timestamp)) !==
        fingerprint(plan.listings)
    )
      throw new Error("Expansion plan changed");
    for (const [name, hash] of Object.entries(plan.artifactHashes))
      if (keccak256(artifact(name).bytecode) !== hash)
        throw new Error("Compiled expansion artifact changed");
    const reconstructed = await build(plan.manifest, plan.listings, plan.nonce);
    if (
      fingerprint(reconstructed.steps) !== fingerprint(plan.steps) ||
      fingerprint(reconstructed.series) !== fingerprint(plan.series)
    )
      throw new Error("Reviewed expansion bytes or addresses changed");
    for (const [address, hash] of Object.entries(plan.dependencies))
      if (
        keccak256((await client.getCode({ address: address as Address }))!) !==
        hash
      )
        throw new Error("Admitted dependency code changed");
    if (
      (await client.getStorageAt({
        address: plan.manifest.kuruFactory!,
        slot: implementationSlot,
      })) !== plan.factoryImplementation
    )
      throw new Error("Admitted factory implementation changed");
    const exact = reviewedStepAuthorizer(plan.steps);
    const signer = configuredSigner(
      "deployer",
      client,
      monadTestnet,
      plan.manifest.rpcUrl,
      `${directory}/signers`,
      async (intent) => {
        await cloud.assertWorkerLease();
        await exact(intent);
      },
      { journal: cloud.cloudSignerJournal(10143, plan.manifest.deployer) },
    );
    try {
      const receipts: { index: number; hash: Hex }[] = [];
      for (const step of plan.steps) {
        const hash = await signer.send({
          id: `expansion-v1/${plan.manifest.engine}/${step.index}`,
          nonce: step.nonce,
          to: step.to ?? undefined,
          data: step.data,
          value: 0n,
        });
        receipts.push({ index: step.index, hash });
        writeDeploymentJson(`${directory}/receipts.json`, receipts);
        console.log(
          JSON.stringify({
            step: step.index + 1,
            total: plan.steps.length,
            operation: step.label,
            hash,
          }),
        );
      }
      const manifest = parseDeploymentManifest(
        JSON.stringify({
          ...plan.manifest,
          series: [...plan.manifest.series, ...plan.series],
        }),
      );
      const report = await checkDeployment(client, client, manifest);
      await cloud.assertWorkerLease();
      writeDeploymentJson(manifestPath, manifest);
      writeDeploymentJson(".runtime/testnet/verification.json", report);
      await cloud.saveCloudState("public-manifest", manifest);
      console.log(
        JSON.stringify({
          expanded: true,
          retainedSeries: manifest.series.length,
          newSeries: plan.series.length,
          verified: true,
          published: true,
        }),
      );
    } finally {
      signer.close();
    }
  } finally {
    await cloud.releaseWorker();
  }
}
main().catch((error) => {
  console.error(
    redactDiagnostic(
      error,
      Object.entries(process.env)
        .filter(([name]) => /KEY|TOKEN|PASSWORD|SECRET/.test(name))
        .map(([, value]) => value ?? ""),
    ).split("\n")[0],
  );
  process.exitCode = 1;
});
