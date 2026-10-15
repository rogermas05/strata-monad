import { loadCloudEnvironment } from "./lib/cloud-env.ts";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { existsSync, readFileSync } from "node:fs";

loadCloudEnvironment();
if (!process.env.STRATA_STATE_DATABASE_URL)
  throw new Error("Neon backend credentials are required");
process.env.MANIFEST_PATH = ".runtime/testnet/manifest.json";
process.env.STRATA_RUNTIME_DIRECTORY = resolve(".runtime/neon-rebuild");
process.env.STRATA_SERVERLESS = "1";
const makerProfile = [
  ".runtime/testnet/judging-window/maker-config.json",
  ".runtime/testnet/asset-expansion/maker-config.json",
].find(existsSync);
if (makerProfile)
  process.env.STRATA_MAKER_CONFIG_JSON ??= readFileSync(makerProfile, "utf8");
// This script only reads the chain. It never runs a signer or a worker cycle.
const cloud = await import("../apps/api/src/cloud-store.ts");
const runtime = await import("../apps/api/src/runtime.ts");
if (!(await cloud.claimWorker(randomUUID())))
  throw new Error("Worker lease busy; wait for its owner to finish");
let renewal: Promise<void> = Promise.resolve();
const timer = setInterval(() => {
  renewal = renewal.then(() => cloud.assertWorkerLease());
  renewal.catch(() => clearInterval(timer));
}, 60000);
try {
  for (const address of [runtime.manifest.deployer, runtime.manifest.maker]) {
    const [latest, pending] = await Promise.all([
      runtime.client.getTransactionCount({ address, blockTag: "latest" }),
      runtime.client.getTransactionCount({ address, blockTag: "pending" }),
    ]);
    if (latest !== pending)
      throw new Error(
        `Pending signer transactions for ${address}; reconcile first`,
      );
    console.log(JSON.stringify({ address, confirmedNonce: latest }));
  }
  const previous = await cloud.loadCloudState<any>("public-manifest");
  if (previous && !isDeepStrictEqual(previous, runtime.manifest))
    throw new Error(
      "Existing cloud manifest differs; reconcile before rebuilding",
    );
  await cloud.saveCloudState("public-manifest", runtime.manifest);
  await runtime.reloadCloudReadModel();
  await import("../apps/api/src/house.ts");
  const { refreshDisplayPrices } =
    await import("../apps/api/src/pyth-keeper.ts");
  await refreshDisplayPrices();
  console.log(
    "Replaying confirmed Monad logs; checkpoints are saved every 10,000 blocks",
  );
  await runtime.refresh();
  // The historical pass may take minutes. Refresh at the current tip before publishing.
  await refreshDisplayPrices();
  const snapshot = await runtime.refresh();
  await runtime.persistCloudReadModel();
  await cloud.saveCloudState("worker-health", {
    status: "ready",
    service: snapshot.service,
    chainId: runtime.manifest.chainId,
    mode: "display",
    gasLow: false,
    lastSuccess: Date.now(),
    errors: [],
    signers: [],
  });
  console.log(
    JSON.stringify({
      rebuilt: true,
      block: snapshot.block,
      markets: snapshot.markets.length,
    }),
  );
} catch (error) {
  console.error(runtime.safeDiagnostic(error).split("\n")[0]);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  await renewal;
  await cloud.releaseWorker();
}
