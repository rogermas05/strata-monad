import "dotenv/config";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { artifact } from "./artifacts.ts";
import { checkRpcPair } from "../packages/core/src/deployment-check.ts";
import {
  prepareDeploymentPackage,
  parseDeploymentIntent,
} from "../packages/core/src/deployment-package.ts";
import {
  serviceRpcUrl,
  rpcDiagnosticSecrets,
  redactDiagnostic,
} from "../packages/core/src/deployment-config.ts";
import {
  executeLocalDeployment,
  writeDeploymentJson,
} from "./deployment-executor.ts";
import { executeSignedPackage } from "./signed-executor.ts";
let secrets: string[] = [];
async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (
    !["prepare", "execute-local", "execute-signed"].includes(operation) ||
    args.length !== 4 ||
    args[0] !== "--input" ||
    args[2] !== "--out"
  )
    throw new Error(
      "Usage: deployment:package prepare|execute-local|execute-signed --input JSON-path --out directory",
    );
  const path = resolve(args[1]);
  if (statSync(path).size > 32000000)
    throw new Error("Deployment input exceeds supported bounds");
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Deployment input is not valid JSON");
  }
  const directory = resolve(args[3]);
  if (operation === "prepare") {
    const intent = parseDeploymentIntent(input);
    const endpoint = serviceRpcUrl(intent, process.env.SERVICE_RPC_URL);
    secrets = rpcDiagnosticSecrets(endpoint);
    const client = createPublicClient({
      transport: http(endpoint, { timeout: 15000, retryCount: 0 }),
    });
    if (endpoint !== intent.rpcUrl)
      await checkRpcPair(
        client,
        createPublicClient({
          transport: http(intent.rpcUrl, { timeout: 15000, retryCount: 0 }),
        }),
        { chainId: intent.chainId, deployedBlock: "0" },
      );
    const pkg = await prepareDeploymentPackage(client, input, artifact);
    writeDeploymentJson(resolve(directory, "package.json"), pkg);
    const review = [
      "# Unsigned deployment review",
      "",
      `Digest: ${pkg.digest}`,
      `Chain: ${pkg.intent.chainId}`,
      `Sender: ${pkg.intent.deployer}`,
      `Anchor: ${pkg.anchor.number} (${pkg.anchor.hash})`,
      `Nonce range: ${pkg.nonceStart}–${pkg.nonceStart + pkg.steps.length - 1}`,
      "",
      pkg.scope,
      "",
      "Every transaction has zero native value; gas is paid separately. The expected manifest is not a deployed-state certificate. Execution must recheck nonces, artifacts, dependency code and factory pointers.",
      "",
      "| Step | Nonce | Operation | Target / expected deployment | Arguments |",
      "| --- | --- | --- | --- | --- |",
      ...pkg.steps.map(
        (s) =>
          `| ${s.index + 1} | ${s.nonce} | ${s.label} | ${s.to ?? "CREATE"}${s.expectedAddress ? ` → ${s.expectedAddress}` : ""} | ${s.arguments.join(", ")} |`,
      ),
      "",
      "## Artifact creation-code hashes",
      "",
      ...Object.entries(pkg.artifactHashes).map(
        ([name, hash]) => `- ${name}: ${hash}`,
      ),
      "",
      "## External dependency runtime-code hashes",
      "",
      ...Object.entries(pkg.dependencies.codeHashes).map(
        ([address, hash]) => `- ${address}: ${hash}`,
      ),
      "",
    ].join("\n");
    writeFileSync(resolve(directory, "review.md"), review, { mode: 0o600 });
    console.log(
      JSON.stringify(
        {
          unsigned: true,
          digest: pkg.digest,
          chainId: pkg.intent.chainId,
          nonceStart: pkg.nonceStart,
          transactions: pkg.steps.length,
          manifestIsExpectedOnly: true,
          scope: pkg.scope,
          packagePath: resolve(directory, "package.json"),
        },
        null,
        2,
      ),
    );
  } else if (operation === "execute-signed") {
    console.log(
      JSON.stringify(
        await executeSignedPackage(
          input as import("../packages/core/src/deployment-package.ts").DeploymentPackage,
          directory,
        ),
      ),
    );
  } else {
    const result = await executeLocalDeployment(input, directory, {
      progress: console.log,
    });
    console.log(
      JSON.stringify(
        {
          status: result.status,
          completed: result.completed,
          journalPath: result.journalPath,
          manifestPath:
            "manifestPath" in result ? result.manifestPath : undefined,
        },
        null,
        2,
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
