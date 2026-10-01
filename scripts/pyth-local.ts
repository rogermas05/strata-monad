import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { artifact } from "./artifacts.ts";
import { executeLocalDeployment } from "./deployment-executor.ts";
import { prepareDeploymentPackage } from "../packages/core/src/deployment-package.ts";
import { parseDeploymentManifest } from "../packages/core/src/deployment-config.ts";
import { waitReceipt } from "../packages/core/src/receipts.ts";
import { fetchUpdate, type Evidence } from "../packages/core/src/hermes.ts";
import { pushedUpdateSource } from "../packages/core/src/pushed-updates.ts";
import {
  asset as registryAsset,
  weeklyExpiries,
  type OptionKind,
} from "../packages/core/src/index.ts";

/**
 * A second local stack on real Pyth prices: MON, BTC, ETH and gold on a fresh
 * fork of Monad testnet, next to the controlled-price deployment. MON's signed
 * updates are reused from the contract where they are already pushed; the other
 * feeds come from Hermes. Assets and collateral are test tokens.
 */
const RPC_PORT = Number(process.env.PYTH_STACK_RPC_PORT ?? 8547);
const API_PORT = process.env.PYTH_STACK_API_PORT ?? "3002";
const WEB_PORT = process.env.PYTH_STACK_WEB_PORT ?? "5174";
const DIRECTORY = resolve(".runtime/pyth");
const MANIFEST = resolve(DIRECTORY, "manifest.json");
const KURU_FACTORY = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
const KURU_MARGIN = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";
/** Where MON, BTC and ETH are already pushed on Monad testnet. */
const PUSHED_CONTRACT = getAddress(
  process.env.PYTH_PUSHED_CONTRACT ||
    "0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379",
);
const forkUrl = process.env.FORK_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const access = {
  endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
  apiKey: process.env.PYTH_API_KEY ?? "",
};
if (!access.apiKey)
  throw new Error("Configure PYTH_API_KEY in the ignored .env file");

// Strike offsets are in steps around spot. Cash-settled assets lean below spot:
// a deep in-the-money put can cost more than a book's price limit (about $4,295).
const LISTED = [
  {
    key: "MON",
    volatility: 0.9,
    weeks: 2,
    kinds: ["call", "put"],
    strikes: [-2, 2],
  },
  {
    key: "BTC",
    volatility: 0.5,
    weeks: 2,
    kinds: ["put", "bull-spread"],
    strikes: [-3, 1],
  },
  {
    key: "ETH",
    volatility: 0.65,
    weeks: 2,
    kinds: ["put", "bull-spread"],
    strikes: [-3, 1],
  },
  {
    key: "XAU",
    volatility: 0.16,
    weeks: 2,
    kinds: ["put", "bull-spread"],
    strikes: [-3, 1],
  },
] as const;
/** Strike spacing as a share of one week's expected move. */
const STRIKE_SPACING = 0.5;
const WEEK_IN_YEARS = 7 / 365;
const MIN_TIME_TO_EXPIRY = 3600;
const CALL_CAP = (100_000n * 10n ** 18n).toString();
const CASH_CAP = (1_000_000n * 10n ** 6n).toString();
const MAKER_USDC = 10_000_000n * 10n ** 6n;
const USER_USDC = 100_000n * 10n ** 6n;
const MAKER_WMON = 2_000n * 10n ** 18n;
const USER_WMON = 100n * 10n ** 18n;

const rpcUrl = `http://127.0.0.1:${RPC_PORT}`;
const chain = defineChain({
  id: 31337,
  name: "Local Monad fork (Pyth prices)",
  nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const transport = http(rpcUrl, { timeout: 30000, retryCount: 0 });
const client = createPublicClient({ chain, transport, pollingInterval: 100 });
const children: ChildProcess[] = [];
const stop = () => children.forEach((child) => child.kill("SIGTERM"));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stop();
    process.exit(0);
  });

/** The round step (1, 2, 2.5 or 5 times a power of ten) nearest half a weekly move. */
function strikeStep(spot: number, volatility: number) {
  const raw = spot * volatility * Math.sqrt(WEEK_IN_YEARS) * STRIKE_SPACING;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10]
    .map((unit) => unit * magnitude)
    .reduce((best, step) =>
      Math.abs(step - raw) < Math.abs(best - raw) ? step : best,
    );
}
const decimal = (value: number) => value.toFixed(8).replace(/\.?0+$/, "");
const spotOf = (e: Evidence) => Number(e.price) * 10 ** e.exponent;

async function online() {
  try {
    return (await client.getChainId()) === 31337;
  } catch {
    return false;
  }
}

async function deploy() {
  const source = createPublicClient({
    transport: http(forkUrl, { timeout: 20000 }),
  });
  const pushed = pushedUpdateSource(source, PUSHED_CONTRACT);
  const [deployer, maker, demoUser] = await createWalletClient({
    chain,
    transport,
  }).getAddresses();
  const now = Number((await client.getBlock()).timestamp);
  const series: Record<string, unknown>[] = [];
  const assets: Record<string, unknown>[] = [];
  for (const listing of LISTED) {
    const spec = registryAsset(listing.key);
    const latest =
      listing.key === "MON"
        ? await pushed(spec.pythFeedId)
        : await fetchUpdate(access, spec.pythFeedId);
    if (!latest) throw new Error(`No real price available for ${listing.key}`);
    const spot = spotOf(latest),
      step = strikeStep(spot, listing.volatility),
      centre = Math.round(spot / step) * step;
    if (listing.key !== "MON")
      assets.push({
        key: listing.key,
        reference: decimal(spot),
        volatility: listing.volatility,
      });
    const expiries = weeklyExpiries(spec, now, listing.weeks + 1)
      .filter((expiry) => expiry > now + MIN_TIME_TO_EXPIRY)
      .slice(0, listing.weeks);
    for (const expiry of expiries) {
      const date = new Date(expiry * 1000)
        .toISOString()
        .slice(5, 10)
        .replace("-", "");
      for (let i = listing.strikes[0]; i <= listing.strikes[1]; i++) {
        const strike = decimal(centre + i * step),
          upper = decimal(centre + (i + 1) * step);
        for (const kind of listing.kinds as readonly OptionKind[])
          series.push({
            symbol:
              kind === "bull-spread"
                ? `${listing.key}-${date}-${strike}/${upper}-BULL`
                : `${listing.key}-${date}-${strike}-${kind === "call" ? "C" : "P"}`,
            asset: listing.key,
            expiry,
            kind,
            strike,
            ...(kind === "bull-spread" ? { upperStrike: upper } : {}),
            cap: kind === "call" ? CALL_CAP : CASH_CAP,
          });
      }
    }
    console.log(
      `${listing.key} ${decimal(spot)}: strikes every ${decimal(step)}`,
    );
  }
  const intent = {
    version: 1,
    chainId: 31337,
    rpcUrl,
    deployer,
    maker,
    demoUser,
    factory: KURU_FACTORY,
    margin: KURU_MARGIN,
    oracle: { mode: "pyth", verifier: PUSHED_CONTRACT },
    feed: registryAsset("MON").pythFeedId,
    // Only interval updates exist for MON without a paid plan: settle on the last price.
    feedSettlement: "pyth-latest-before-close",
    maxPriceAge: 3600,
    assets,
    series,
  };
  // A journal from an earlier fork belongs to a different package.
  rmSync(resolve(DIRECTORY, "journal.json"), { force: true });
  const pkg = await prepareDeploymentPackage(client, intent, artifact);
  console.log(
    `Deploying ${series.length} markets in ${pkg.steps.length} transactions…`,
  );
  let shown = 0;
  await executeLocalDeployment(pkg, DIRECTORY, {
    progress: (message) => {
      if (++shown % 40 === 0) console.log(`  ${message}`);
    },
  });
  const manifest = parseDeploymentManifest(readFileSync(MANIFEST, "utf8"));

  // Test funds only: the maker issues and quotes from these once prices are live.
  const send = async (
    account: Address,
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
    value = 0n,
  ) => {
    const hash: Hex = await createWalletClient({
      account,
      chain,
      transport,
    }).writeContract({ address, abi, functionName, args, value });
    if ((await waitReceipt(client, hash)).status !== "success")
      throw new Error(`Reverted ${functionName}`);
  };
  const usdc = artifact("DemoUSDC").abi,
    wmon = artifact("WrappedMON").abi;
  for (const [account, dollars, wrapped] of [
    [maker, MAKER_USDC, MAKER_WMON],
    [demoUser, USER_USDC, USER_WMON],
  ] as const) {
    await send(deployer, manifest.usdc, usdc, "mint", [account, dollars]);
    await send(account, manifest.wmon, wmon, "deposit", [], wrapped);
  }
  writeFileSync(
    resolve(DIRECTORY, "maker-config.json"),
    JSON.stringify(
      {
        volatility: LISTED[0].volatility,
        spreadBps: 1200,
        // A fixed edge would exceed the whole premium of a cent-priced underlying.
        edge: 0,
        targetInventory: 90,
        maxWritten: 180,
      },
      null,
      2,
    ),
  );
  console.log(`Deployed. Engine ${manifest.engine}.`);
}

mkdirSync(DIRECTORY, { recursive: true });
if (!(await online())) {
  const log = openSync(resolve(DIRECTORY, "anvil.log"), "a");
  children.push(
    spawn(
      "anvil",
      [
        "--chain-id",
        "31337",
        "--host",
        "127.0.0.1",
        "--port",
        String(RPC_PORT),
        "--block-time",
        "1",
        "--silent",
        "--fork-url",
        forkUrl,
      ],
      { stdio: ["ignore", log, log] },
    ),
  );
  for (let i = 0; i < 120 && !(await online()); i++)
    await new Promise((r) => setTimeout(r, 500));
  if (!(await online())) {
    stop();
    throw new Error("Fork did not start; see .runtime/pyth/anvil.log");
  }
}
const deployed =
  existsSync(MANIFEST) &&
  !!(await client.getCode({
    address: parseDeploymentManifest(readFileSync(MANIFEST, "utf8")).engine,
  }));
if (!deployed)
  try {
    await deploy();
  } catch (error) {
    stop();
    throw new Error(
      (error instanceof Error ? error.message : String(error))
        .replace(/https?:\/\/[^\s"<>]+/gi, "[endpoint]")
        .slice(0, 1500),
    );
  }
console.log(
  `Real-price stack ready. Terminal: http://localhost:${WEB_PORT} (API ${API_PORT}, chain ${RPC_PORT}). Ctrl+C stops services started here.`,
);
const dev = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    MANIFEST_PATH: MANIFEST,
    API_PORT,
    WEB_PORT,
    PYTH_PUSHED_FEEDS: process.env.PYTH_PUSHED_FEEDS || "MON",
    PYTH_PUSHED_RPC_URL: process.env.PYTH_PUSHED_RPC_URL || forkUrl,
    PYTH_PUSHED_CONTRACT: PUSHED_CONTRACT,
  },
});
children.push(dev);
dev.on("exit", (code) => {
  stop();
  process.exit(code ?? 1);
});
