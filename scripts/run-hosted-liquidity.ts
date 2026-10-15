import { loadCloudEnvironment } from "./lib/cloud-env.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeDeploymentJson } from "./deployment-executor.ts";
loadCloudEnvironment();
const cloud = await import("../apps/api/src/cloud-store.ts");
const passes = Number(process.argv[2] ?? 25);
const resume = process.argv[3] === "resume";
const cursor = Number(process.argv[3] ?? 9);
const directory = process.argv[4] ?? ".runtime/testnet/expansion";
if (
  (!resume && (!Number.isSafeInteger(cursor) || cursor < 0)) ||
  ![
    ".runtime/testnet/expansion",
    ".runtime/testnet/asset-expansion",
    ".runtime/testnet/judging-window",
  ].includes(directory)
)
  throw new Error("Invalid liquidity cursor or report directory");
if (!Number.isInteger(passes) || passes < 1 || passes > 30)
  throw new Error(
    "Use one to thirty bounded liquidity passes with cron paused",
  );
if (!resume) {
  if (!(await cloud.claimWorker(randomUUID())))
    throw new Error("Worker lease busy; pause cron and wait first");
  try {
    await cloud.saveCloudState("maker-cursor", cursor);
  } finally {
    await cloud.releaseWorker();
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch {
      if (attempt === 2)
        throw new Error(
          "Read failed; keep the signing lease intact and resume later",
        );
      await pause(1000);
    }
  }
}
async function waitForIdle() {
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const rows = await retryRead(() =>
      cloud.cloudRequest<{ expires_at: string }[]>(
        `strata_worker_leases?id=eq.${cloud.workerLease}&select=expires_at`,
      ),
    );
    if (!rows[0] || Date.parse(rows[0].expires_at) <= Date.now()) return;
    await pause(5000);
  }
  throw new Error("Worker remains active; stop without releasing its lease");
}
async function invokeWorker() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before =
      (await retryRead(() => cloud.loadCloudState<number>("maker-cursor"))) ??
      0;
    let complete = false;
    try {
      const response = await fetch("https://strata-xyz.vercel.app/api/worker", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.STRATA_WORKER_TOKEN}` },
        signal: AbortSignal.timeout(270000),
      });
      if (response.ok)
        complete =
          ((await response.json()) as { status: string }).status === "complete";
    } catch {
      console.log(
        JSON.stringify({
          connectionInterrupted: true,
          checkingDurableProgress: true,
        }),
      );
    }
    // A dropped HTTP connection does not prove that the signed work stopped.
    // Wait for the actual owner, then use its persisted cursor before retrying.
    await waitForIdle();
    const after =
      (await retryRead(() => cloud.loadCloudState<number>("maker-cursor"))) ??
      0;
    if (complete || after > before) return;
  }
  throw new Error(
    "Worker made no confirmed cursor progress; inspect health before resuming",
  );
}
const reportPath = `${directory}/liquidity-passes.json`;
const report: unknown[] = existsSync(reportPath)
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : [];
for (let pass = 0; pass < passes; pass++) {
  const start = Date.now();
  await retryRead(() => cloud.requestTradingWake());
  await invokeWorker();
  const snapshot = await retryRead(async () => {
    const response = await fetch("https://strata-xyz.vercel.app/api/snapshot", {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Snapshot unavailable");
    return (await response.json()) as any;
  });
  const active = snapshot.markets.filter((market: any) => market.active);
  const value = {
    pass: report.length + 1,
    seconds: Math.round((Date.now() - start) / 1000),
    active: active.length,
    fundedBooks: active.filter(
      (market: any) => market.bid !== null && market.ask !== null,
    ).length,
    openContracts: active.reduce(
      (sum: number, market: any) => sum + market.openInterest,
      0,
    ),
  };
  report.push(value);
  writeDeploymentJson(reportPath, report);
  console.log(JSON.stringify(value));
}
