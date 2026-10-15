import { timingSafeEqual, randomUUID } from "node:crypto";
import { forwardedRequest } from "../apps/api/src/node-request.ts";
import {
  cloudEnabled,
  loadCloudState,
  claimWorker,
  releaseWorker,
  saveCloudState,
  requestTradingWake,
  withReadOnlyState,
} from "../apps/api/src/cloud-store.ts";
import { redactDiagnostic } from "../packages/core/src/deployment-config.ts";
import { maintainIdleDemo } from "../apps/api/src/idle-maintenance.ts";
import { reuseIdlePass } from "../apps/api/src/cloud-retention.ts";
import {
  pendingTradingDemand,
  requestedMarkets,
  TRADING_REQUEST_MS,
  TRADING_COOLDOWN_MS,
  type TradingDemand,
} from "../apps/api/src/trading-demand.ts";

process.env.STRATA_SERVERLESS = "1";
/** Below this keeper balance the worker cannot relay prices, so it stays asleep. */
const KEEPER_MIN_WEI = 50_000_000_000_000_000n;
const IDLE_MAINTENANCE_MS = 30_000;
type Wake = TradingDemand;
const awakeUntil = (wake: Wake | undefined) =>
  wake ? wake.at + TRADING_REQUEST_MS : 0;
process.env.STRATA_RUNTIME_DIRECTORY = `/tmp/strata-${process.pid}`;
let application:
  Promise<typeof import("../apps/api/src/server.ts")> | undefined;
async function initialize() {
  if (!application)
    application = (async () => {
      if (!cloudEnabled) throw new Error("Cloud backend configuration missing");
      const manifest = await loadCloudState<unknown>("public-manifest");
      if (!manifest) throw new Error("Public deployment pending funding");
      process.env.STRATA_MANIFEST_JSON = JSON.stringify(manifest);
      return import("../apps/api/src/server.ts");
    })().catch((error) => {
      application = undefined;
      throw error;
    });
  return application;
}
function authorized(request: any) {
  const actual = request.headers.authorization ?? "";
  const expected = `Bearer ${process.env.STRATA_WORKER_TOKEN ?? ""}`;
  return (
    !!process.env.STRATA_WORKER_TOKEN &&
    actual.length === expected.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}
function servedReadiness(saved: any) {
  const age = Date.now() - saved.lastSuccessfulRefreshAt;
  return {
    ...saved,
    evaluatedAt: Date.now(),
    ...(age >= 0 && age <= 15_000
      ? {}
      : {
          status: "degraded",
          newExposureAllowed: false,
          reason: "The confirmed worker view is stale. New exposure is paused.",
        }),
  };
}
export default async function handler(request: any, response: any) {
  const url = new URL(request.url, "https://strata.invalid");
  const route = url.searchParams.get("route");
  const path = route ? `/api/${route}` : url.pathname;
  response.setHeader("Cache-Control", "no-store");
  if (path === "/api/worker" && !authorized(request))
    return response
      .status(403)
      .json({ error: "Worker authorization required" });
  try {
    if (path === "/api/health") {
      const [view, worker] = await Promise.all([
        loadCloudState<any>("public-health"),
        loadCloudState<any>("worker-health"),
      ]);
      const health = view?.service ? view : worker;
      if (health?.service && health.chainId) {
        const service = servedReadiness(health.service);
        return response.status(service.status === "ready" ? 200 : 503).json({
          ok: service.status === "ready",
          service,
          chainId: health.chainId,
          mode: "testnet",
          serverSigningEnabled: false,
          publicWorkersEnabled: process.env.STRATA_PUBLIC_WORKERS === "1",
          worker,
          workersSuspended: false,
          localCheckpoint: null,
        });
      }
    }
    if (path === "/api/snapshot" || path === "/api/health") {
      const saved = await loadCloudState<any>("public-snapshot");
      if (saved) {
        const worker = await loadCloudState<any>("worker-health");
        const service = servedReadiness(saved.service);
        if (path === "/api/health") {
          return response.status(service.status === "ready" ? 200 : 503).json({
            ok: service.status === "ready",
            service,
            chainId: saved.manifest.chainId,
            mode: saved.manifest.mode,
            serverSigningEnabled: false,
            publicWorkersEnabled: process.env.STRATA_PUBLIC_WORKERS === "1",
            worker,
            workersSuspended: false,
            localCheckpoint: null,
          });
        }
        const [wake, completedAt, gasPause] = await Promise.all([
          loadCloudState<Wake>("trading-wake"),
          loadCloudState<number>("trading-completed-at"),
          loadCloudState<{ until: number }>("worker-gas-pause"),
        ]);
        return response.status(200).json({
          ...saved,
          service,
          trading: {
            mode: worker?.mode ?? "trading",
            awakeUntil: pendingTradingDemand(wake, completedAt ?? 0)
              ? awakeUntil(wake)
              : 0,
            gasLow: worker?.gasLow ?? false,
            budgetPausedUntil: gasPause?.until ?? 0,
          },
          maker: {
            ...saved.maker,
            errors: [
              ...new Set([...saved.maker.errors, ...(worker?.errors ?? [])]),
            ],
          },
          markets: saved.markets.map((m: any) => ({
            ...m,
            healthy: m.healthy && service.newExposureAllowed,
          })),
        });
      }
    }
    if (path === "/api/wake") {
      if (request.method !== "POST")
        return response.status(405).json({ error: "Use POST" });
      const gasPause = await loadCloudState<{ until: number }>(
        "worker-gas-pause",
      );
      if (gasPause && gasPause.until > Date.now())
        return response
          .status(429)
          .json({
            error:
              "Daily demo maintenance budget reached. It resets at 00:00 UTC; funded markets with fresh prices remain tradable.",
          });
      const wake = await loadCloudState<Wake>("trading-wake");
      const manifest = await loadCloudState<{
        series: { id: number; expiry: number }[];
      }>("public-manifest");
      let marketIds: number[];
      try {
        const body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : request.body;
        marketIds = requestedMarkets(body, manifest?.series ?? []);
      } catch {
        return response
          .status(400)
          .json({ error: "Choose one to four unexpired markets" });
      }
      if (wake && Date.now() - wake.at < TRADING_COOLDOWN_MS)
        return response.status(429).json({
          error: "A market refresh was just requested. Try again shortly.",
        });
      const at = Date.now();
      await requestTradingWake(at, marketIds);
      return response
        .status(202)
        .json({ awakeUntil: awakeUntil({ at, marketIds }) });
    }
    if (path === "/api/worker") {
      if (!(await claimWorker(randomUUID())))
        return response.status(202).json({ status: "already-running" });
      let consumedDemand: Wake | undefined;
      try {
        const wake = await loadCloudState<Wake>("trading-wake");
        const consumedAt =
          (await loadCloudState<number>("trading-consumed-at")) ?? 0;
        const pending = pendingTradingDemand(wake, consumedAt);
        const previous = await loadCloudState<any>("worker-health");
        if (reuseIdlePass(Date.now(), pending ? awakeUntil(wake) : 0, previous))
          return response
            .status(200)
            .json({ status: "complete", mode: "cached-display" });
        await initialize();
        const runtime = await import("../apps/api/src/runtime.ts");
        if (!runtime.publicWorkers)
          return response
            .status(503)
            .json({ error: "Public workers disabled" });
        const started = Date.now();
        // Elapsed-time markers in the function log locate a pass that stalls.
        const step = (name: string) =>
          console.log(`worker ${name} +${Date.now() - started}ms`);
        const keeperBalance = await runtime.client.getBalance({
          address: runtime.manifest.deployer,
        });
        const gasLow = keeperBalance < KEEPER_MIN_WEI;
        if (gasLow || !pending) {
          // Display pass: real off-chain Pyth prices for charts and marks,
          // chain reads for books and balances. Expiry/vault maintenance stays
          // active without paying to relay prices or replenish trading quotes.
          await runtime.serialized(async () => {
            await runtime.reloadCloudReadModel();
            const { refreshDisplayPrices } =
              await import("../apps/api/src/pyth-keeper.ts");
            await refreshDisplayPrices();
            const snapshot = await runtime.refresh();
            await runtime.persistCloudReadModel();
            const lastMaintenance =
              (await loadCloudState<number>("idle-maintenance-at")) ?? 0;
            if (
              !gasLow &&
              Date.now() - lastMaintenance >= IDLE_MAINTENANCE_MS
            ) {
              try {
                await maintainIdleDemo(snapshot, {
                  settle: async () => {
                    const { runSettlementPass } =
                      await import("../apps/api/src/pyth-keeper.ts");
                    await runSettlementPass();
                  },
                  refresh: runtime.refresh,
                  house: async (options) => {
                    const { runHouseCycle } =
                      await import("../apps/api/src/house-worker.ts");
                    await runHouseCycle(options);
                  },
                });
              } catch (error) {
                runtime.recordWorkerError(
                  `Idle maintenance: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              await saveCloudState("idle-maintenance-at", Date.now());
              await runtime.refresh();
            }
            await runtime.persistCloudReadModel();
            await saveCloudState("worker-health", {
              status: "ready",
              service: runtime.current()?.service,
              chainId: runtime.manifest.chainId,
              mode: "display",
              gasLow,
              lastSuccess: Date.now(),
              errors: runtime.workerErrors.slice(-5),
              signers: runtime.workerSignerStatus(),
            });
          });
          return response.status(200).json({ status: "display" });
        }
        await runtime.serialized(async () => {
          step("start");
          // Consume before signing: a timeout or failed pass must not start an
          // unbounded retry loop on the next five-second cron tick.
          consumedDemand = wake!;
          await saveCloudState("trading-consumed-at", wake!.at);
          await runtime.reloadCloudReadModel();
          const { refreshLivePrices } =
            await import("../apps/api/src/pyth-keeper.ts");
          const requested = runtime.manifest.series.filter((s) =>
            wake!.marketIds.includes(s.id),
          );
          const assetKeys = [...new Set(requested.map((s) => s.asset))];
          await refreshLivePrices(assetKeys);
          step("prices");
          const { runMakerCycle } =
            await import("../apps/api/src/maker-worker.ts");
          await runMakerCycle({ marketIds: requested.map((s) => s.id) });
          step("maker");
          // Funding a new book can take most of the immutable price window.
          // Refresh signed prices again before publishing the completed pass.
          await refreshLivePrices(assetKeys);
          await runtime.refresh();
          await runtime.persistCloudReadModel();
          step("persisted");
          await saveCloudState("worker-health", {
            status: "ready",
            service: runtime.current()?.service,
            chainId: runtime.manifest.chainId,
            mode: "trading",
            gasLow: false,
            lastSuccess: Date.now(),
            errors: runtime.workerErrors.slice(-5),
            signers: runtime.workerSignerStatus(),
          });
        });
        return response.status(200).json({ status: "complete" });
      } catch (error) {
        const previous =
          await loadCloudState<Record<string, unknown>>("worker-health");
        const secrets = Object.entries(process.env)
          .filter(([key]) => /KEY|TOKEN|PASSWORD|SECRET/.test(key))
          .map(([, value]) => value ?? "");
        await saveCloudState("worker-health", {
          ...previous,
          status: "failed",
          lastFailure: Date.now(),
          errors: [redactDiagnostic(error, secrets).split("\n")[0]],
        });
        throw error;
      } finally {
        try {
          if (consumedDemand)
            await saveCloudState("trading-completed-at", consumedDemand.at);
        } finally {
          await releaseWorker();
        }
      }
    }
    if (path === "/api/live")
      return response.status(404).json({ error: "Use HTTP polling" });
    await withReadOnlyState(async () => {
      const { app } = await initialize();
      await app.ready();
      let payload: Buffer | undefined;
      if (request.body !== undefined)
        payload = Buffer.from(
          typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body),
        );
      else if (request.method !== "GET" && request.method !== "HEAD") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 160000)
            return response
              .status(413)
              .json({ error: "Request exceeds the supported size." });
          chunks.push(Buffer.from(chunk));
        }
        payload = Buffer.concat(chunks);
      }
      // Serve through Node HTTP; Fastify inject() is a test facility whose cookie
      // dependency is incompatible with Vercel's ESM loader.
      const incoming = forwardedRequest(
        request,
        path + (route ? "" : url.search),
        payload,
      );
      // Public routes reject customer/server signing. Their reads and receipt
      // checks must not wait behind a full keeper/maker pass. Snapshot builds
      // already coalesce, and SQLite writes complete without yielding.
      await new Promise<void>((resolve, reject) => {
        response.once("finish", resolve);
        response.once("close", resolve);
        response.once("error", reject);
        incoming.once("error", reject);
        app.server.emit("request", incoming, response);
      });
    });
  } catch (error) {
    console.error(
      redactDiagnostic(
        error,
        Object.entries(process.env)
          .filter(([key]) => /KEY|TOKEN|PASSWORD|SECRET/.test(key))
          .map(([, value]) => value ?? ""),
      )
        .split("\n")
        .slice(0, 3)
        .join("\n"),
    );
    return response.status(503).json({
      error:
        "Testnet service temporarily unavailable. Check worker status in /api/health.",
    });
  }
}
