import {
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  parseEther,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { asset } from "../../packages/core/src/assets.ts";
import type {
  Manifest,
  SeriesConfig,
  Kind,
} from "../../packages/core/src/types.ts";
import { factoryDeploymentAbi } from "../../packages/core/src/deployment-package.ts";
import { artifact } from "../artifacts.ts";
export type ExpansionListing = {
  asset: string;
  kind: Kind;
  strike: number;
  upperStrike: number;
  expiry: number;
};
export type ExpansionStep = {
  index: number;
  nonce: number;
  to: Address | null;
  data: `0x${string}`;
  value: string;
  label: string;
  expectedAddress?: Address;
};
export async function buildListings(
  client: PublicClient,
  manifest: Manifest,
  desired: ExpansionListing[],
  nonce: number,
) {
  const series: SeriesConfig[] = [],
    steps: ExpansionStep[] = [];
  const call = (to: Address, abi: Abi, fn: string, args: unknown[]) =>
    steps.push({
      index: steps.length,
      nonce: nonce + steps.length,
      to,
      data: encodeFunctionData({ abi, functionName: fn, args }),
      value: "0",
      label: fn,
    });
  for (const listing of desired) {
    const id =
      Math.max(...manifest.series.map((s) => s.id)) + 1 + series.length;
    const binding = manifest.assets?.find((a) => a.key === listing.asset);
    if (!binding || !asset(listing.asset).kinds.includes(listing.kind))
      throw new Error("Listing asset/kind is not admitted on this deployment");
    if (
      manifest.series.some(
        (s) =>
          s.asset === listing.asset &&
          s.kind === listing.kind &&
          s.strike === listing.strike &&
          s.upperStrike === listing.upperStrike &&
          s.expiry === listing.expiry,
      )
    )
      throw new Error("Listing duplicates an existing contract");
    const symbol = `${listing.asset}-${new Date(listing.expiry * 1000).toISOString().slice(5, 10).replace("-", "")}-${listing.strike}${listing.upperStrike ? `/${listing.upperStrike}` : ""}-${listing.kind === "call" ? "C" : listing.kind === "put" ? "P" : listing.kind === "bull-spread" ? "BULL" : "BEAR"}`;
    const token = getContractAddress({
      from: manifest.engine,
      nonce: BigInt(id),
    });
    const bookArgs = [
      token,
      manifest.usdc,
      1000n,
      1000000,
      1,
      1n,
      1000000000n,
      0n,
      0n,
      100n,
    ] as const;
    const market = await client.readContract({
      address: manifest.kuruFactory!,
      abi: factoryDeploymentAbi,
      functionName: "computeAddress",
      args: [...bookArgs, zeroAddress, false],
    });
    const venue = getContractAddress({
      from: manifest.deployer,
      nonce: BigInt(nonce + steps.length + 2),
    });
    call(manifest.engine, artifact("OptionsEngine").abi, "createSeries", [
      binding.deliverable ? manifest.wmon : zeroAddress,
      binding.assetId,
      BigInt(listing.expiry),
      ["call", "put", "bull-spread", "bear-spread"].indexOf(listing.kind),
      parseUnits(String(listing.strike), 8),
      parseUnits(String(listing.upperStrike), 8),
      listing.kind === "call" ? parseEther("1000") : parseUnits("100000", 6),
      symbol,
    ]);
    call(manifest.kuruFactory!, factoryDeploymentAbi, "deployProxy", [
      0,
      ...bookArgs,
    ]);
    steps.push({
      index: steps.length,
      nonce: nonce + steps.length,
      to: null,
      data: encodeDeployData({
        ...artifact("KuruExactAdapter"),
        args: [market, manifest.kuruMargin!, BigInt(listing.expiry)],
      }),
      value: "0",
      label: "Deploy KuruExactAdapter",
      expectedAddress: venue,
    });
    call(manifest.router, artifact("StrategyRouter").abi, "register", [
      BigInt(id),
      venue,
    ]);
    series.push({ id, token, market, venue, symbol, ...listing });
  }
  return { series, steps };
}
