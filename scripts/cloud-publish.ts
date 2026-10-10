import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createPublicClient, http } from "viem";
import { parseDeploymentManifest } from "../packages/core/src/deployment-config.ts";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
import { monadTestnet } from "viem/chains";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
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
});
await checkDeployment(client, client, manifest);
if (!(await cloud.claimWorker(randomUUID())))
  throw new Error("Public worker already owns activation lease");
try {
  await cloud.saveCloudState("public-manifest", manifest);
  console.log(
    JSON.stringify({
      published: true,
      engine: manifest.engine,
      markets: manifest.series.length,
    }),
  );
} finally {
  await cloud.releaseWorker();
}
