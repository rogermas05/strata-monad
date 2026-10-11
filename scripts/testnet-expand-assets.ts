import { config } from "dotenv";
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
import {
  fetchEvidence,
  fetchUpdate,
  type Evidence,
} from "../packages/core/src/hermes.ts";
import {
  pythAbi,
  validateVerifiedEvidence,
} from "../packages/core/src/pyth.ts";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
import type { Manifest, ManifestAsset } from "../packages/core/src/types.ts";
import { artifact } from "./artifacts.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
import {
  buildListings,
  type ExpansionListing,
  type ExpansionStep,
} from "./lib/expand-listings.ts";
import { configuredSigner } from "./lib/public-signer.ts";
import { reviewedStepAuthorizer } from "./signed-executor.ts";

config({ quiet: true });
config({ path: ".runtime/cloud/supabase.env", quiet: true });
const cloud = await import("../apps/api/src/cloud-store.ts");
const directory = ".runtime/testnet/asset-expansion";
const manifestPath = ".runtime/testnet/manifest.json";
const planPath = `${directory}/plan.json`;
const verifier = "0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379" as Address;
const client = createPublicClient({
  chain: monadTestnet,
  batch: { multicall: { wait: 20, batchSize: 8192 } },
  transport: rateLimitedHttp("https://testnet-rpc.monad.xyz"),
  pollingInterval: 500,
});
const fingerprint = (value: unknown) =>
  keccak256(new TextEncoder().encode(JSON.stringify(value)));
const proposals = [
  "SOL",
  "XRP",
  "DOGE",
  "BNB",
  "HYPE",
  "QQQ",
  "TSLA",
  "XAG",
  "EUR",
  "AVAX",
  "ADA",
  "LINK",
  "DOT",
  "LTC",
  "SUI",
  "NEAR",
];
const parameters: Record<string, { step: number; volatility: number }> = {
  SOL: { step: 5, volatility: 0.85 },
  XRP: { step: 0.05, volatility: 0.85 },
  DOGE: { step: 0.005, volatility: 1 },
  BNB: { step: 25, volatility: 0.65 },
  HYPE: { step: 1, volatility: 1 },
  QQQ: { step: 10, volatility: 0.25 },
  TSLA: { step: 10, volatility: 0.65 },
  XAG: { step: 1, volatility: 0.3 },
  EUR: { step: 0.01, volatility: 0.1 },
  AVAX: { step: 1, volatility: 0.85 },
  ADA: { step: 0.025, volatility: 0.85 },
  LINK: { step: 0.5, volatility: 0.85 },
  DOT: { step: 0.1, volatility: 0.85 },
  LTC: { step: 5, volatility: 0.75 },
  SUI: { step: 0.1, volatility: 1 },
  NEAR: { step: 0.1, volatility: 1 },
};
type Admission = {
  key: string;
  evidence: Evidence;
  archive: string;
  spot: number;
};
async function admissions(keys: string[]) {
  const approved: Admission[] = [],
    rejected: { key: string; reason: string }[] = [];
  const access = {
    endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
    apiKey: process.env.PYTH_API_KEY ?? "",
  };
  for (const key of keys) {
    try {
      const spec = asset(key),
        block = await client.getBlock();
      const expiry = Number(block.timestamp) - 60;
      const evidence = await fetchEvidence({
        ...access,
        feed: spec.pythFeedId,
        expiry,
      });
      const fee = await client.readContract({
        address: verifier,
        abi: pythAbi,
        functionName: "getUpdateFee",
        args: [evidence.updates],
        blockNumber: block.number,
      });
      const { result } = await client.simulateContract({
        account: process.env.STRATA_DEPLOYER_ADDRESS as Address,
        address: verifier,
        abi: pythAbi,
        functionName: "parsePriceFeedUpdatesUnique",
        args: [
          evidence.updates,
          [spec.pythFeedId],
          BigInt(expiry),
          block.timestamp,
        ],
        value: fee,
        blockNumber: block.number,
      });
      const observation = validateVerifiedEvidence(
        evidence,
        result,
        expiry,
        block.timestamp,
      );
      const live = await fetchUpdate(access, spec.pythFeedId);
      if (!live || BigInt(live.confidence) * 10000n > BigInt(live.price) * 100n)
        throw new Error("Live evidence unavailable or confidence exceeds 1%");
      // Opening a session must produce a price inside the immutable 60-second window.
      if (
        spec.assetClass === "crypto" &&
        (live.publishTime > Number(block.timestamp) + 5 ||
          Number(block.timestamp) - live.publishTime > 60)
      )
        throw new Error("Live crypto evidence stale");
      const liveFee = await client.readContract({
        address: verifier,
        abi: pythAbi,
        functionName: "getUpdateFee",
        args: [live.updates],
      });
      const liveBlock = await client.getBlock();
      const liveVerified = await client.simulateContract({
        account: process.env.STRATA_DEPLOYER_ADDRESS as Address,
        address: verifier,
        abi: pythAbi,
        functionName: "parsePriceFeedUpdates",
        args: [
          live.updates,
          [spec.pythFeedId],
          BigInt(live.publishTime),
          BigInt(live.publishTime),
        ],
        value: liveFee,
        blockNumber: liveBlock.number,
      });
      validateVerifiedEvidence(
        live,
        liveVerified.result,
        live.publishTime,
        liveBlock.timestamp,
      );
      if (
        (await client.getBlock({ blockNumber: block.number })).hash !==
        block.hash
      )
        throw new Error("Admission block reorganized");
      const archive = `${directory}/admissions/${key}-${block.number}.json`;
      writeDeploymentJson(archive, {
        chainId: 10143,
        verifier,
        block: {
          number: String(block.number),
          hash: block.hash,
          timestamp: String(block.timestamp),
        },
        expiry,
        evidence,
        observation,
        live,
      });
      approved.push({
        key,
        evidence,
        archive,
        spot: Number(observation.normalizedPrice) / 1e8,
      });
    } catch (error) {
      rejected.push({ key, reason: redactDiagnostic(error).split("\n")[0] });
    }
  }
  return { approved, rejected };
}
function bindings(manifest: Manifest, rows: Admission[]): ManifestAsset[] {
  const crypto = manifest.assets!.find((a) => a.key === "BTC")!;
  const session = manifest.assets!.find((a) => a.key === "XAU")!;
  return rows.map(({ key, spot }) => {
    const spec = asset(key),
      scheduled = spec.settlement === "pyth-latest-before-close";
    return {
      key,
      name: spec.name,
      assetClass: spec.assetClass,
      assetId: spec.pythFeedId,
      adapter: scheduled ? session.adapter : crypto.adapter,
      policy: spec.settlement,
      maxLiveAge: spec.maxLiveAge,
      challengeWindow: scheduled ? session.challengeWindow : 0,
      schedule: spec.schedule,
      scheduleSnapshot: spec.scheduleSnapshot,
      volatility: parameters[key].volatility,
      reference: spot,
      deliverable: false,
    };
  });
}
function listings(rows: Admission[], timestamp: number): ExpansionListing[] {
  return rows.flatMap(({ key, spot }) => {
    const step = parameters[key].step,
      strike = Number((Math.floor(spot / step) * step).toFixed(8));
    const upperStrike = Number((strike + step).toFixed(8));
    const expiry = weeklyExpiries(asset(key), timestamp, 2).find(
      (time) => time > timestamp + 3600,
    )!;
    return (["bull-spread", "bear-spread"] as const).map((kind) => {
      validateListing(
        { asset: key, strike, upperStrike, expiry, kind },
        timestamp,
        { allowCandidates: true },
      );
      return { asset: key, strike, upperStrike, expiry, kind };
    });
  });
}
async function build(
  manifest: Manifest,
  additions: ManifestAsset[],
  desired: ExpansionListing[],
  nonce: number,
) {
  const binds: ExpansionStep[] = additions.map((a, index) => ({
    index,
    nonce: nonce + index,
    to: manifest.oracle,
    data: encodeFunctionData({
      abi: artifact("OracleRouter").abi,
      functionName: "bind",
      args: [a.assetId, a.adapter, BigInt(a.maxLiveAge)],
    }),
    value: "0",
    label: `Bind ${a.key}`,
  }));
  const expanded = { ...manifest, assets: [...manifest.assets!, ...additions] };
  const created = await buildListings(
    client,
    expanded,
    desired,
    nonce + binds.length,
  );
  return {
    series: created.series,
    steps: [
      ...binds,
      ...created.steps.map((step) => ({
        ...step,
        index: step.index + binds.length,
      })),
    ],
  };
}
type Plan = {
  manifest: Manifest;
  additions: ManifestAsset[];
  listings: ExpansionListing[];
  approved: Admission[];
  rejected: { key: string; reason: string }[];
  timestamp: number;
  nonce: number;
  series: Manifest["series"];
  steps: ExpansionStep[];
  artifactHashes: Record<string, Hex>;
  dependencies: Record<string, Hex>;
  factoryImplementation: Hex;
  digest: Hex;
};
async function main() {
  const mode = process.argv[2];
  if (!["proposal", "prepare", "execute"].includes(mode))
    throw new Error("Use testnet-expand-assets proposal|prepare|execute");
  if ((await client.getChainId()) !== 10143)
    throw new Error("Wrong deployment chain");
  if (mode !== "proposal" && !(await cloud.claimWorker(randomUUID())))
    throw new Error(
      "Pause cron and wait for the signing lease before preparation/execution",
    );
  try {
    const current = parseDeploymentManifest(readFileSync(manifestPath, "utf8"));
    if (mode !== "execute") {
      if (mode === "prepare" && existsSync(planPath))
        throw new Error(
          "An immutable asset expansion plan already exists; execute/resume it",
        );
      const known = new Set(current.assets!.map((a) => a.key));
      const result = await admissions(
        proposals.filter((key) => !known.has(key)),
      );
      if (!result.approved.length)
        throw new Error("No additional authenticated assets admitted");
      const additions = bindings(current, result.approved),
        timestamp = Number((await client.getBlock()).timestamp);
      const desired = listings(result.approved, timestamp),
        nonce = await client.getTransactionCount({
          address: current.deployer,
          blockTag: "pending",
        });
      const original = JSON.parse(
        readFileSync(".runtime/testnet/package.json", "utf8"),
      );
      const value = {
        manifest: current,
        additions,
        listings: desired,
        ...result,
        timestamp,
        nonce,
        ...(await build(current, additions, desired, nonce)),
        artifactHashes: Object.fromEntries(
          [
            "OptionsEngine",
            "StrategyRouter",
            "KuruExactAdapter",
            "OracleRouter",
          ].map((name) => [name, keccak256(artifact(name).bytecode)]),
        ),
        dependencies: original.dependencies.codeHashes,
        factoryImplementation: original.dependencies.factoryImplementation,
      };
      // Actual prior public deployment cost was ~0.47 MON per series; include keeper reserve.
      const required = parseEther(String(desired.length * 0.5 + 2));
      if (mode === "prepare") {
        if (
          (await client.getBalance({ address: current.deployer })) < required ||
          (await client.getBalance({ address: current.maker })) <
            parseEther("4")
        )
          throw new Error(
            "Native deployment/maker reserve insufficient; proposal is unsigned until funded",
          );
        await checkDeployment(client, client, current);
      }
      writeDeploymentJson(
        mode === "prepare" ? planPath : `${directory}/proposal.json`,
        { ...value, digest: fingerprint(value) },
      );
      const profile = JSON.parse(
        readFileSync(".runtime/testnet/expansion/maker-config.json", "utf8"),
      );
      for (const key of additions.map((a) => a.key))
        for (const kind of ["bull-spread", "bear-spread"])
          profile.inventoryTargets[`${key}:${kind}`] = {
            targetInventory: 5,
            maxWritten: 10,
          };
      // Initial 18 books add <=90 fully collateralized claims; existing shared limits stay in force.
      writeDeploymentJson(`${directory}/maker-config.json`, profile);
      console.log(
        JSON.stringify({
          unsigned: true,
          provisionalNonces: mode === "proposal",
          assets: additions.map((a) => a.key),
          totalAssets: current.assets!.length + additions.length,
          newContracts: desired.length,
          transactions: value.steps.length,
          blockedAssets: result.rejected.map((a) => a.key),
          requiredDeployerReserveMON: String(Number(required) / 1e18),
        }),
      );
      return;
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
    const { digest, ...value } = plan;
    if (
      fingerprint(value) !== digest ||
      fingerprint(listings(plan.approved, plan.timestamp)) !==
        fingerprint(plan.listings) ||
      fingerprint(bindings(plan.manifest, plan.approved)) !==
        fingerprint(plan.additions)
    )
      throw new Error("Reviewed asset expansion changed");
    for (const [name, hash] of Object.entries(plan.artifactHashes))
      if (keccak256(artifact(name).bytecode) !== hash)
        throw new Error("Reviewed artifact changed");
    const rebuilt = await build(
      plan.manifest,
      plan.additions,
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
        assets: [...plan.manifest.assets!, ...plan.additions],
        series: [...plan.manifest.series, ...plan.series],
      }),
    );
    if (
      ![fingerprint(plan.manifest), fingerprint(expanded)].includes(
        fingerprint(current),
      )
    )
      throw new Error("Deployment manifest changed outside this package");
    // Re-authenticate every retained payload before signing; expiry samples remain historical proofs.
    for (const admission of plan.approved) {
      const evidence = admission.evidence,
        block = await client.getBlock();
      const fee = await client.readContract({
        address: verifier,
        abi: pythAbi,
        functionName: "getUpdateFee",
        args: [evidence.updates],
      });
      const { result } = await client.simulateContract({
        account: current.deployer,
        address: verifier,
        abi: pythAbi,
        functionName: "parsePriceFeedUpdates",
        args: [
          evidence.updates,
          [evidence.feed],
          BigInt(evidence.publishTime),
          BigInt(evidence.publishTime),
        ],
        value: fee,
        blockNumber: block.number,
      });
      validateVerifiedEvidence(
        evidence,
        result,
        evidence.publishTime,
        block.timestamp,
      );
    }
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
          id: `asset-expansion-v1/${current.engine}/${step.index}`,
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
      const report = await checkDeployment(client, client, expanded);
      await cloud.assertWorkerLease();
      writeDeploymentJson(manifestPath, expanded);
      writeDeploymentJson(".runtime/testnet/verification.json", report);
      await cloud.saveCloudState("public-manifest", expanded);
      console.log(
        JSON.stringify({
          published: true,
          totalAssets: expanded.assets!.length,
          retainedContracts: expanded.series.length,
          newContracts: plan.series.length,
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
        .filter(([name]) => /KEY|TOKEN|PASSWORD|SECRET/.test(name))
        .map(([, value]) => value ?? ""),
    ).split("\n")[0],
  );
  process.exitCode = 1;
});
