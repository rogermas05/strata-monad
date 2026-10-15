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
import { nextMakerMarket } from "../apps/api/src/maker-rotation.ts";

process.env.STRATA_SERVERLESS = "1";
/** On-chain trading stays awake this long after the last wake request. */
const AWAKE_MS = 10 * 60 * 1000;
/** Repeated wake requests inside this window are not rewritten. */
const WAKE_DEBOUNCE_MS = 60 * 1000;
/** Below this keeper balance the worker cannot relay prices, so it stays asleep. */
const KEEPER_MIN_WEI = 50_000_000_000_000_000n;
const IDLE_MAINTENANCE_MS = 30_000;
type Wake = { at: number };
const awakeUntil = (wake: Wake | undefined) => (wake ? wake.at + AWAKE_MS : 0);
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
        const wake = await loadCloudState<Wake>("trading-wake");
        return response.status(200).json({
          ...saved,
          service,
          trading: {
            mode: worker?.mode ?? "trading",
            awakeUntil: awakeUntil(wake),
            gasLow: worker?.gasLow ?? false,
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
      const wake = await loadCloudState<Wake>("trading-wake");
      if (!wake || Date.now() - wake.at > WAKE_DEBOUNCE_MS)
        await requestTradingWake();
      return response
        .status(202)
        .json({ awakeUntil: awakeUntil({ at: Date.now() }) });
    }
    if (path === "/api/worker") {
      if (!(await claimWorker(randomUUID())))
        return response.status(202).json({ status: "already-running" });
      try {
        const wake = await loadCloudState<Wake>("trading-wake");
        const previous = await loadCloudState<any>("worker-health");
        if (reuseIdlePass(Date.now(), awakeUntil(wake), previous))
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
        if (gasLow || Date.now() >= awakeUntil(wake)) {
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
          await runtime.reloadCloudReadModel();
          const { runPythPass } =
            await import("../apps/api/src/pyth-keeper.ts");
          await runPythPass();
          step("prices");
          const snap = await runtime.refresh();
          const { runMakerCycle } =
            await import("../apps/api/src/maker-worker.ts");
          const cursor = (await loadCloudState<number>("maker-cursor")) ?? 0;
          const chosen = nextMakerMarket(snap, cursor);
          await runMakerCycle({ marketIds: chosen ? [chosen.id] : [] });
          await saveCloudState("maker-cursor", cursor + 1);
          step("maker");
          if (runtime.manifest.house) {
            // One vault book per pass, after any launch or roll. A vault failure
            // must not stop the project maker's pass from being published.
            const { runHouseCycle } =
              await import("../apps/api/src/house-worker.ts");
            const house = (await runtime.refresh()).house;
            const live = (house?.series ?? []).filter((id) =>
              snap.markets.some((m) => m.id === id && m.active && m.healthy),
            );
            const houseCursor =
              (await loadCloudState<number>("house-cursor")) ?? 0;
            try {
              await runHouseCycle({
                marketIds: live.length
                  ? [live[houseCursor % live.length]]
                  : undefined,
              });
            } catch (error) {
              runtime.recordWorkerError(
                `House: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            await saveCloudState("house-cursor", houseCursor + 1);
            step("house");
          }
          // Funding a new book can take most of the immutable price window.
          // Refresh signed prices again before publishing the completed pass.
          await runPythPass();
          const { cleanupExpiredMaker } =
            await import("../packages/core/src/expiry-cleanup.ts");
          const fresh = await runtime.refresh();
          for (const m of fresh.markets
            .filter((m) => !m.active && m.settlementPrice)
            .slice(0, 2))
            await cleanupExpiredMaker(
              runtime.client,
              runtime.manifest,
              runtime.manifest.series.find((s) => s.id === m.id)!,
              m.orders
                .filter(
                  (o) =>
                    o.owner.toLowerCase() ===
                    runtime.manifest.maker.toLowerCase(),
                )
                .map((o) => BigInt(o.id)),
              (address, abi, name, args) =>
                runtime.send(runtime.manifest.maker, address, abi, name, args),
            );
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
        await releaseWorker();
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
