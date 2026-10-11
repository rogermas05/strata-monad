import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  encodeFunctionData,
  parseEther,
  parseUnits,
  type Abi,
  type Address,
} from "viem";
import { monadTestnet } from "viem/chains";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
import { parseDeploymentManifest } from "../packages/core/src/deployment-config.ts";
import { configuredSigner } from "./lib/public-signer.ts";
import { artifact } from "./artifacts.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
config({ quiet: true });
config({ path: ".runtime/cloud/supabase.env", quiet: true });
const cloud = await import("../apps/api/src/cloud-store.ts");
const manifest = parseDeploymentManifest(
  readFileSync(".runtime/testnet/manifest.json", "utf8"),
);
const client = createPublicClient({
  chain: monadTestnet,
  batch: { multicall: { wait: 20, batchSize: 8192 } },
  transport: rateLimitedHttp(manifest.rpcUrl),
  pollingInterval: 500,
});
if (!(await cloud.claimWorker(randomUUID())))
  throw new Error(
    "Pause cron and wait for the worker lease before validating a purchase",
  );
const allowed = new Set<string>();
const signer = configuredSigner(
  "deployer",
  client,
  monadTestnet,
  manifest.rpcUrl,
  ".runtime/testnet/expansion/depth-signers",
  async (intent) => {
    await cloud.assertWorkerLease();
    if (
      intent.value !== 0n ||
      !allowed.has(`${intent.to?.toLowerCase()}:${intent.data}`)
    )
      throw new Error(
        "Only the exact five-contract verification purchase is authorized",
      );
  },
  { journal: cloud.cloudSignerJournal(10143, manifest.deployer) },
);
try {
  const snapshot = (await (
    await fetch("https://strata-monad-demo.vercel.app/api/snapshot", {
      signal: AbortSignal.timeout(15000),
    })
  ).json()) as any;
  const market = snapshot.markets.find(
    (value: any) =>
      value.id >= 12 &&
      value.asset === "MON" &&
      value.kind === "put" &&
      value.active &&
      value.asks[0]?.quantity >= 5,
  );
  if (!market)
    throw new Error(
      "New MON put does not yet have five funded contracts at the best ask",
    );
  if (
    (await client.getBalance({ address: manifest.deployer })) <
    parseEther("0.5")
  )
    throw new Error("Keeper must retain a native gas reserve");
  const quantity = parseUnits("5", 18);
  const cost = BigInt(Math.round(market.ask * 1e6)) * 5n;
  const budget = (cost * 1005n + 999n) / 1000n;
  if (!budget || budget > parseUnits("1", 6))
    throw new Error("Verification premium is outside its one-dUSDC bound");
  const send = async (
    name: string,
    to: Address,
    abi: Abi,
    fn: string,
    args: unknown[],
  ) => {
    const data = encodeFunctionData({ abi, functionName: fn, args });
    allowed.add(`${to.toLowerCase()}:${data}`);
    return signer.send({
      id: `expansion-v1/depth/${market.id}/${name}`,
      to,
      data,
      value: 0n,
    });
  };
  const before = (await client.readContract({
    address: market.token,
    abi: artifact("OptionToken").abi,
    functionName: "balanceOf",
    args: [manifest.deployer],
  })) as bigint;
  await send("approve", manifest.usdc, artifact("DemoUSDC").abi, "approve", [
    manifest.router,
    budget,
  ]);
  const block = await client.getBlock();
  const hash = await send(
    "purchase",
    manifest.router,
    artifact("StrategyRouter").abi,
    "execute",
    [
      [
        {
          seriesId: BigInt(market.id),
          isBuy: true,
          quantity,
          premiumLimit: budget,
        },
      ],
      budget,
      budget,
      0n,
      block.timestamp + 180n,
    ],
  );
  const after = (await client.readContract({
    address: market.token,
    abi: artifact("OptionToken").abi,
    functionName: "balanceOf",
    args: [manifest.deployer],
  })) as bigint;
  if (after - before !== quantity)
    throw new Error(
      "Verification purchase did not deliver exactly five contracts",
    );
  const result = {
    publicTestnet: true,
    projectVerificationTrade: true,
    account: manifest.deployer,
    market: market.symbol,
    quantity: "5",
    purchaseHash: hash,
    premiumBudgetBaseUnits: budget.toString(),
    exactClaims: true,
  };
  writeDeploymentJson(".runtime/testnet/expansion/depth-purchase.json", result);
  console.log(JSON.stringify(result));
} finally {
  signer.close();
  await cloud.releaseWorker();
}
