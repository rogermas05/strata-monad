import { config } from "dotenv";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  encodeFunctionData,
  parseEther,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { monadTestnet } from "viem/chains";
import { configuredSigner } from "./lib/public-signer.ts";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";
import { artifact } from "./artifacts.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
config({ quiet: true });
const m = JSON.parse(readFileSync(".runtime/testnet/manifest.json", "utf8"));
const market = m.series
  .filter((s: any) => s.symbol.includes("DEMO"))
  .sort((a: any, b: any) => b.expiry - a.expiry)[0];
const client = createPublicClient({
  chain: monadTestnet,
  batch: { multicall: { wait: 20, batchSize: 8192 } },
  transport: rateLimitedHttp(m.rpcUrl),
});
const quantity = parseUnits("0.1", 18),
  buyer = m.deployer as Address;
const role = process.argv[2] === "receive" ? "maker" : "deployer";
const account = (role === "maker" ? m.maker : buyer) as Address;
const permitted = new Set<string>();
const signer = configuredSigner(
  role,
  client,
  monadTestnet,
  m.rpcUrl,
  ".runtime/testnet/signers",
  async (intent) => {
    if (
      intent.value !== 0n ||
      !permitted.has(`${intent.to?.toLowerCase()}:${intent.data}`)
    )
      throw new Error("Only the exact demo operation is authorized");
  },
);
const send = async (
  id: string,
  to: Address,
  abi: Abi,
  name: string,
  args: unknown[] = [],
) => {
  const data = encodeFunctionData({ abi, functionName: name, args });
  permitted.add(`${to.toLowerCase()}:${data}`);
  const hash = await signer.send({
    id: `demo/${m.engine}/${id}`,
    to,
    data,
    value: 0n,
  });
  try {
    await fetch("https://strata-monad-demo.vercel.app/api/transactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash, account }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
  return hash;
};
try {
  if (process.argv[2] === "buy") {
    if (
      ((await client.readContract({
        address: m.usdc,
        abi: artifact("DemoUSDC").abi,
        functionName: "balanceOf",
        args: [account],
      })) as bigint) < 1000000n
    )
      await send("faucet", m.usdc, artifact("DemoUSDC").abi, "faucet");
    await send(
      "approve-purchase",
      m.usdc,
      artifact("DemoUSDC").abi,
      "approve",
      [m.router, 1000000n],
    );
    const purchaseMarket =
      (await client.getBlock()).timestamp < BigInt(market.expiry)
        ? market
        : m.series.find(
            (s: any) =>
              s.asset === "MON" &&
              s.kind === "put" &&
              !s.symbol.includes("DEMO"),
          );
    const before = (await client.readContract({
      address: purchaseMarket.token,
      abi: artifact("OptionToken").abi,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    const block = await client.getBlock();
    const hash = await send(
      "purchase",
      m.router,
      artifact("StrategyRouter").abi,
      "execute",
      [
        [
          {
            seriesId: BigInt(purchaseMarket.id),
            isBuy: true,
            quantity,
            premiumLimit: 1000000n,
          },
        ],
        1000000n,
        1000000n,
        0n,
        block.timestamp + 120n,
      ],
    );
    const after = (await client.readContract({
      address: purchaseMarket.token,
      abi: artifact("OptionToken").abi,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    if (after - before !== quantity)
      throw new Error("Demo purchase did not deliver exact claims");
    const report = {
      publicTestnet: true,
      account,
      market: purchaseMarket.symbol,
      quantity: "0.1",
      purchaseHash: hash,
      exactClaims: true,
      expiry: purchaseMarket.expiry,
    };
    writeDeploymentJson(".runtime/testnet/demo-purchase.json", report);
    console.log(JSON.stringify(report));
  } else if (process.argv[2] === "receive") {
    const snapshot = await (
      await fetch("https://strata-monad-demo.vercel.app/api/snapshot", {
        signal: AbortSignal.timeout(50000),
      })
    ).json();
    const entry = snapshot.markets.find((s: any) => s.id === market.id);
    const ids = entry.orders
      .filter((o: any) => o.owner.toLowerCase() === account.toLowerCase())
      .map((o: any) => BigInt(o.id));
    const book = (await import("viem")).parseAbi([
      "function batchCancelOrdersNoRevert(uint40[])",
    ]);
    const margin = (await import("viem")).parseAbi([
      "function getBalance(address,address) view returns(uint256)",
      "function withdraw(uint256,address)",
    ]);
    if (ids.length)
      await send(
        "cancel-expired",
        market.market,
        book,
        "batchCancelOrdersNoRevert",
        [ids],
      );
    const balance = (await client.readContract({
      address: market.token,
      abi: artifact("OptionToken").abi,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    if (balance < quantity) {
      const free = (await client.readContract({
        address: m.kuruMargin,
        abi: margin,
        functionName: "getBalance",
        args: [account, market.token],
      })) as bigint;
      if (free < quantity - balance)
        throw new Error("Funded expired custody is insufficient");
      await send("withdraw-expired", m.kuruMargin, margin, "withdraw", [
        quantity - balance,
        market.token,
      ]);
    }
    const hash = await send(
      "transfer-expired-claim",
      market.token,
      artifact("OptionToken").abi,
      "transfer",
      [buyer, quantity],
    );
    writeDeploymentJson(".runtime/testnet/demo-transfer.json", {
      kind: "funded-expired-claim-handoff-for-payout-validation",
      holder: buyer,
      quantity: "0.1",
      hash,
    });
    console.log(JSON.stringify({ handoff: true, hash }));
  } else if (process.argv[2] === "claim") {
    const price = (await client.readContract({
      address: m.oracle,
      abi: artifact("OracleRouter").abi,
      functionName: "settlementPrice",
      args: [m.assetId, BigInt(market.expiry)],
    })) as bigint;
    if (!price) throw new Error("Demo expiry is not yet finalized");
    const payout = (await client.readContract({
      address: m.engine,
      abi: artifact("OptionsEngine").abi,
      functionName: "previewPayout",
      args: [BigInt(market.id), quantity, price],
    })) as bigint;
    const before = (await client.readContract({
      address: m.usdc,
      abi: artifact("DemoUSDC").abi,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    const hash = await send(
      "claim",
      m.engine,
      artifact("OptionsEngine").abi,
      "redeemLong",
      [BigInt(market.id), quantity, account],
    );
    const after = (await client.readContract({
      address: m.usdc,
      abi: artifact("DemoUSDC").abi,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    const remaining = (await client.readContract({
      address: market.token,
      abi: artifact("OptionToken").abi,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    if (after - before !== payout || remaining !== 0n)
      throw new Error(
        "Demo claim does not match the engine payout and token burn",
      );
    const report = {
      publicTestnet: true,
      account,
      market: market.symbol,
      settlementPrice: String(price),
      payoutBaseUnits: String(payout),
      claimHash: hash,
      exactPayout: true,
      claimsBurned: true,
    };
    writeDeploymentJson(".runtime/testnet/demo-claim.json", report);
    console.log(JSON.stringify(report));
  } else throw new Error("Usage: testnet-demo buy|claim");
} finally {
  signer.close();
}
