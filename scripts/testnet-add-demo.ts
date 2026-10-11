import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import {
  createPublicClient,
  encodeFunctionData,
  encodeDeployData,
  getContractAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type Abi,
  type Hex,
} from "viem";
import { monadTestnet } from "viem/chains";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
import {
  factoryDeploymentAbi,
  type DeploymentStep,
} from "../packages/core/src/deployment-package.ts";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
import { configuredSigner } from "./lib/public-signer.ts";
import { reviewedStepAuthorizer } from "./signed-executor.ts";
import { artifact } from "./artifacts.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
const m = JSON.parse(readFileSync(".runtime/testnet/manifest.json", "utf8"));
const client = createPublicClient({
  chain: monadTestnet,
  batch: { multicall: { wait: 20, batchSize: 8192 } },
  transport: rateLimitedHttp(m.rpcUrl),
});
const path = ".runtime/testnet/add-demo.json";
let plan: any;
if (existsSync(path)) plan = JSON.parse(readFileSync(path, "utf8"));
else {
  const block = await client.getBlock();
  const id =
    Number(
      await client.readContract({
        address: m.engine,
        abi: artifact("OptionsEngine").abi,
        functionName: "seriesCount",
      }),
    ) + 1;
  const nonce = await client.getTransactionCount({
    address: m.deployer,
    blockTag: "pending",
  });
  const [rawPrice] = (await client.readContract({
    address: m.oracle,
    abi: artifact("OracleRouter").abi,
    functionName: "livePrice",
    args: [m.assetId],
  })) as [bigint, bigint];
  if (!rawPrice) throw new Error("Demo series needs a live MON reference");
  const strike = Math.ceil((Number(rawPrice) / 1e8) * 1.2 * 1e6) / 1e6;
  const expiry = Number(block.timestamp) + 1200;
  const symbol = `MON-DEMO-${id}-${strike}-P`;
  const token = getContractAddress({ from: m.engine, nonce: BigInt(id) });
  const bookArgs = [
    token,
    m.usdc,
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
    address: m.kuruFactory,
    abi: factoryDeploymentAbi,
    functionName: "computeAddress",
    args: [...bookArgs, zeroAddress, false],
  });
  const venue = getContractAddress({
    from: m.deployer,
    nonce: BigInt(nonce + 2),
  });
  const steps: any[] = [];
  const call = (to: Address, abi: Abi, name: string, args: unknown[]) =>
    steps.push({
      index: steps.length,
      nonce: nonce + steps.length,
      to,
      data: encodeFunctionData({ abi, functionName: name, args }),
      value: "0",
      label: name,
    });
  call(m.engine, artifact("OptionsEngine").abi, "createSeries", [
    m.wmon,
    m.assetId,
    BigInt(expiry),
    1,
    parseUnits(String(strike), 8),
    0n,
    1000000n,
    symbol,
  ]);
  call(m.kuruFactory, factoryDeploymentAbi, "deployProxy", [0, ...bookArgs]);
  steps.push({
    index: 2,
    nonce: nonce + 2,
    to: null,
    data: encodeDeployData({
      ...artifact("KuruExactAdapter"),
      args: [market, m.kuruMargin, BigInt(expiry)],
    }),
    value: "0",
    label: "Deploy KuruExactAdapter",
  });
  call(m.router, artifact("StrategyRouter").abi, "register", [
    BigInt(id),
    venue,
  ]);
  plan = {
    manifest: m,
    series: {
      id,
      token,
      market,
      venue,
      symbol,
      expiry,
      strike,
      upperStrike: 0,
      kind: "put",
      asset: "MON",
    },
    steps,
  };
  writeDeploymentJson(path, plan);
}
const signer = configuredSigner(
  "deployer",
  client,
  monadTestnet,
  m.rpcUrl,
  ".runtime/testnet/signers",
  reviewedStepAuthorizer(plan.steps),
);
try {
  for (const step of plan.steps)
    console.log(
      JSON.stringify({
        operation: step.label,
        hash: await signer.send({
          id: `add-demo/${m.engine}/${plan.series.id}/${step.index}`,
          nonce: step.nonce,
          to: step.to ?? undefined,
          data: step.data,
          value: 0n,
        }),
      }),
    );
  const manifest = {
    ...plan.manifest,
    series: [...plan.manifest.series, plan.series],
  };
  const report = await checkDeployment(client, client, manifest);
  writeDeploymentJson(".runtime/testnet/manifest.json", manifest);
  writeDeploymentJson(".runtime/testnet/verification.json", report);
  console.log(JSON.stringify({ added: true, series: plan.series }));
} finally {
  signer.close();
}
