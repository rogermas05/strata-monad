import { timingSafeEqual, randomUUID } from "node:crypto";
import { forwardedRequest } from "../apps/api/src/node-request.ts";
import {
  cloudEnabled,
  loadCloudState,
  claimWorker,
  releaseWorker,
  saveCloudState,
} from "../apps/api/src/cloud-store.ts";
import { redactDiagnostic } from "../packages/core/src/deployment-config.ts";

process.env.STRATA_SERVERLESS = "1";
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
    if (path === "/api/snapshot" || path === "/api/health") {
      const saved = await loadCloudState<any>("public-snapshot");
      if (saved) {
        const age = Date.now() - saved.service.lastSuccessfulRefreshAt;
        const fresh = age >= 0 && age <= 15000;
        const worker = await loadCloudState<any>("worker-health");
        const service = {
          ...saved.service,
          evaluatedAt: Date.now(),
          ...(fresh
            ? {}
            : {
                status: "degraded",
                newExposureAllowed: false,
                reason:
                  "The confirmed worker view is stale. New exposure is paused.",
              }),
        };
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
        return response.status(200).json({
          ...saved,
          service,
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
    if (path === "/api/worker") {
      if (!(await claimWorker(randomUUID())))
        return response.status(202).json({ status: "already-running" });
      try {
        await initialize();
        const runtime = await import("../apps/api/src/runtime.ts");
        if (!runtime.publicWorkers)
          return response
            .status(503)
            .json({ error: "Public workers disabled" });
        await runtime.serialized(async () => {
          await runtime.reloadCloudReadModel();
          const { runPythPass } =
            await import("../apps/api/src/pyth-keeper.ts");
          await runPythPass();
          const snap = await runtime.refresh();
          const { runMakerCycle } =
            await import("../apps/api/src/maker-worker.ts");
          const cursor = (await loadCloudState<number>("maker-cursor")) ?? 0;
          const active = snap.markets.filter((m) => m.active && m.healthy);
          const chosen = active.length
            ? [active[cursor % active.length].id]
            : [];
          await runMakerCycle({ marketIds: chosen });
          await saveCloudState("maker-cursor", cursor + 1);
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
          await saveCloudState("worker-health", {
            status: "ready",
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
    const { app } = await initialize();
    const runtime = await import("../apps/api/src/runtime.ts");
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
    await runtime.serialized(
      () =>
        new Promise<void>((resolve, reject) => {
          response.once("finish", resolve);
          response.once("close", resolve);
          response.once("error", reject);
          incoming.once("error", reject);
          app.server.emit("request", incoming, response);
        }),
    );
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
