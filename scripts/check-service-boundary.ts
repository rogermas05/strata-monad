import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  parseDeploymentManifest,
  loopbackRpc,
} from "../packages/core/src/deployment-config.ts";
const manifest = parseDeploymentManifest(
  readFileSync(".runtime/manifest.json", "utf8"),
);
if (manifest.chainId !== 31337 || !loopbackRpc(manifest.rpcUrl))
  throw new Error("Service boundary drill requires a local deployment");
const marker = "local-drill-credential-marker";
let calls = 0,
  credentialAccepted = true,
  fail = false;
const proxy = createServer(async (req, res) => {
  credentialAccepted &&=
    new URL(req.url!, "http://localhost").searchParams.get("token") === marker;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  calls++;
  res.setHeader("content-type", "application/json");
  if (fail) {
    const payload = JSON.parse(body);
    const error = (r: any) => ({
      jsonrpc: "2.0",
      id: r.id,
      error: { code: -32000, message: `provider error ${marker}` },
    });
    return res.end(
      JSON.stringify(
        Array.isArray(payload) ? payload.map(error) : error(payload),
      ),
    );
  }
  try {
    const upstream = await fetch(manifest.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    res.end(await upstream.text());
  } catch {
    res.statusCode = 503;
    res.end("{}");
  }
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const port = (proxy.address() as any).port;
const privateRpc = `http://127.0.0.1:${port}?token=${marker}`;
let logs = "";
let apiUrl = "";
const api = spawn(
  process.execPath,
  ["--import", "tsx", "apps/api/src/server.ts"],
  {
    env: {
      ...process.env,
      SERVICE_RPC_URL: privateRpc,
      API_READ_ONLY: "1",
      API_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
api.stdout.on("data", (b) => {
  logs += b;
  apiUrl ||=
    logs.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? "";
});
api.stderr.on("data", (b) => (logs += b));
const check = (value: boolean, reason: string) => {
  if (!value) throw new Error(reason);
};
try {
  let health: any;
  for (let i = 0; i < 60; i++) {
    try {
      if (apiUrl) {
        const r = await fetch(`${apiUrl}/api/health`);
        health = await r.json();
        if (health.ok) break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  check(
    health?.ok && health.serverSigningEnabled === false,
    "Observer service did not become ready without signing",
  );
  const snapshot = await (await fetch(`${apiUrl}/api/snapshot`)).text();
  check(
    !snapshot.includes(marker) && !snapshot.includes(privateRpc),
    "Private endpoint reached the snapshot",
  );
  check(
    JSON.parse(snapshot).manifest.rpcUrl === manifest.rpcUrl,
    "Browser RPC was replaced with the service endpoint",
  );
  const denied = await fetch(`${apiUrl}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "faucet" }),
  });
  check(denied.status === 403, "Observer service allowed an unlocked action");
  fail = true;
  let degraded: any;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 250));
    degraded = await (await fetch(`${apiUrl}/api/health`)).json();
    if (!degraded.ok) break;
  }
  check(
    degraded?.ok === false,
    "Transport failure did not degrade observer readiness",
  );
  const stale = await (await fetch(`${apiUrl}/api/snapshot`)).text();
  check(
    !stale.includes(marker) && !logs.includes(marker),
    "Credential marker reached diagnostics or logs",
  );
  check(
    calls > 0 && credentialAccepted,
    "Service did not use the private transport",
  );
  fail = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 250));
    health = await (await fetch(`${apiUrl}/api/health`)).json();
    if (health.ok) break;
  }
  check(health.ok, "Observer did not recover");
  fail = true;
  let startupLogs = "";
  const failedStartup = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/src/server.ts"],
    {
      env: {
        ...process.env,
        SERVICE_RPC_URL: privateRpc,
        API_READ_ONLY: "1",
        API_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  failedStartup.stdout.on("data", (b) => (startupLogs += b));
  failedStartup.stderr.on("data", (b) => (startupLogs += b));
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      failedStartup.kill("SIGTERM");
      reject(new Error("Startup failure probe did not exit"));
    }, 15000);
    failedStartup.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    failedStartup.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  check(
    code !== 0 && !startupLogs.includes(marker),
    "Failed startup leaked credentials or became active",
  );
  const result = {
    privateServiceTransportUsed: true,
    browserManifestUnchanged: true,
    unlockedActionsDenied: true,
    transportFailureDetected: true,
    credentialFreeSnapshotsAndLogs: true,
    startupFailureSanitized: true,
    recovered: true,
    rpcCalls: calls,
  };
  writeFileSync(
    ".runtime/service-rpc-drill.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  api.kill("SIGTERM");
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
