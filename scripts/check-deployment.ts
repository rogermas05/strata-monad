import "dotenv/config";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { createPublicClient, http } from "viem";
import {
  parseDeploymentManifest,
  serviceRpcUrl,
  redactDiagnostic,
  rpcDiagnosticSecrets,
} from "../packages/core/src/deployment-config.ts";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
let secrets: string[] = [];
async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (a, i) => i % 2 === 0 && !["--manifest", "--report"].includes(a),
    ) ||
    args.length % 2 ||
    new Set(args.filter((_, i) => i % 2 === 0)).size !== args.length / 2
  )
    throw new Error(
      "Usage: deployment:check [--manifest path] [--report path]",
    );
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const manifest = parseDeploymentManifest(
    readFileSync(
      resolve(option("--manifest") ?? ".runtime/manifest.json"),
      "utf8",
    ),
  );
  const privateRpc = serviceRpcUrl(manifest, process.env.SERVICE_RPC_URL);
  secrets = rpcDiagnosticSecrets(privateRpc);
  const transport = (endpoint: string) =>
    http(endpoint, {
      batch: { batchSize: 20, wait: 10 },
      timeout: 15000,
      retryCount: 0,
    });
  const service = createPublicClient({ transport: transport(privateRpc) });
  const browser = createPublicClient({ transport: transport(manifest.rpcUrl) });
  const report = await checkDeployment(service, browser, manifest);
  const path = resolve(
    option("--report") ??
      `.runtime/deployment-checks/${manifest.chainId}/${manifest.engine.toLowerCase()}-${report.block.number}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  console.log(
    JSON.stringify(
      {
        verified: true,
        scope: report.scope,
        chainId: report.chainId,
        engine: report.engine,
        block: report.block.number,
        seriesChecked: report.series.length,
        liveOracleHealthy: report.oracle.healthy,
        reportPath: path,
        genuineSignedProofAdmission: report.oracle.genuineSignedProofAdmission,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(
    redactDiagnostic(error, secrets).split("\n").slice(0, 3).join("\n"),
  );
  process.exitCode = 1;
});
