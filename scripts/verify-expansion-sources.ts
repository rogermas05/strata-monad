import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { writeDeploymentJson } from "./deployment-executor.ts";

const directory = process.argv[2] ?? ".runtime/testnet/expansion";
if (
  ![".runtime/testnet/expansion", ".runtime/testnet/asset-expansion"].includes(
    directory,
  )
)
  throw new Error("Unknown source verification package");
const plan = JSON.parse(readFileSync(`${directory}/plan.json`, "utf8"));
const receipts = JSON.parse(
  readFileSync(`${directory}/receipts.json`, "utf8"),
) as { index: number; hash: string }[];
const reportPath = `${directory}/source-verifications.json`;
const report: any[] = existsSync(reportPath)
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : [];
const artifact = JSON.parse(
  readFileSync("contracts/out/Venues.sol/KuruExactAdapter.json", "utf8"),
);
const { compilationTarget, ...settings } = artifact.metadata.settings;
const sources = Object.fromEntries(
  Object.keys(artifact.metadata.sources).map((path) => [
    path,
    { content: readFileSync(resolve("contracts", path), "utf8") },
  ]),
);
for (const step of plan.steps.filter((value: any) => !value.to)) {
  let entry = report.find(
    (value) =>
      value.address.toLowerCase() === step.expectedAddress.toLowerCase(),
  );
  if (!entry) {
    const receipt = receipts.find((value) => value.index === step.index);
    if (!receipt) throw new Error("Expansion deployment receipt missing");
    const response = await fetch(
      `https://sourcify.dev/server/v2/verify/10143/${step.expectedAddress}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stdJsonInput: { language: "Solidity", sources, settings },
          compilerVersion: artifact.metadata.compiler.version,
          contractIdentifier: `${Object.keys(compilationTarget)[0]}:KuruExactAdapter`,
          creationTransactionHash: receipt.hash,
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw new Error(`Source submission failed (${response.status})`);
    entry = {
      address: step.expectedAddress,
      contract: "KuruExactAdapter",
      submission: await response.json(),
    };
    report.push(entry);
    writeDeploymentJson(reportPath, report);
  }
  const response = await fetch(
    `https://sourcify.dev/server/v2/verify/${entry.submission.verificationId}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok)
    throw new Error(`Source verification status failed (${response.status})`);
  entry.verification = await response.json();
  writeDeploymentJson(reportPath, report);
  console.log(
    JSON.stringify({
      address: entry.address,
      complete: entry.verification.isJobCompleted,
      match: entry.verification.contract?.match,
    }),
  );
}
