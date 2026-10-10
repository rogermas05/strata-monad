import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
import { parseDeploymentManifest } from "../packages/core/src/deployment-config.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
import { monadTestnet } from "viem/chains";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
const pkg = JSON.parse(readFileSync(".runtime/testnet/package.json", "utf8"));
const journal = JSON.parse(
  readFileSync(".runtime/testnet/signed-journal.json", "utf8"),
);
if (
  journal.digest !== pkg.digest ||
  journal.entries.length !== pkg.steps.length
)
  throw new Error("Deployment journal is incomplete");
const manifest = parseDeploymentManifest(JSON.stringify(pkg.manifest));
const client = createPublicClient({
  chain: monadTestnet,
  batch: { multicall: { wait: 20, batchSize: 8192 } },
  transport: rateLimitedHttp(manifest.rpcUrl),
});
for (let from = 0; from < pkg.steps.length; from += 4)
  await Promise.all(
    pkg.steps.slice(from, from + 4).map(async (step: any) => {
      const entry = journal.entries.find((e: any) => e.index === step.index);
      const tx = await client.getTransaction({ hash: entry.hash });
      const receipt = await client.getTransactionReceipt({ hash: entry.hash });
      if (
        tx.from.toLowerCase() !== pkg.intent.deployer.toLowerCase() ||
        tx.nonce !== step.nonce ||
        (tx.to?.toLowerCase() ?? null) !== (step.to?.toLowerCase() ?? null) ||
        tx.input.toLowerCase() !== step.data.toLowerCase() ||
        tx.value !== 0n ||
        receipt.status !== "success" ||
        (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !==
          receipt.blockHash
      )
        throw new Error(
          "Deployment journal does not match canonical reviewed transactions",
        );
    }),
  );
const report = await checkDeployment(client, client, manifest);
writeDeploymentJson(".runtime/testnet/manifest.json", manifest);
writeDeploymentJson(".runtime/testnet/verification.json", report);
console.log(
  JSON.stringify({
    verified: true,
    transactions: pkg.steps.length,
    markets: manifest.series.length,
    engine: manifest.engine,
  }),
);
