import "dotenv/config";
import {
  createPublicClient,
  http,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { asset, weeklyExpiries } from "../packages/core/src/assets.ts";
import { fetchUpdate, type Evidence } from "../packages/core/src/hermes.ts";
import { pushedUpdateSource } from "../packages/core/src/pushed-updates.ts";
import {
  prepareDeploymentPackage,
  type DeploymentIntent,
} from "../packages/core/src/deployment-package.ts";
import { artifact } from "./artifacts.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";

const rpcUrl = "https://testnet-rpc.monad.xyz";
const verifier = "0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379" as Address;
const directory = ".runtime/testnet";
async function main() {
  const client = createPublicClient({
    transport: http(process.env.SERVICE_RPC_URL || rpcUrl, {
      timeout: 15000,
      retryCount: 0,
    }),
  });
  if ((await client.getChainId()) !== 10143)
    throw new Error("Testnet RPC chain mismatch");
  const deployer = process.env.STRATA_DEPLOYER_ADDRESS as Address;
  const maker = process.env.STRATA_MAKER_ADDRESS as Address;
  if (!deployer || !maker)
    throw new Error("Configure deployment and maker addresses");
  const now = Number((await client.getBlock()).timestamp);
  const source = pushedUpdateSource(client, verifier);
  const access = {
    endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
    apiKey: process.env.PYTH_API_KEY ?? "",
  };
  const observations: { key: string; evidence: Evidence }[] = [];
  for (const key of ["MON", "BTC", "ETH", "XAU"]) {
    const evidence =
      key === "MON"
        ? await source(asset(key).pythFeedId)
        : await fetchUpdate(access, asset(key).pythFeedId);
    if (!evidence) throw new Error(`${key} signed evidence unavailable`);
    observations.push({ key, evidence });
  }
  const spot = (key: string) => {
    const e = observations.find((o) => o.key === key)!.evidence;
    return Number(e.price) * 10 ** e.exponent;
  };
  const series: DeploymentIntent["series"] = [];
  const list = (
    key: string,
    kind: DeploymentIntent["series"][number]["kind"],
    strike: number,
    upper?: number,
    expiry?: number,
    demo = false,
  ) => {
    const time =
      expiry ?? weeklyExpiries(asset(key), now, 2).find((e) => e > now + 3600)!;
    const date = new Date(time * 1000)
      .toISOString()
      .slice(5, 10)
      .replace("-", "");
    const decimal = (n: number) =>
      n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    series.push({
      asset: key,
      expiry: time,
      kind,
      strike: decimal(strike),
      ...(upper ? { upperStrike: decimal(upper) } : {}),
      symbol: `${key}-${demo ? "DEMO-" : ""}${date}-${decimal(strike)}${upper ? `/${decimal(upper)}` : ""}-${kind === "call" ? "C" : kind === "put" ? "P" : "BULL"}`,
      cap:
        kind === "call"
          ? String(1000n * 10n ** 18n)
          : String(100000n * 10n ** 6n),
    });
  };
  const monStep = Math.max(0.0001, Number((spot("MON") * 0.08).toPrecision(1)));
  const monCentre = Math.round(spot("MON") / monStep) * monStep;
  for (const strike of [monCentre - monStep, monCentre + monStep]) {
    list("MON", "call", strike);
    list("MON", "put", strike);
  }
  list("MON", "put", monCentre * 1.04, undefined, now + 1200, true);
  const btc = Math.floor(spot("BTC") / 1000) * 1000;
  list("BTC", "bull-spread", btc, btc + 1000);
  const eth = Math.floor(spot("ETH") / 100) * 100;
  list("ETH", "put", eth);
  list("ETH", "bull-spread", eth, eth + 100);
  const gold = Math.floor(spot("XAU") / 50) * 50;
  list("XAU", "put", gold);
  list("XAU", "bull-spread", gold, gold + 50);
  const intent: DeploymentIntent = {
    version: 1,
    chainId: 10143,
    rpcUrl,
    deployer,
    maker,
    demoUser: deployer,
    factory: "0x7EFbE105Ca7415dE98F96622173458ac1c054630",
    margin: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02",
    oracle: { mode: "pyth", verifier },
    feed: asset("MON").pythFeedId,
    feedSettlement: "pyth-latest-before-close",
    maxPriceAge: 60,
    session: { lookback: 3600, challengeWindow: 300 },
    assets: ["BTC", "ETH", "XAU"].map((key) => ({
      key,
      reference: spot(key).toFixed(8).replace(/0+$/, "").replace(/\.$/, ""),
      volatility: key === "BTC" ? 0.5 : key === "ETH" ? 0.65 : 0.16,
    })),
    admissions: observations.map(({ key, evidence }) => ({
      key,
      publishTime: evidence.publishTime,
      price: evidence.price,
      confidence: evidence.confidence,
      exponent: evidence.exponent,
      updates: evidence.updates,
    })),
    series,
  };
  const pkg = await prepareDeploymentPackage(client, intent, artifact);
  writeDeploymentJson(`${directory}/intent.json`, intent);
  writeDeploymentJson(`${directory}/package.json`, pkg);
  console.log(
    JSON.stringify({
      unsigned: true,
      authenticatedAdmissions: observations.map((o) => o.key),
      markets: series.length,
      steps: pkg.steps.length,
      deploymentBalance: formatEther(
        await client.getBalance({ address: deployer }),
      ),
      makerBalance: formatEther(await client.getBalance({ address: maker })),
      demonstrationExpiry: series.find((s) => s.symbol.includes("DEMO"))!
        .expiry,
      packagePath: `${directory}/package.json`,
    }),
  );
}
main().catch(() => {
  console.error(
    "Testnet preparation failed; no secrets printed. Check feed access, configuration and verifier admission.",
  );
  process.exitCode = 1;
});
