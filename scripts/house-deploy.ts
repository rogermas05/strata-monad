import "dotenv/config";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
} from "viem";
import { artifact } from "./artifacts.ts";
import { waitReceipt } from "../packages/core/src/receipts.ts";
import {
  loopbackRpc,
  parseDeploymentManifest,
} from "../packages/core/src/deployment-config.ts";

/**
 * Adds the house vault, STRATA, staking and the points distributor to an
 * existing local deployment. Never targets a public network. Restart the API
 * afterwards so it loads the updated manifest.
 */
const manifestPath = resolve(
  process.env.MANIFEST_PATH ?? ".runtime/manifest.json",
);
const manifest = parseDeploymentManifest(readFileSync(manifestPath, "utf8"));
if (
  manifest.chainId !== 31337 ||
  !loopbackRpc(manifest.rpcUrl) ||
  manifest.venueMode !== "kuru" ||
  !manifest.kuruMargin
)
  throw new Error("House deployment is limited to local Kuru-fork manifests");
if (manifest.house && process.env.HOUSE_REDEPLOY !== "1")
  throw new Error(
    "This manifest already has a house vault; set HOUSE_REDEPLOY=1 to replace it",
  );
const LAUNCH_IN = Number(process.env.HOUSE_LAUNCH_IN ?? 1800);
const COOLDOWN = Number(process.env.STRATA_COOLDOWN ?? 86400);
const PERFORMANCE_FEE_BPS = 1000;
const DEPOSIT_CAP = 1_000_000n * 10n ** 6n;
if (!Number.isSafeInteger(LAUNCH_IN) || LAUNCH_IN < 0)
  throw new Error("HOUSE_LAUNCH_IN must be a non-negative number of seconds");

const chain = defineChain({
  id: 31337,
  name: "Local Monad fork",
  nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [manifest.rpcUrl] } },
});
const client = createPublicClient({
  chain,
  pollingInterval: 100,
  transport: http(manifest.rpcUrl),
});
if ((await client.getChainId()) !== 31337)
  throw new Error("Connected RPC is not the local chain");
if (!(await client.getCode({ address: manifest.engine })))
  throw new Error("The manifest's engine is not deployed on this chain");
const deployer = manifest.deployer;
const wallet = createWalletClient({
  account: deployer,
  chain,
  transport: http(manifest.rpcUrl),
});

async function deploy(name: string, args: unknown[]) {
  const hash = await wallet.deployContract({
    ...artifact(name),
    args,
    gas: 14_000_000n,
  });
  const receipt = await waitReceipt(client, hash);
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error(`Deployment failed: ${name}`);
  return receipt.contractAddress;
}
async function call(
  name: string,
  address: Address,
  functionName: string,
  args: unknown[],
) {
  const hash = await wallet.writeContract({
    address,
    abi: artifact(name).abi,
    functionName,
    args,
    gas: 2_000_000n,
  });
  if ((await waitReceipt(client, hash)).status !== "success")
    throw new Error(`Reverted ${name}.${functionName}`);
}

const block = await client.getBlock();
const now = Number(block.timestamp);
const strata = await deploy("StrataToken", []);
const staking = await deploy("StrataStaking", [
  strata,
  manifest.usdc,
  BigInt(COOLDOWN),
]);
const distributor = await deploy("StrataDistributor", [
  strata,
  staking,
  manifest.maker,
]);
const vault = await deploy("HouseVault", [
  manifest.engine,
  manifest.router,
  manifest.kuruMargin,
  manifest.maker,
  staking,
  PERFORMANCE_FEE_BPS,
  DEPOSIT_CAP,
  BigInt(now + LAUNCH_IN),
]);
await call("StrataToken", strata, "setMinter", [distributor, true]);
await call("StrataToken", strata, "setTransferAllowed", [staking, true]);
await call("StrataToken", strata, "setTransferAllowed", [distributor, true]);

const next = {
  ...manifest,
  house: {
    vault,
    strata,
    staking,
    distributor,
    operator: manifest.maker,
    launchTime: now + LAUNCH_IN,
    genesisStart: now,
    deployedBlock: block.number.toString(),
  },
};
parseDeploymentManifest(JSON.stringify(next));
const temporary = `${manifestPath}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify(next, null, 2));
renameSync(temporary, manifestPath);
console.log(
  `House vault ${vault} deployed. Genesis deposits open now; launch at ${new Date(
    (now + LAUNCH_IN) * 1000,
  ).toISOString()} chain time. Restart the API to load it.`,
);
