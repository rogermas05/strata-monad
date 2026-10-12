import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeDeploymentJson } from "./deployment-executor.ts";
const files: Record<string, string> = {
  OptionsEngine: "OptionsEngine.sol",
  StrategyRouter: "Venues.sol",
  DemoUSDC: "TestAssets.sol",
  WrappedMON: "TestAssets.sol",
  PythExpiryOracle: "Oracle.sol",
  PythSessionCloseOracle: "Oracle.sol",
  OracleRouter: "Oracle.sol",
  KuruExactAdapter: "Venues.sol",
  OptionToken: "OptionsEngine.sol",
};
const pkg = JSON.parse(readFileSync(".runtime/testnet/package.json", "utf8"));
const db = new DatabaseSync(
  `.runtime/testnet/signers/10143/${pkg.intent.deployer.toLowerCase()}/transactions.sqlite`,
  { readOnly: true },
);
const report: unknown[] = [];
for (const step of pkg.steps.filter((s: any) => !s.to && s.contract)) {
  const row = db
    .prepare("select hash,status from jobs where nonce=?")
    .get(step.nonce) as { hash: string; status: string } | undefined;
  if (!row || row.status !== "included") continue;
  const a = JSON.parse(
    readFileSync(
      `contracts/out/${files[step.contract]}/${step.contract}.json`,
      "utf8",
    ),
  );
  const metadata = a.metadata;
  const { compilationTarget, ...settings } = metadata.settings;
  const sources = Object.fromEntries(
    Object.keys(metadata.sources).map((path) => [
      path,
      { content: readFileSync(resolve("contracts", path), "utf8") },
    ]),
  );
  const response = await fetch(
    `https://sourcify.dev/server/v2/verify/10143/${step.expectedAddress}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stdJsonInput: { language: "Solidity", sources, settings },
        compilerVersion: metadata.compiler.version,
        contractIdentifier: `${Object.keys(compilationTarget)[0]}:${step.contract}`,
        creationTransactionHash: row.hash,
      }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const result = await response.json();
  report.push({
    contract: step.contract,
    address: step.expectedAddress,
    submission: result,
  });
  console.log(
    JSON.stringify({
      contract: step.contract,
      address: step.expectedAddress,
      status: response.status,
      ...result,
    }),
  );
  writeDeploymentJson(".runtime/testnet/source-verifications.json", report);
}
db.close();
