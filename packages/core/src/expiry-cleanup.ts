import { parseAbi, type Abi, type PublicClient, type Address } from "viem";
import type { Manifest, SeriesConfig } from "./types.ts";
import { assetFor } from "./manifest-assets.ts";
import { OptionsEngine as engineAbi } from "./generated/contracts.ts";
import { OptionToken as tokenAbi } from "./generated/contracts.ts";
import { DemoOrderBook as demoBookAbi } from "./generated/contracts.ts";
const oracleAbi = parseAbi([
  "function settlementPrice(bytes32,uint64) view returns(uint256)",
]);
const marginAbi = parseAbi([
  "function getBalance(address,address) view returns(uint256)",
  "function withdraw(uint256,address)",
]);
const bookAbi = parseAbi(["function batchCancelOrdersNoRevert(uint40[])"]);
/** The caller serializes maker transactions and waits for successful receipts. */
export type ExpiryCleanupSend = (
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
) => Promise<unknown>;

export async function cleanupExpiredMaker(
  client: PublicClient,
  manifest: Manifest,
  series: SeriesConfig,
  orderIds: bigint[],
  send: ExpiryCleanupSend,
) {
  if (
    !manifest.series.some(
      (s) =>
        s.id === series.id &&
        s.token === series.token &&
        s.market === series.market &&
        s.expiry === series.expiry,
    )
  )
    throw new Error("Cleanup requires a listed series");
  if (manifest.venueMode === "kuru" && !manifest.kuruMargin)
    throw new Error("Cleanup requires Kuru margin custody");
  if (
    orderIds.length > 4096 ||
    orderIds.some(
      (id) =>
        id <= 0n || id >= 2n ** (manifest.venueMode === "kuru" ? 40n : 256n),
    )
  )
    throw new Error("Cleanup order IDs exceed supported bounds");
  const [chainId, block, price] = await Promise.all([
    client.getChainId(),
    client.getBlock(),
    client.readContract({
      address: manifest.oracle,
      abi: oracleAbi,
      functionName: "settlementPrice",
      args: [assetFor(manifest, series).assetId, BigInt(series.expiry)],
    }),
  ]);
  if (
    chainId !== manifest.chainId ||
    block.timestamp < BigInt(series.expiry) ||
    !price
  )
    throw new Error(
      "Cleanup requires the correct chain and a finalized expired reference",
    );
  const ids = [...new Set(orderIds)];
  if (manifest.venueMode === "kuru") {
    if (ids.length)
      await send(series.market, bookAbi, "batchCancelOrdersNoRevert", [ids]);
    const free = await client.readContract({
      address: manifest.kuruMargin!,
      abi: marginAbi,
      functionName: "getBalance",
      args: [manifest.maker, series.token],
    });
    if (free > 0n)
      await send(manifest.kuruMargin!, marginAbi, "withdraw", [
        free,
        series.token,
      ]);
    // Quote USDC is shared across books. Cancellation releases it to margin,
    // where active markets can reuse it; cleaning one expiry must not drain it.
  } else {
    for (const id of ids)
      await send(series.market, demoBookAbi as Abi, "cancel", [id]);
  }
  const claims = (await client.readContract({
    address: series.token,
    abi: tokenAbi as Abi,
    functionName: "balanceOf",
    args: [manifest.maker],
  })) as bigint;
  if (claims > 0n)
    await send(manifest.engine, engineAbi as Abi, "redeemLong", [
      BigInt(series.id),
      claims,
      manifest.maker,
    ]);
  const writer = (await client.readContract({
    address: manifest.engine,
    abi: engineAbi as Abi,
    functionName: "writers",
    args: [BigInt(series.id), manifest.maker],
  })) as [bigint, bigint];
  if (writer[0] > 0n)
    await send(manifest.engine, engineAbi as Abi, "settleWriter", [
      BigInt(series.id),
      manifest.maker,
    ]);
  return {
    cancelledOrderIds: ids.map(String),
    redeemedClaims: claims.toString(),
    settledWriterQuantity: writer[0].toString(),
  };
}
