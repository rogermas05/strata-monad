import "dotenv/config";
import { credentialFreeRpc } from "../packages/core/src/deployment-config.ts";
import { waitReceipt } from "../packages/core/src/receipts.ts";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { artifact, exportAbis } from "./artifacts.ts";
import {
  priceOption,
  kinds,
  asset as registryAsset,
  weeklyExpiries,
  validateListing,
  type Manifest,
  type ManifestAsset,
  type SeriesConfig,
} from "../packages/core/src/index.ts";
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8546";
if (!credentialFreeRpc(rpcUrl))
  throw new Error("Local seeding requires a credential-free browser RPC URL");
const chain = defineChain({
  id: 31337,
  name: "Local Monad testnet fork",
  nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({
  chain,
  pollingInterval: 100,
  transport: http(rpcUrl),
});
if ((await publicClient.getChainId()) !== 31337)
  throw new Error("Local seeding is restricted to chain 31337");
const accounts = await createWalletClient({
  chain,
  transport: http(rpcUrl),
}).getAddresses();
const deployer = accounts[0],
  maker = accounts[1],
  demoUser = accounts[2];
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpcUrl))
  throw new Error("Local seeding requires a loopback RPC");
// Repeatable local fixtures: native-backed WMON must be funded, not arbitrarily minted.
for (const [account, minimum] of [
  [deployer, 100n],
  [maker, 2001n],
  [demoUser, 101n],
] as const) {
  if (
    (await publicClient.getBalance({ address: account })) <
    minimum * 10n ** 18n
  )
    await publicClient.request({
      method: "anvil_setBalance" as never,
      params: [account, `0x${(10000n * 10n ** 18n).toString(16)}`] as never,
    });
}
const wallet = (account: Address) =>
  createWalletClient({ account, chain, transport: http(rpcUrl) });
async function send(
  account: Address,
  address: Address,
  name: string,
  functionName: string,
  args: unknown[] = [],
  value = 0n,
) {
  const hash = await wallet(account).writeContract({
    address,
    abi: artifact(name).abi,
    functionName,
    args,
    value,
    gas: 12000000n,
  });
  const r = await waitReceipt(publicClient, hash);
  if (r.status !== "success")
    throw new Error(`Reverted ${name}.${functionName}: ${hash}`);
  return r;
}
async function deploy(name: string, args: unknown[] = []) {
  const a = artifact(name);
  const hash = await wallet(deployer).deployContract({
    ...a,
    args,
    gas: 14000000n,
  });
  const r = await waitReceipt(publicClient, hash);
  if (r.status !== "success" || !r.contractAddress)
    throw new Error(`Deployment failed ${name}`);
  return r.contractAddress;
}
const max = 2n ** 256n - 1n;
const venueMode = process.env.VENUE_MODE === "demo" ? "demo" : "kuru";
const factory: Address = "0x7EFbE105Ca7415dE98F96622173458ac1c054630",
  margin: Address = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";
if (venueMode === "kuru" && !(await publicClient.getCode({ address: factory })))
  throw new Error(
    "Start a Monad testnet fork or set VENUE_MODE=demo for original development books",
  );
console.log(`Deploying local ${venueMode} environment…`);
const deployedBlock = (await publicClient.getBlockNumber()).toString();
// Controlled prices behind the per-asset router: 24/7 crypto settles on the first
// observation after expiry; scheduled RWAs on the latest observation at the close.
const SESSION_LOOKBACK = 4 * 86400;
const LOCAL_CHALLENGE_WINDOW = 60;
const usdc = await deploy("DemoUSDC"),
  wmon = await deploy("WrappedMON"),
  cryptoOracle = await deploy("DemoOracle"),
  sessionOracle = await deploy("DemoSessionOracle", [
    SESSION_LOOKBACK,
    LOCAL_CHALLENGE_WINDOW,
  ]),
  oracle = await deploy("OracleRouter");
const monSpec = registryAsset("MON");
const assetId = monSpec.pythFeedId;
// Local RWA references are labelled controlled prices, not market data.
const rwaListings = [
  { key: "SPY", reference: 650, volatility: 0.18, weeks: 2, step: 25 },
  { key: "XAU", reference: 4000, volatility: 0.16, weeks: 1, step: 100 },
] as const;
const assets: ManifestAsset[] = [
  {
    key: "MON",
    name: monSpec.name,
    assetClass: "crypto",
    assetId,
    adapter: cryptoOracle,
    policy: monSpec.settlement,
    maxLiveAge: monSpec.maxLiveAge,
    challengeWindow: 0,
    schedule: monSpec.schedule,
    scheduleSnapshot: monSpec.scheduleSnapshot,
    volatility: 0.85,
    reference: 1.03,
    deliverable: true,
  },
  ...rwaListings.map(({ key, reference, volatility }) => {
    const spec = registryAsset(key);
    return {
      key,
      name: spec.name,
      assetClass: spec.assetClass,
      assetId: spec.pythFeedId,
      adapter: sessionOracle,
      policy: spec.settlement,
      maxLiveAge: spec.maxLiveAge,
      challengeWindow: LOCAL_CHALLENGE_WINDOW,
      schedule: spec.schedule,
      scheduleSnapshot: spec.scheduleSnapshot,
      volatility,
      reference,
      deliverable: false,
    } satisfies ManifestAsset;
  }),
];
for (const a of assets)
  await send(deployer, oracle, "OracleRouter", "bind", [
    a.assetId,
    a.adapter,
    a.maxLiveAge,
  ]);
await send(deployer, cryptoOracle, "DemoOracle", "publish", [
  assetId,
  103000000n,
]);
// Stands in for the last session close, so a market listed while closed still
// shows a reference. It is stale by the router's live age until the next open.
for (const a of assets.slice(1))
  await send(deployer, sessionOracle, "DemoSessionOracle", "publish", [
    a.assetId,
    BigInt(Math.round(a.reference * 1e8)),
  ]);
const engine = await deploy("OptionsEngine", [usdc, oracle, 3600]);
const router = await deploy("StrategyRouter", [engine]);
await send(deployer, engine, "OptionsEngine", "approveUnderlying", [
  wmon,
  true,
]);
for (const account of [maker, demoUser]) {
  await send(
    account,
    wmon,
    "WrappedMON",
    "deposit",
    [],
    account === maker ? 2000n * 10n ** 18n : 100n * 10n ** 18n,
  );
  await send(deployer, usdc, "DemoUSDC", "mint", [
    account,
    account === maker ? 10000000n * 10n ** 6n : 10000n * 10n ** 6n,
  ]);
  await send(account, wmon, "WrappedMON", "approve", [engine, max]);
  await send(account, usdc, "DemoUSDC", "approve", [engine, max]);
}
await send(maker, usdc, "DemoUSDC", "approve", [
  venueMode === "kuru" ? margin : router,
  max,
]);
const factoryAbi = parseAbi([
  "function deployProxy(uint8,address,address,uint96,uint32,uint32,uint96,uint96,uint256,uint256,uint96) returns (address)",
]);
const kuruAbi = parseAbi([
  "function addSellOrder(uint32,uint96,bool)",
  "function addBuyOrder(uint32,uint96,bool)",
]);
const marginAbi = parseAbi([
  "function deposit(address,address,uint256) payable",
]);
const now = Number((await publicClient.getBlock()).timestamp);
const expiries = [now + 86400, now + 7 * 86400, now + 28 * 86400];
const configs: SeriesConfig[] = [];
for (const expiry of expiries)
  for (const strike of [0.85, 0.95, 1.05, 1.15, 1.25])
    for (const kind of [0, 1]) {
      const id = configs.length + 1;
      const symbol = `MON-${new Date(expiry * 1000).toISOString().slice(5, 10).replace("-", "")}-${strike.toFixed(2)}-${kind === 0 ? "C" : "P"}`;
      await send(deployer, engine, "OptionsEngine", "createSeries", [
        wmon,
        assetId,
        expiry,
        kind,
        BigInt(Math.round(strike * 1e8)),
        0n,
        kind === 0 ? 100000n * 10n ** 18n : 1000000n * 10n ** 6n,
        symbol,
      ]);
      const s = (await publicClient.readContract({
        address: engine,
        abi: artifact("OptionsEngine").abi,
        functionName: "getSeries",
        args: [BigInt(id)],
      })) as { token: Address };
      await send(maker, engine, "OptionsEngine", "write", [
        BigInt(id),
        90n * 10n ** 18n,
        maker,
      ]);
      let market: Address, venue: Address;
      if (venueMode === "demo") {
        market = await deploy("DemoOrderBook", [s.token, usdc, expiry]);
        venue = market;
      } else {
        const args = [
          0,
          s.token,
          usdc,
          1000n,
          1000000,
          1,
          1n,
          1000000000n,
          0n,
          0n,
          100n,
        ] as const;
        const simulation = await publicClient.simulateContract({
          address: factory,
          abi: factoryAbi,
          functionName: "deployProxy",
          args,
          account: deployer,
        });
        market = simulation.result;
        const hash = await wallet(deployer).writeContract({
          ...simulation.request,
          gas: 12000000n,
        });
        const receipt = await waitReceipt(publicClient, hash);
        if (receipt.status !== "success")
          throw new Error("Kuru market deployment reverted");
        venue = await deploy("KuruExactAdapter", [market, margin, expiry]);
      }
      await send(deployer, router, "StrategyRouter", "register", [
        BigInt(id),
        venue,
      ]);
      await send(maker, s.token, "OptionToken", "approve", [
        venueMode === "kuru" ? margin : market,
        max,
      ]);
      if (venueMode === "kuru") {
        for (const [token, amount] of [
          [s.token, 90n * 10n ** 18n],
          [usdc, 1000n * 10n ** 6n],
        ] as const) {
          const h = await wallet(maker).writeContract({
            address: margin,
            abi: marginAbi,
            functionName: "deposit",
            args: [maker, token, amount],
            gas: 2000000n,
          });
          await waitReceipt(publicClient, h);
        }
      } else await send(maker, usdc, "DemoUSDC", "approve", [market, max]);
      const mark = priceOption(
        kinds[kind],
        1.03,
        strike,
        0,
        (expiry - now) / 31536000,
        0.85,
      ).price;
      for (let level = 0; level < 3; level++) {
        const bid = Math.max(
          1,
          Math.round(
            Math.max(mark * 0.88 - 0.001 - level * 0.003, 0.000001) * 1e6,
          ),
        );
        const ask = Math.max(
          bid + 1,
          Math.round((mark * 1.12 + 0.001 + level * 0.003) * 1e6),
        );
        const qty = [10n, 25n, 55n][level];
        for (const isBuy of [false, true]) {
          if (venueMode === "demo")
            await send(maker, market, "DemoOrderBook", "place", [
              isBuy,
              isBuy ? BigInt(bid) : BigInt(ask),
              qty * 10n ** 18n,
            ]);
          else {
            const h = await wallet(maker).writeContract({
              address: market,
              abi: kuruAbi,
              functionName: isBuy ? "addBuyOrder" : "addSellOrder",
              args: [isBuy ? bid : ask, qty * 1000n, true],
              gas: 4000000n,
            });
            const r = await waitReceipt(publicClient, h);
            if (r.status !== "success") throw new Error("Quote reverted");
          }
        }
      }
      configs.push({
        id,
        token: s.token,
        market,
        venue,
        symbol,
        expiry,
        strike,
        upperStrike: 0,
        kind: kinds[kind],
        asset: "MON",
      });
      console.log(`  ${id}/30 ${symbol}`);
    }
// A short-lived instrument allows genuine expiry/claim demonstrations without advancing other markets.
const quickExpiry = Number((await publicClient.getBlock()).timestamp) + 300;
await send(deployer, cryptoOracle, "DemoOracle", "publish", [
  assetId,
  103000000n,
]);
for (const cappedExpiry of [expiries[1], quickExpiry])
  for (const kind of [2, 3]) {
    const id = configs.length + 1,
      symbol = `MON-${cappedExpiry === quickExpiry ? "DEMO" : new Date(cappedExpiry * 1000).toISOString().slice(5, 10).replace("-", "")}-1.00/1.20-${kind === 2 ? "BULL" : "BEAR"}`;
    await send(deployer, engine, "OptionsEngine", "createSeries", [
      wmon,
      assetId,
      cappedExpiry,
      kind,
      100000000n,
      120000000n,
      1000000n * 10n ** 6n,
      symbol,
    ]);
    const s = (await publicClient.readContract({
      address: engine,
      abi: artifact("OptionsEngine").abi,
      functionName: "getSeries",
      args: [BigInt(id)],
    })) as { token: Address };
    await send(maker, engine, "OptionsEngine", "write", [
      BigInt(id),
      100n * 10n ** 18n,
      maker,
    ]);
    // Bounded instruments use the same venue adapter selection as vanilla markets.
    let market: Address, venue: Address;
    if (venueMode === "demo") {
      market = await deploy("DemoOrderBook", [s.token, usdc, cappedExpiry]);
      venue = market;
    } else {
      const simulation = await publicClient.simulateContract({
        address: factory,
        abi: factoryAbi,
        functionName: "deployProxy",
        args: [
          0,
          s.token,
          usdc,
          1000n,
          1000000,
          1,
          1n,
          1000000000n,
          0n,
          0n,
          100n,
        ],
        account: deployer,
      });
      market = simulation.result;
      await waitReceipt(
        publicClient,
        await wallet(deployer).writeContract({
          ...simulation.request,
          gas: 12000000n,
        }),
      );
      venue = await deploy("KuruExactAdapter", [market, margin, cappedExpiry]);
    }
    await send(deployer, router, "StrategyRouter", "register", [
      BigInt(id),
      venue,
    ]);
    await send(maker, s.token, "OptionToken", "approve", [
      venueMode === "kuru" ? margin : market,
      max,
    ]);
    if (venueMode === "kuru") {
      await waitReceipt(
        publicClient,
        await wallet(maker).writeContract({
          address: margin,
          abi: marginAbi,
          functionName: "deposit",
          args: [maker, s.token, 100n * 10n ** 18n],
          gas: 2000000n,
        }),
      );
      await waitReceipt(
        publicClient,
        await wallet(maker).writeContract({
          address: margin,
          abi: marginAbi,
          functionName: "deposit",
          args: [maker, usdc, 1000n * 10n ** 6n],
          gas: 2000000n,
        }),
      );
      for (const isBuy of [false, true])
        await waitReceipt(
          publicClient,
          await wallet(maker).writeContract({
            address: market,
            abi: kuruAbi,
            functionName: isBuy ? "addBuyOrder" : "addSellOrder",
            args: [isBuy ? 50000 : 80000, 100000n, true],
            gas: 4000000n,
          }),
        );
    } else {
      await send(maker, usdc, "DemoUSDC", "approve", [market, max]);
      for (const isBuy of [false, true])
        await send(maker, market, "DemoOrderBook", "place", [
          isBuy,
          isBuy ? 50000n : 80000n,
          100n * 10n ** 18n,
        ]);
    }
    configs.push({
      id,
      token: s.token,
      market,
      venue,
      symbol,
      expiry: cappedExpiry,
      strike: 1,
      upperStrike: 1.2,
      kind: kinds[kind],
      asset: "MON",
    });
  }
// Scheduled RWAs: cash-settled puts and capped calls (bull spreads) expiring at
// each week's last session close. No inventory is written here: the maker
// issues and quotes when the session opens and the controlled price is live.
async function kuruBook(token: Address, expiry: number) {
  if (venueMode === "demo") {
    const market = await deploy("DemoOrderBook", [token, usdc, expiry]);
    return { market, venue: market };
  }
  const simulation = await publicClient.simulateContract({
    address: factory,
    abi: factoryAbi,
    functionName: "deployProxy",
    args: [0, token, usdc, 1000n, 1000000, 1, 1n, 1000000000n, 0n, 0n, 100n],
    account: deployer,
  });
  const receipt = await waitReceipt(
    publicClient,
    await wallet(deployer).writeContract({
      ...simulation.request,
      gas: 12000000n,
    }),
  );
  if (receipt.status !== "success")
    throw new Error("Kuru market deployment reverted");
  const venue = await deploy("KuruExactAdapter", [
    simulation.result,
    margin,
    expiry,
  ]);
  return { market: simulation.result, venue };
}
for (const listing of rwaListings) {
  const spec = registryAsset(listing.key);
  for (const expiry of weeklyExpiries(spec, now, listing.weeks))
    for (let i = -2; i <= 2; i++) {
      const strike = listing.reference + i * listing.step;
      for (const kind of [1, 2] as const) {
        const id = configs.length + 1;
        const upper = kind === 2 ? strike + listing.step : 0;
        const date = new Date(expiry * 1000)
          .toISOString()
          .slice(5, 10)
          .replace("-", "");
        const symbol =
          kind === 1
            ? `${listing.key}-${date}-${strike}-P`
            : `${listing.key}-${date}-${strike}/${upper}-BULL`;
        // Candidates are listed locally only, under the same rules as a real listing.
        validateListing(
          {
            asset: listing.key,
            kind: kinds[kind],
            expiry,
            strike,
            upperStrike: upper || undefined,
          },
          now,
          { allowCandidates: true },
        );
        await send(deployer, engine, "OptionsEngine", "createSeries", [
          "0x0000000000000000000000000000000000000000",
          spec.pythFeedId,
          expiry,
          kind,
          BigInt(Math.round(strike * 1e8)),
          BigInt(Math.round(upper * 1e8)),
          100000000n * 10n ** 6n,
          symbol,
        ]);
        const s = (await publicClient.readContract({
          address: engine,
          abi: artifact("OptionsEngine").abi,
          functionName: "getSeries",
          args: [BigInt(id)],
        })) as { token: Address };
        const { market, venue } = await kuruBook(s.token, expiry);
        await send(deployer, router, "StrategyRouter", "register", [
          BigInt(id),
          venue,
        ]);
        configs.push({
          id,
          token: s.token,
          market,
          venue,
          symbol,
          expiry,
          strike,
          upperStrike: upper,
          kind: kinds[kind],
          asset: listing.key,
        });
        console.log(`  ${id} ${symbol}`);
      }
    }
}
const manifest: Manifest = {
  chainId: 31337,
  rpcUrl,
  mode: venueMode === "kuru" ? "local-fork" : "local",
  venueMode,
  engine,
  oracle,
  router,
  usdc,
  wmon,
  assetId,
  deployer,
  maker,
  demoUser,
  deployedBlock,
  createdAt: new Date().toISOString(),
  series: configs,
  oracleMode: "demo",
  assets,
  ...(venueMode === "kuru" ? { kuruMargin: margin, kuruFactory: factory } : {}),
};
// MANIFEST_PATH lets an isolated stack seed without replacing the default manifest.
const manifestPath = process.env.MANIFEST_PATH ?? ".runtime/manifest.json";
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
exportAbis();
console.log(
  `Local deployment complete. ${configs.length} instruments across ${assets.map((a) => a.key).join(", ")}. Start npm run dev.`,
);
