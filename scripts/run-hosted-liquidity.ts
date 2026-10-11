import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { writeDeploymentJson } from "./deployment-executor.ts";
config({ quiet: true });
config({ path: ".runtime/cloud/supabase.env", quiet: true });
const cloud = await import("../apps/api/src/cloud-store.ts");
const passes = Number(process.argv[2] ?? 25);
const cursor = Number(process.argv[3] ?? 9);
const directory = process.argv[4] ?? ".runtime/testnet/expansion";
if (
  !Number.isSafeInteger(cursor) ||
  cursor < 0 ||
  ![".runtime/testnet/expansion", ".runtime/testnet/asset-expansion"].includes(
    directory,
  )
)
  throw new Error("Invalid liquidity cursor or report directory");
if (!Number.isInteger(passes) || passes < 1 || passes > 30)
  throw new Error(
    "Use one to thirty bounded liquidity passes with cron paused",
  );
if (!(await cloud.claimWorker(randomUUID())))
  throw new Error("Worker lease busy; pause cron and wait first");
try {
  await cloud.saveCloudState("maker-cursor", cursor);
} finally {
  await cloud.releaseWorker();
}
const report: unknown[] = [];
for (let pass = 0; pass < passes; pass++) {
  const start = Date.now();
  const response = await fetch(
    "https://strata-monad-demo.vercel.app/api/worker",
    {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.STRATA_WORKER_TOKEN}` },
      signal: AbortSignal.timeout(270000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Hosted liquidity pass failed (${response.status}); inspect worker health before resuming`,
    );
  const result = (await response.json()) as { status: string };
  if (result.status !== "complete")
    throw new Error(
      "Hosted worker already running; wait for its lease before resuming",
    );
  const snapshot = (await (
    await fetch("https://strata-monad-demo.vercel.app/api/snapshot", {
      signal: AbortSignal.timeout(15000),
    })
  ).json()) as any;
  const active = snapshot.markets.filter((market: any) => market.active);
  const value = {
    pass: pass + 1,
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
  writeDeploymentJson(`${directory}/liquidity-passes.json`, report);
  console.log(JSON.stringify(value));
}
