import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  type Address,
  type Hex,
} from "viem";
import { monadTestnet } from "viem/chains";
import {
  parseDeploymentManifest,
  redactDiagnostic,
} from "../packages/core/src/deployment-config.ts";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
import type { Manifest } from "../packages/core/src/types.ts";
import { artifact } from "./artifacts.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
import { configuredSigner } from "./lib/public-signer.ts";
import { reviewedStepAuthorizer } from "./signed-executor.ts";

/**
 * Deploys the house vault, STRATA, staking and distributor to Monad testnet
 * with the deployer role, then publishes the manifest to the hosted service.
 *
 *   npx tsx scripts/testnet-house.ts plan      # exact unsigned steps, no signing
 *   npx tsx scripts/testnet-house.ts execute   # sign, verify, publish (resumable)
 *
 * Execute holds the distributed worker lease, so hosted workers cannot sign
 * concurrently. The plan pins nonces; re-plan if the deployer sends anything else.
 */
config({ quiet: true });
config({ path: ".runtime/cloud/supabase.env", quiet: true });
const cloud = await import("../apps/api/src/cloud-store.ts");
const directory = ".runtime/testnet/house";
const planPath = `${directory}/plan.json`;
const manifestPath = ".runtime/testnet/manifest.json";
const GENESIS_SECONDS = Number(process.env.HOUSE_LAUNCH_IN ?? 86400);
const COOLDOWN = BigInt(process.env.STRATA_COOLDOWN ?? 86400);
const PERFORMANCE_FEE_BPS = 1000;
const DEPOSIT_CAP = 1_000_000n * 10n ** 6n;

const client = createPublicClient({
  chain: monadTestnet,
  transport: rateLimitedHttp("https://testnet-rpc.monad.xyz"),
  pollingInterval: 500,
});

interface Step {
  index: number;
  label: string;
  nonce: number;
  to: Address | null;
  data: Hex;
  value: "0";
}
interface Plan {
  engine: Address;
  deployer: Address;
  launchTime: number;
  genesisStart: number;
  addresses: {
    strata: Address;
    staking: Address;
    distributor: Address;
    vault: Address;
  };
  steps: Step[];
}

async function plan(manifest: Manifest): Promise<Plan> {
  if (manifest.house)
    throw new Error("The public manifest already has a vault");
  const nonce = await client.getTransactionCount({
    address: manifest.deployer,
    blockTag: "pending",
  });
  const at = (offset: number) =>
    getContractAddress({
      from: manifest.deployer,
      nonce: BigInt(nonce + offset),
    });
  const addresses = {
    strata: at(0),
    staking: at(1),
    distributor: at(2),
    vault: at(3),
  };
  const now = Number((await client.getBlock()).timestamp);
  const launchTime = now + GENESIS_SECONDS;
  const create = (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    return encodeDeployData({ abi, bytecode, args });
  };
  const call = (name: string, functionName: string, args: unknown[]) =>
    encodeFunctionData({ abi: artifact(name).abi, functionName, args });
  const raw: Omit<Step, "index" | "nonce" | "value">[] = [
    { label: "Deploy StrataToken", to: null, data: create("StrataToken", []) },
    {
      label: "Deploy StrataStaking",
      to: null,
      data: create("StrataStaking", [
        addresses.strata,
        manifest.usdc,
        COOLDOWN,
      ]),
    },
    {
      label: "Deploy StrataDistributor",
      to: null,
      data: create("StrataDistributor", [
        addresses.strata,
        addresses.staking,
        manifest.maker,
      ]),
    },
    {
      label: "Deploy HouseVault",
      to: null,
      data: create("HouseVault", [
        manifest.engine,
        manifest.router,
        manifest.kuruMargin,
        manifest.maker,
        addresses.staking,
        PERFORMANCE_FEE_BPS,
        DEPOSIT_CAP,
        BigInt(launchTime),
      ]),
    },
    {
      label: "Distributor may mint STRATA",
      to: addresses.strata,
      data: call("StrataToken", "setMinter", [addresses.distributor, true]),
    },
    {
      label: "Staking may move locked STRATA",
      to: addresses.strata,
      data: call("StrataToken", "setTransferAllowed", [
        addresses.staking,
        true,
      ]),
    },
    {
      label: "Distributor may move locked STRATA",
      to: addresses.strata,
      data: call("StrataToken", "setTransferAllowed", [
        addresses.distributor,
        true,
      ]),
    },
  ];
  return {
    engine: manifest.engine,
    deployer: manifest.deployer,
    launchTime,
    genesisStart: now,
    addresses,
    steps: raw.map((s, index) => ({
      ...s,
      index,
      nonce: nonce + index,
      value: "0",
    })),
  };
}

async function verify(p: Plan, manifest: Manifest) {
  for (const [name, address] of Object.entries(p.addresses))
    if (!(await client.getCode({ address })))
      throw new Error(`${name} has no code at ${address}`);
  const read = (
    name: string,
    address: Address,
    fn: string,
    args: unknown[] = [],
  ) =>
    client.readContract({
      address,
      abi: artifact(name).abi,
      functionName: fn,
      args,
    });
  const checks: [string, boolean][] = [
    [
      "vault operator",
      (await read("HouseVault", p.addresses.vault, "operator")) ===
        manifest.maker,
    ],
    [
      "vault engine",
      (await read("HouseVault", p.addresses.vault, "engine")) ===
        manifest.engine,
    ],
    [
      "vault fees",
      (await read("HouseVault", p.addresses.vault, "feeRecipient")) ===
        p.addresses.staking,
    ],
    [
      "vault launch",
      Number(await read("HouseVault", p.addresses.vault, "launchTime")) ===
        p.launchTime,
    ],
    [
      "minter",
      (await read("StrataToken", p.addresses.strata, "minters", [
        p.addresses.distributor,
      ])) === true,
    ],
    [
      "staking transfers",
      (await read("StrataToken", p.addresses.strata, "transferAllowed", [
        p.addresses.staking,
      ])) === true,
    ],
    [
      "distributor transfers",
      (await read("StrataToken", p.addresses.strata, "transferAllowed", [
        p.addresses.distributor,
      ])) === true,
    ],
    [
      "publisher",
      (await read(
        "StrataDistributor",
        p.addresses.distributor,
        "publisher",
      )) === manifest.maker,
    ],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length)
    throw new Error(`House verification failed: ${failed.join(", ")}`);
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "plan" && mode !== "execute")
    throw new Error("Usage: testnet-house.ts plan|execute");
  const manifest = parseDeploymentManifest(readFileSync(manifestPath, "utf8"));
  if (manifest.chainId !== 10143)
    throw new Error("Public manifest is not Monad testnet");
  if (mode === "plan") {
    // Preview only: the keeper shares this account, so execute re-plans under the lease.
    const p = await plan(manifest);
    writeDeploymentJson(`${directory}/preview.json`, p);
    console.log(
      JSON.stringify({
        planned: p.steps.length,
        ...p.addresses,
        launchTime: p.launchTime,
      }),
    );
    return;
  }
  if (!(await cloud.claimWorker(randomUUID())))
    throw new Error("Hosted worker holds the signing lease; retry shortly");
  try {
    await execute(manifest);
  } finally {
    await cloud.releaseWorker();
  }
}

async function execute(manifest: Manifest) {
  // An existing plan resumes from its signer journal; otherwise plan now, under the lease.
  const p = existsSync(planPath)
    ? (JSON.parse(readFileSync(planPath, "utf8")) as Plan)
    : await plan(manifest);
  if (p.engine !== manifest.engine || p.deployer !== manifest.deployer)
    throw new Error("Plan belongs to a different deployment");
  writeDeploymentJson(planPath, p);
  const exact = reviewedStepAuthorizer(p.steps);
  const signer = configuredSigner(
    "deployer",
    client,
    monadTestnet,
    manifest.rpcUrl,
    `${directory}/signers`,
    async (intent) => {
      await cloud.assertWorkerLease();
      await exact(intent);
    },
    { journal: cloud.cloudSignerJournal(10143, manifest.deployer) },
  );
  try {
    const receipts: { index: number; hash: Hex }[] = [];
    for (const step of p.steps) {
      const hash = await signer.send({
        id: `house-v1/${manifest.engine}/${step.index}`,
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
          total: p.steps.length,
          operation: step.label,
          hash,
        }),
      );
    }
    await verify(p, manifest);
    const deployedBlock = (
      await client.getTransactionReceipt({ hash: receipts[3].hash })
    ).blockNumber.toString();
    const next = parseDeploymentManifest(
      JSON.stringify({
        ...manifest,
        house: {
          ...p.addresses,
          operator: manifest.maker,
          launchTime: p.launchTime,
          genesisStart: p.genesisStart,
          deployedBlock,
        },
      }),
    );
    await cloud.assertWorkerLease();
    writeDeploymentJson(manifestPath, next);
    await cloud.saveCloudState("public-manifest", next);
    console.log(
      JSON.stringify({
        published: true,
        vault: p.addresses.vault,
        launchTime: p.launchTime,
      }),
    );
  } finally {
    signer.close();
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
