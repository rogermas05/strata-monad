import "dotenv/config";

const endpoint = `http://127.0.0.1:${Number(process.env.API_PORT ?? 3001)}/api`;
const healthResponse = await fetch(`${endpoint}/health`);
if (!healthResponse.ok) throw new Error("Local API is unavailable");
const health = await healthResponse.json();
if (health.chainId !== 31337 || !["local", "local-fork"].includes(health.mode))
  throw new Error(
    "Checkpoint restoration is restricted to the local environment",
  );
if (!health.localCheckpoint) {
  console.log("No active local checkpoint; no chain state changed.");
} else {
  const response = await fetch(`${endpoint}/demo/checkpoint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "restore",
      id: health.localCheckpoint.id,
    }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Checkpoint restoration failed");
  console.log(
    `Restored local checkpoint at block ${result.block}; background workers resumed.`,
  );
}
