import "dotenv/config";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import {
  parseDeploymentManifest,
  serviceRpcUrl,
  redactDiagnostic,
  rpcDiagnosticSecrets,
} from "../packages/core/src/deployment-config.ts";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
import {
  prepareMakerBootstrap,
  type MakerBootstrap,
} from "../packages/core/src/maker-bootstrap.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
import { executeMakerBootstrap } from "./bootstrap-maker.ts";
import { executeSignedPackage } from "./signed-executor.ts";
import { monadTestnet } from "viem/chains";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
let secrets: string[] = [];
async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (
    !["prepare", "execute-local", "execute-signed"].includes(operation) ||
    ![4, 6].includes(args.length) ||
    (args.length === 6 &&
      (operation !== "prepare" || args[4] !== "--quantity")) ||
    args[0] !== "--input" ||
    args[2] !== "--out"
  )
    throw new Error(
      "Usage: maker:bootstrap prepare|execute-local --input JSON-path --out directory",
    );
  const path = resolve(args[1]),
    directory = resolve(args[3]);
  if (statSync(path).size > 8000000)
    throw new Error("Bootstrap input exceeds supported bounds");
  if (operation === "prepare") {
    const manifest = parseDeploymentManifest(readFileSync(path, "utf8"));
    const endpoint = serviceRpcUrl(manifest, process.env.SERVICE_RPC_URL);
    secrets = rpcDiagnosticSecrets(endpoint);
    const client = createPublicClient({
      ...(manifest.chainId === 10143
        ? {
            chain: monadTestnet,
            batch: { multicall: { wait: 20, batchSize: 8192 } },
          }
        : {}),
      transport:
        manifest.chainId === 10143
          ? rateLimitedHttp(endpoint)
          : http(endpoint, { timeout: 15000, retryCount: 0 }),
    });
    const browser = createPublicClient({
      ...(manifest.chainId === 10143
        ? {
            chain: monadTestnet,
            batch: { multicall: { wait: 20, batchSize: 8192 } },
          }
        : {}),
      transport:
        manifest.chainId === 10143
          ? rateLimitedHttp(manifest.rpcUrl)
          : http(manifest.rpcUrl, { timeout: 15000, retryCount: 0 }),
    });
    await checkDeployment(client, browser, manifest);
    const pkg = await prepareMakerBootstrap(
      client,
      manifest,
      args.length === 6 ? Number(args[5]) : 90,
    );
    writeDeploymentJson(resolve(directory, "bootstrap.json"), pkg);
    console.log(
      JSON.stringify(
        {
          unsigned: true,
          digest: pkg.digest,
          nativeWrap: pkg.funding.nativeWrap,
          stableCollateral: pkg.funding.stableCollateral,
          stableQuotes: pkg.funding.stableQuotes,
          markets: pkg.markets.length,
          transactions: pkg.steps.length,
          path: resolve(directory, "bootstrap.json"),
        },
        null,
        2,
      ),
    );
  } else {
    let pkg: MakerBootstrap;
    try {
      pkg = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("Bootstrap package is not valid JSON");
    }
    console.log(
      JSON.stringify(
        await (operation === "execute-signed"
          ? executeSignedPackage(pkg, directory)
          : executeMakerBootstrap(pkg, directory)),
      ),
    );
  }
}
main().catch((error) => {
  console.error(
    redactDiagnostic(error, secrets).split("\n").slice(0, 3).join("\n"),
  );
  process.exitCode = 1;
});
