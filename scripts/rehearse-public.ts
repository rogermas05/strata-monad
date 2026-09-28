import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, openSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  formatEther,
  parseGwei,
  parseEther,
  type Address,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { prepareDeploymentPackage } from "../packages/core/src/deployment-package.ts";
import { prepareMakerBootstrap } from "../packages/core/src/maker-bootstrap.ts";
import { pythAbi } from "../packages/core/src/pyth.ts";
import { pushedUpdateSource } from "../packages/core/src/pushed-updates.ts";
import { ManagedSigner } from "./lib/managed-signer.ts";
import {
  executeSignedPackage,
  reviewedStepAuthorizer,
} from "./signed-executor.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
import { artifact } from "./artifacts.ts";

const directory = `.runtime/public-rehearsals/${Date.now()}`;
mkdirSync(directory, { recursive: true });
const reserve = createServer();
await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
const port = (reserve.address() as { port: number }).port;
await new Promise<void>((r) => reserve.close(() => r()));
const rpcUrl = `http://127.0.0.1:${port}`;
const log = openSync(`${directory}/anvil.log`, "a");
const child = spawn(
  "anvil",
  [
    "--chain-id",
    "31337",
    "--fork-url",
    "https://testnet-rpc.monad.xyz",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--silent",
  ],
  { stdio: ["ignore", log, log] },
);
const chain = defineChain({
  id: 31337,
  name: "Isolated public execution rehearsal",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 15000, retryCount: 0 }),
  pollingInterval: 100,
});
const testMnemonic =
  "test test test test test test test test test test test junk";
const deployer = mnemonicToAccount(testMnemonic, { addressIndex: 0 }),
  maker = mnemonicToAccount(testMnemonic, { addressIndex: 1 });
const signer = (
  account: typeof deployer,
  authorize: (
    intent: import("./lib/managed-signer.ts").SignerIntent,
  ) => Promise<void>,
) =>
  new ManagedSigner({
    account,
    expectedAddress: account.address,
    chain,
    client,
    endpoint: rpcUrl,
    directory,
    maxGas: 16000000n,
    maxFeePerGas: parseGwei("300"),
    maxNativeValue: parseEther("25"),
    maxTransactionCost: parseEther("30"),
    authorize,
  });
try {
  let online = false;
  for (let i = 0; i < 90; i++) {
    try {
      await client.getChainId();
      online = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!online) throw new Error("Isolated rehearsal node did not start");
  const input = JSON.parse(
    readFileSync(".runtime/testnet/intent.json", "utf8"),
  );
  const pkg = await prepareDeploymentPackage(
    client,
    {
      ...input,
      chainId: 31337,
      rpcUrl,
      deployer: deployer.address,
      maker: maker.address,
      demoUser: deployer.address,
    },
    artifact,
  );
  const before = await client.getBalance({ address: deployer.address });
  const deploymentSigner = signer(deployer, reviewedStepAuthorizer(pkg.steps));
  try {
    await executeSignedPackage(pkg, directory, deploymentSigner);
    await executeSignedPackage(pkg, directory, deploymentSigner);
  } finally {
    deploymentSigner.close();
  }
  const deploymentGasMON = formatEther(
    before - (await client.getBalance({ address: deployer.address })),
  );
  const source = pushedUpdateSource(
    createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") }),
    input.oracle.verifier,
  );
  const update = await source(pkg.manifest.assetId);
  if (!update) throw new Error("Fresh genuine MON proof unavailable");
  const wallet = createWalletClient({
    account: deployer,
    chain,
    transport: http(rpcUrl),
  });
  const hash = await wallet.writeContract({
    address: input.oracle.verifier as Address,
    abi: pythAbi,
    functionName: "updatePriceFeeds",
    args: [update.updates],
    value: 0n,
  });
  await client.waitForTransactionReceipt({ hash });
  const bootstrap = await prepareMakerBootstrap(client, pkg.manifest, 1);
  const makerBefore = await client.getBalance({ address: maker.address });
  const makerSigner = signer(maker, reviewedStepAuthorizer(bootstrap.steps));
  try {
    await executeSignedPackage(bootstrap, directory, makerSigner);
    await executeSignedPackage(bootstrap, directory, makerSigner);
  } finally {
    makerSigner.close();
  }
  const makerNativeSpent = formatEther(
    makerBefore - (await client.getBalance({ address: maker.address })),
  );
  const report = {
    passed: true,
    isolatedFork: true,
    publicTransactions: false,
    keys: "Anvil public development mnemonic only",
    deploymentGasMON,
    makerNativeSpent,
    wrappedMON: formatEther(BigInt(bootstrap.funding.nativeWrap)),
    deploymentTransactions: pkg.steps.length,
    bootstrapTransactions: bootstrap.steps.length,
    exactHashReplay: true,
  };
  writeDeploymentJson(`${directory}/rehearsal.json`, report);
  console.log(JSON.stringify({ ...report, directory }));
} finally {
  child.kill("SIGTERM");
}
