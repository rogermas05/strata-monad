import { loadCloudEnvironment } from "./lib/cloud-env.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  encodeFunctionData,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { monadTestnet } from "viem/chains";
import {
  asset,
  validateListing,
  weeklyExpiries,
} from "../packages/core/src/assets.ts";
import {
  parseDeploymentManifest,
  redactDiagnostic,
} from "../packages/core/src/deployment-config.ts";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
import { implementationSlot } from "../packages/core/src/deployment-package.ts";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
import type { Manifest, Snapshot } from "../packages/core/src/types.ts";
import { artifact } from "./artifacts.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
import {
  buildListings,
  type ExpansionListing,
  type ExpansionStep,
} from "./lib/expand-listings.ts";
import { configuredSigner } from "./lib/public-signer.ts";
import { reviewedStepAuthorizer } from "./signed-executor.ts";

loadCloudEnvironment();
const cloud = await import("../apps/api/src/cloud-store.ts");
const directory = ".runtime/testnet/judging-window";
const manifestPath = ".runtime/testnet/manifest.json";
const planPath = `${directory}/plan.json`;
const client = createPublicClient({
  chain: monadTestnet,
  batch: { multicall: { wait: 20, batchSize: 8192 } },
  transport: rateLimitedHttp("https://testnet-rpc.monad.xyz"),
  pollingInterval: 500,
});
const fingerprint = (value: unknown) =>
  keccak256(new TextEncoder().encode(JSON.stringify(value)));
const strikeSteps: Record<string, number> = {
  MON: 0.002,
  BTC: 500,
  ETH: 100,
  XAU: 50,
  SOL: 5,
  XRP: 0.05,
  DOGE: 0.005,
  BNB: 25,
  HYPE: 1,
  QQQ: 10,
  TSLA: 10,
  XAG: 1,
  EUR: 0.01,
};
type Plan = {
  manifest: Manifest;
  timestamp: number;
  until: number;
  nonce: number;
  listings: ExpansionListing[];
  series: Manifest["series"];
  steps: ExpansionStep[];
  artifactHashes: Record<string, Hex>;
  dependencies: Record<string, Hex>;
  factoryImplementation: Hex;
  digest: Hex;
};

async function proposal(current: Manifest, timestamp: number, until: number) {
  const response = await fetch("https://strata-xyz.vercel.app/api/snapshot", {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Public snapshot is unavailable");
  const snapshot = (await response.json()) as Snapshot;
  const publicManifest = parseDeploymentManifest(
    JSON.stringify(snapshot.manifest),
  );
  if (fingerprint(publicManifest) !== fingerprint(current))
    throw new Error(
      "Local and public manifests differ; reconcile before renewing",
    );
  const listings: ExpansionListing[] = [];
  for (const binding of current.assets ?? []) {
    const key = binding.key,
      step = strikeSteps[key];
    const spot = snapshot.underlyings[key]?.spot;
    if (!step || !spot || !Number.isFinite(spot))
      throw new Error(`Missing ${key} price/strike parameters`);
    const strike = Number((Math.floor(spot / step) * step).toFixed(8));
    const upperStrike = Number((strike + step).toFixed(8));
    const expiry = weeklyExpiries(asset(key), timestamp, 4).find(
      (time) => time > until,
    );
    if (!expiry) throw new Error(`No ${key} expiry beyond the judging window`);
    const kinds =
      key === "MON"
        ? (["call", "put", "bull-spread", "bear-spread"] as const)
        : (["bull-spread", "bear-spread"] as const);
    for (const kind of kinds) {
      if (
        current.series.some(
          (s) => s.asset === key && s.kind === kind && s.expiry > until,
        )
      )
        continue;
      const listing = {
        asset: key,
        kind,
        strike,
        upperStrike: kind === "call" || kind === "put" ? 0 : upperStrike,
        expiry,
      };
      validateListing(
        { ...listing, upperStrike: listing.upperStrike || undefined },
        timestamp,
        { allowCandidates: true },
      );
      listings.push(listing);
    }
  }
  return listings;
}

async function wrapForCalls(manifest: Manifest) {
  const balance = (await client.readContract({
    address: manifest.wmon,
    abi: artifact("WrappedMON").abi,
    functionName: "balanceOf",
    args: [manifest.maker],
  })) as bigint;
  const amount = parseEther("1") - balance;
  if (amount <= 0n) return;
  if (
    (await client.getBalance({ address: manifest.maker })) <
    amount + parseEther("2")
  )
    throw new Error(
      "Maker needs one MON of call backing plus native gas reserve",
    );
  const data = encodeFunctionData({
    abi: artifact("WrappedMON").abi,
    functionName: "deposit",
    args: [],
  });
  const signer = configuredSigner(
    "maker",
    client,
    monadTestnet,
    manifest.rpcUrl,
    `${directory}/signers`,
    async (intent) => {
      await cloud.assertWorkerLease();
      if (
        intent.to?.toLowerCase() !== manifest.wmon.toLowerCase() ||
        intent.data !== data ||
        intent.value !== amount
      )
        throw new Error("Wrapping is outside the exact call allocation");
    },
    { journal: cloud.cloudSignerJournal(10143, manifest.maker) },
  );
  try {
    const hash = await signer.send({
      id: `judging-window-v1/wrap/${fingerprint({ balance: String(balance), amount: String(amount) })}`,
      to: manifest.wmon,
      data,
      value: amount,
    });
    writeDeploymentJson(`${directory}/wrapping.json`, {
      hash,
      amount: String(amount),
    });
    console.log(JSON.stringify({ wrappedMON: Number(amount) / 1e18, hash }));
  } finally {
    signer.close();
  }
}

async function main() {
  const mode = process.argv[2];
  if (!["proposal", "prepare", "execute", "fund", "deploy"].includes(mode))
    throw new Error("Use proposal|prepare|execute|fund|deploy");
  if ((await client.getChainId()) !== 10143)
    throw new Error("Renewal requires Monad testnet");
  if (mode !== "proposal" && !(await cloud.claimWorker(randomUUID())))
    throw new Error("Pause cron and wait for the worker signing lease");
  try {
    const current = parseDeploymentManifest(readFileSync(manifestPath, "utf8"));
    if (mode === "fund") return await wrapForCalls(current);
    if (mode !== "execute" && !(mode === "deploy" && existsSync(planPath))) {
      if (mode === "prepare" && existsSync(planPath))
        throw new Error(
          "An immutable renewal plan already exists; execute/resume it",
        );
      const timestamp = Number((await client.getBlock()).timestamp);
      const until = timestamp + 14 * 86400;
      const listings = await proposal(current, timestamp, until);
      if (!listings.length)
        throw new Error(
          "Every asset/kind already has a shelf beyond the judging window",
        );
      const nonce = await client.getTransactionCount({
        address: current.deployer,
        blockTag: "pending",
      });
      const original = JSON.parse(
        readFileSync(".runtime/testnet/package.json", "utf8"),
      );
      const body = {
        manifest: current,
        timestamp,
        until,
        nonce,
        listings,
        ...(await buildListings(client, current, listings, nonce)),
        artifactHashes: Object.fromEntries(
          ["OptionsEngine", "StrategyRouter", "KuruExactAdapter"].map(
            (name) => [name, keccak256(artifact(name).bytecode)],
          ),
        ),
        dependencies: original.dependencies.codeHashes,
        factoryImplementation: original.dependencies.factoryImplementation,
      };
      const reserve = parseEther(String(listings.length * 0.5 + 2));
      if (mode === "prepare" || mode === "deploy") {
        if (
          (await client.getBalance({ address: current.deployer })) < reserve ||
          (await client.getBalance({ address: current.maker })) <
            parseEther("4")
        )
          throw new Error(
            "Insufficient native deployment/maker reserves; proposal can be prepared without funding",
          );
        await checkDeployment(client, client, current);
      }
      writeDeploymentJson(
        mode === "proposal" ? `${directory}/proposal.json` : planPath,
        { ...body, digest: fingerprint(body) },
      );
      console.log(
        JSON.stringify({
          unsigned: true,
          provisionalNonces: mode === "proposal",
          newContracts: listings.length,
          transactions: body.steps.length,
          judgingUntil: new Date(until * 1000).toISOString(),
          requiredKeeperMON: Number(reserve) / 1e18,
          requiredMakerMON: 4,
          listings,
        }),
      );
      if (mode !== "deploy") return;
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
    const { digest, ...body } = plan;
    if (fingerprint(body) !== digest)
      throw new Error("Reviewed renewal plan changed");
    for (const listing of plan.listings) {
      validateListing(
        { ...listing, upperStrike: listing.upperStrike || undefined },
        plan.timestamp,
        { allowCandidates: true },
      );
      if (listing.expiry <= plan.until)
        throw new Error("Listing does not cover the judging window");
    }
    for (const [name, hash] of Object.entries(plan.artifactHashes))
      if (keccak256(artifact(name).bytecode) !== hash)
        throw new Error("Reviewed artifact changed");
    const rebuilt = await buildListings(
      client,
      plan.manifest,
      plan.listings,
      plan.nonce,
    );
    if (
      fingerprint(rebuilt.steps) !== fingerprint(plan.steps) ||
      fingerprint(rebuilt.series) !== fingerprint(plan.series)
    )
      throw new Error("Reviewed bytes or addresses changed");
    for (const [address, hash] of Object.entries(plan.dependencies))
      if (
        keccak256((await client.getCode({ address: address as Address }))!) !==
        hash
      )
        throw new Error("Admitted dependency changed");
    if (
      (await client.getStorageAt({
        address: current.kuruFactory!,
        slot: implementationSlot,
      })) !== plan.factoryImplementation
    )
      throw new Error("Factory implementation changed");
    const expanded = parseDeploymentManifest(
      JSON.stringify({
        ...plan.manifest,
        series: [...plan.manifest.series, ...plan.series],
      }),
    );
    if (
      ![fingerprint(plan.manifest), fingerprint(expanded)].includes(
        fingerprint(current),
      )
    )
      throw new Error("Manifest changed outside this package");
    const exact = reviewedStepAuthorizer(plan.steps);
    const signer = configuredSigner(
      "deployer",
      client,
      monadTestnet,
      current.rpcUrl,
      `${directory}/signers`,
      async (intent) => {
        await cloud.assertWorkerLease();
        await exact(intent);
      },
      { journal: cloud.cloudSignerJournal(10143, current.deployer) },
    );
    try {
      const receipts: { index: number; hash: Hex }[] = [];
      for (const step of plan.steps) {
        const hash = await signer.send({
          id: `judging-window-v1/${current.engine}/${step.index}`,
          nonce: step.nonce,
          to: step.to ?? undefined,
          data: step.data,
          value: BigInt(step.value),
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
      const report = await checkDeployment(client, client, expanded);
      await cloud.assertWorkerLease();
      writeDeploymentJson(manifestPath, expanded);
      writeDeploymentJson(`${directory}/verification.json`, report);
      await cloud.saveCloudState("public-manifest", expanded);
      console.log(
        JSON.stringify({
          published: true,
          retainedSeries: expanded.series.length,
          newSeries: plan.series.length,
        }),
      );
    } finally {
      signer.close();
    }
  } finally {
    if (mode !== "proposal") await cloud.releaseWorker();
  }
}
main().catch((error) => {
  console.error(
    redactDiagnostic(
      error,
      Object.entries(process.env)
        .filter(([key]) => /KEY|TOKEN|PASSWORD|SECRET/.test(key))
        .map(([, value]) => value ?? ""),
    ).split("\n")[0],
  );
  process.exitCode = 1;
});
