import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, openSync } from "node:fs";
import { createPublicClient, http } from "viem";
import type { Manifest } from "../packages/core/src/index.ts";

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc))
  throw new Error("local:up requires a loopback RPC URL");
mkdirSync(".runtime", { recursive: true });
const children: ChildProcess[] = [];
function stop() {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
async function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    children.push(child);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
const client = createPublicClient({
  transport: http(rpc, { timeout: 3000, retryCount: 0 }),
});
let online = false;
let existingChainId: number | undefined;
try {
  existingChainId = await client.getChainId();
  online = true;
} catch {}
if (online && existingChainId !== 31337)
  throw new Error(
    `RPC already serves chain ${existingChainId}; local:up requires chain 31337`,
  );
if (!online) {
  const args = [
    "--chain-id",
    "31337",
    "--host",
    "127.0.0.1",
    "--port",
    new URL(rpc).port,
    "--block-time",
    "1",
    "--silent",
  ];
  if (process.env.VENUE_MODE !== "demo")
    args.push(
      "--fork-url",
      process.env.FORK_RPC_URL ?? "https://testnet-rpc.monad.xyz",
    );
  const log = openSync(".runtime/anvil.log", "a");
  const chain = spawn("anvil", args, { stdio: ["ignore", log, log] });
  children.push(chain);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await client.getChainId()) === 31337;
      if (ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    stop();
    throw new Error(
      "Chain did not start. See .runtime/anvil.log and ensure Anvil is installed.",
    );
  }
}
if ((await client.getChainId()) !== 31337) {
  stop();
  throw new Error("Connected RPC is not a local chain");
}
await run("npm", ["run", "contracts:build"]);
let seeded = false;
if (existsSync(".runtime/manifest.json")) {
  const manifest = JSON.parse(
    readFileSync(".runtime/manifest.json", "utf8"),
  ) as Manifest;
  seeded =
    manifest.rpcUrl === rpc &&
    !!(await client.getCode({ address: manifest.engine }));
}
if (!seeded) await run("npm", ["run", "local:seed"]);
console.log(
  `Local protocol ready. Terminal: http://localhost:${process.env.WEB_PORT ?? 5173}. Ctrl+C stops services started here.`,
);
const dev = spawn("npm", ["run", "dev"], { stdio: "inherit" });
children.push(dev);
dev.on("exit", (code) => {
  stop();
  process.exit(code ?? 1);
});
