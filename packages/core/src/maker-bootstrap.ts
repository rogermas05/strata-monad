import {
  encodeFunctionData,
  parseAbi,
  parseAbiItem,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { makerLadder } from "./maker.ts";
import { priceOption } from "./analytics.ts";
import { packageDigest, type DeploymentStep } from "./deployment-package.ts";
import type { Manifest } from "./types.ts";
import { assetFor } from "./manifest-assets.ts";
import { OptionsEngine as engineAbi } from "./generated/contracts.ts";
import { DemoUSDC as usdcAbi } from "./generated/contracts.ts";
import { WrappedMON as monAbi } from "./generated/contracts.ts";
import { OptionToken as tokenAbi } from "./generated/contracts.ts";
export const bootstrapMarginAbi = parseAbi([
  "function deposit(address,address,uint256) payable",
  "function getBalance(address,address) view returns(uint256)",
]);
export const bootstrapBookAbi = parseAbi([
  "function batchUpdate(uint32[],uint96[],uint32[],uint96[],uint40[],bool)",
  "event OrderCreated(uint40 orderId,address owner,uint96 size,uint32 price,bool isBuy)",
]);
const liveAbi = parseAbi([
  "function livePrice(bytes32) view returns(uint256,uint64)",
]);
export interface MakerBootstrap {
  version: 1;
  kind: "maker-bootstrap";
  manifest: Manifest;
  quantity: number;
  volatility: number;
  spreadBps: number;
  edge: number;
  nonceStart: number;
  anchor: { number: string; hash: Hex; timestamp: string };
  spot: string;
  maxPriceAge: string;
  funding: {
    nativeWrap: string;
    stableCollateral: string;
    stableQuotes: string;
    faucet: boolean;
  };
  markets: Array<{
    id: number;
    collateral: string;
    bidPrices: number[];
    bidLots: string[];
    askPrices: number[];
    askLots: string[];
  }>;
  steps: Array<Omit<DeploymentStep, "value"> & { value: string }>;
  digest: Hex;
}
export function bootstrapDigest(body: Omit<MakerBootstrap, "digest">) {
  return packageDigest(body);
}
export async function prepareMakerBootstrap(
  client: PublicClient,
  manifest: Manifest,
  quantity = 90,
  pinned?: { blockNumber: bigint; nonceStart: number },
): Promise<MakerBootstrap> {
  if (
    manifest.venueMode !== "kuru" ||
    !manifest.kuruMargin ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  )
    throw new Error(
      "Bootstrap requires admitted Kuru custody and an integer quantity from 1 to 100",
    );
  if ((await client.getChainId()) !== manifest.chainId)
    throw new Error("Bootstrap chain mismatch");
  const blockNumber =
      pinned?.blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 })),
    block = await client.getBlock({ blockNumber });
  const read = (
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
  ) => client.readContract({ address, abi, functionName, args, blockNumber });
  const [latest, pending, price, maxAge, usdBalance, monBalance, venueUsd] =
    await Promise.all([
      client.getTransactionCount({ address: manifest.maker, blockNumber }),
      client.getTransactionCount({
        address: manifest.maker,
        blockTag: "pending",
      }),
      read(manifest.oracle, liveAbi, "livePrice", [manifest.assetId]),
      read(manifest.engine, engineAbi as Abi, "maxPriceAge"),
      read(manifest.usdc, tokenAbi as Abi, "balanceOf", [manifest.maker]),
      read(manifest.wmon, tokenAbi as Abi, "balanceOf", [manifest.maker]),
      read(manifest.kuruMargin, bootstrapMarginAbi, "getBalance", [
        manifest.maker,
        manifest.usdc,
      ]),
    ]);
  if (!pinned && latest !== pending)
    throw new Error("Maker has pending transactions");
  if (pinned && latest !== pinned.nonceStart)
    throw new Error("Bootstrap anchor nonce mismatch");
  const [spot, published] = price as [bigint, bigint];
  if (
    spot <= 0n ||
    published > block.timestamp ||
    block.timestamp - published > (maxAge as bigint)
  )
    throw new Error("Bootstrap needs a fresh live reference");
  if (venueUsd !== 0n)
    throw new Error(
      "Bootstrap is only for fresh maker custody; use the inventory worker for replenishment",
    );
  const created = [];
  for (let from = BigInt(manifest.deployedBlock); from <= blockNumber;) {
    const to =
      manifest.chainId === 10143 && from + 99n < blockNumber
        ? from + 99n
        : blockNumber;
    created.push(
      ...(await client.getLogs({
        address: manifest.series.map((s) => s.market),
        event: parseAbiItem(
          "event OrderCreated(uint40 orderId,address owner,uint96 size,uint32 price,bool isBuy)",
        ),
        fromBlock: from,
        toBlock: to,
      })),
    );
    from = to + 1n;
  }
  if (created.length)
    throw new Error("Bootstrap books already have an order history");
  const q = BigInt(quantity) * 10n ** 18n,
    volatility = manifest.assets?.[0]?.volatility ?? 0.85,
    spreadBps = 1200,
    edge = manifest.oracleMode === "pyth" ? 0 : 0.001;
  let monRequired = 0n,
    usdRequired = 0n,
    quoteRequired = 0n;
  const markets: MakerBootstrap["markets"] = [];
  // Bootstrap funds the primary (MON) shelf at its live reference. Other
  // underlyings are issued by the inventory worker once their session is open.
  const shelf = manifest.series.filter(
    (s) =>
      assetFor(manifest, s).assetId.toLowerCase() ===
        manifest.assetId.toLowerCase() &&
      BigInt(s.expiry) > block.timestamp + 300n,
  );
  for (const s of shelf) {
    if (BigInt(s.expiry) <= block.timestamp + 300n)
      throw new Error("Bootstrap shelf is expired or too close to expiry");
    const [writer, balance, free, required, terms] = await Promise.all([
      read(manifest.engine, engineAbi as Abi, "writers", [
        BigInt(s.id),
        manifest.maker,
      ]),
      read(s.token, tokenAbi as Abi, "balanceOf", [manifest.maker]),
      read(manifest.kuruMargin, bootstrapMarginAbi, "getBalance", [
        manifest.maker,
        s.token,
      ]),
      read(manifest.engine, engineAbi as Abi, "requiredCollateral", [
        BigInt(s.id),
        q,
      ]),
      read(manifest.engine, engineAbi as Abi, "getSeries", [BigInt(s.id)]),
    ]);
    if ((required as bigint) > (terms as { cap: bigint }).cap)
      throw new Error("Bootstrap exceeds a series collateral cap");
    if ((writer as [bigint, bigint])[0] !== 0n || balance !== 0n || free !== 0n)
      throw new Error(
        "Bootstrap maker already has option inventory or obligations",
      );
    if (s.kind === "call") monRequired += required as bigint;
    else usdRequired += required as bigint;
    const fair = priceOption(
      s.kind,
      Number(spot) / 1e8,
      s.strike,
      s.upperStrike,
      (s.expiry - Number(block.timestamp)) / (365 * 86400),
      volatility,
    ).price;
    const bid = Math.max(
      1,
      Math.round(
        Math.max(fair * (1 - spreadBps / 10000) - edge, 0.000001) * 1e6,
      ),
    );
    const ask = Math.max(
      bid + 1,
      Math.round((fair * (1 + spreadBps / 10000) + edge) * 1e6),
    );
    const ladder = makerLadder({
      bid,
      ask,
      targetLots: BigInt(quantity) * 1000n,
      availableAskLots: BigInt(quantity) * 1000n,
    });
    quoteRequired += ladder.quoteReserve;
    markets.push({
      id: s.id,
      collateral: String(required),
      bidPrices: ladder.buyPrices,
      bidLots: ladder.buySizes.map(String),
      askPrices: ladder.sellPrices,
      askLots: ladder.sellSizes.map(String),
    });
  }
  const wrap =
    monRequired > (monBalance as bigint)
      ? monRequired - (monBalance as bigint)
      : 0n;
  if (
    (await client.getBalance({ address: manifest.maker, blockNumber })) <
    wrap + 10n ** 18n
  )
    throw new Error(
      "Maker needs native wrapping funds plus a rehearsal gas reserve",
    );
  const faucet = (usdBalance as bigint) < usdRequired + quoteRequired;
  if (
    faucet &&
    block.timestamp <
      ((await read(manifest.usdc, usdcAbi as Abi, "lastFaucet", [
        manifest.maker,
      ])) as bigint) +
        3600n
  )
    throw new Error(
      "Test quote faucet is in cooldown; pre-fund the maker and prepare again",
    );
  if (
    faucet &&
    (usdBalance as bigint) + 10000n * 10n ** 6n < usdRequired + quoteRequired
  )
    throw new Error("Test faucet budget cannot fund this bootstrap");
  const steps: MakerBootstrap["steps"] = [];
  const add = (
    to: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
    label: string,
    value = 0n,
  ) =>
    steps.push({
      index: steps.length,
      nonce: latest + steps.length,
      label,
      to,
      data: encodeFunctionData({ abi, functionName, args }),
      value: String(value),
      arguments: args.map((a) =>
        Array.isArray(a) ? a.map(String).join(";") : String(a),
      ),
    });
  if (faucet)
    add(
      manifest.usdc,
      usdcAbi as Abi,
      "faucet",
      [],
      "Claim rate-limited test quote funds",
    );
  if (wrap)
    add(
      manifest.wmon,
      monAbi as Abi,
      "deposit",
      [],
      "Wrap native test MON",
      wrap,
    );
  if (monRequired)
    add(
      manifest.wmon,
      tokenAbi as Abi,
      "approve",
      [manifest.engine, monRequired],
      "Approve exact call backing",
    );
  if (usdRequired)
    add(
      manifest.usdc,
      tokenAbi as Abi,
      "approve",
      [manifest.engine, usdRequired],
      "Approve exact cash backing",
    );
  add(
    manifest.usdc,
    tokenAbi as Abi,
    "approve",
    [manifest.kuruMargin, quoteRequired],
    "Approve exact bid reserve",
  );
  add(
    manifest.kuruMargin,
    bootstrapMarginAbi,
    "deposit",
    [manifest.maker, manifest.usdc, quoteRequired],
    "Fund shared bid custody",
  );
  for (const m of markets) {
    const s = manifest.series.find((s) => s.id === m.id)!;
    add(
      manifest.engine,
      engineAbi as Abi,
      "write",
      [BigInt(s.id), q, manifest.maker],
      `Issue fully backed ${s.symbol}`,
    );
    add(
      s.token,
      tokenAbi as Abi,
      "approve",
      [manifest.kuruMargin, q],
      `Approve exact ${s.symbol} asks`,
    );
    add(
      manifest.kuruMargin,
      bootstrapMarginAbi,
      "deposit",
      [manifest.maker, s.token, q],
      `Fund ${s.symbol} ask custody`,
    );
    add(
      s.market,
      bootstrapBookAbi,
      "batchUpdate",
      [
        m.bidPrices,
        m.bidLots.map(BigInt),
        m.askPrices,
        m.askLots.map(BigInt),
        [],
        true,
      ],
      `Quote ${s.symbol}`,
    );
  }
  if (
    (await client.getBlock({ blockNumber })).hash !== block.hash ||
    (!pinned &&
      (await client.getTransactionCount({
        address: manifest.maker,
        blockTag: "pending",
      })) !== latest)
  )
    throw new Error("Bootstrap anchor or nonce changed");
  const body: Omit<MakerBootstrap, "digest"> = {
    version: 1,
    kind: "maker-bootstrap",
    manifest,
    quantity,
    volatility,
    spreadBps,
    edge,
    nonceStart: latest,
    anchor: {
      number: blockNumber.toString(),
      hash: block.hash!,
      timestamp: block.timestamp.toString(),
    },
    spot: spot.toString(),
    maxPriceAge: String(maxAge),
    funding: {
      nativeWrap: wrap.toString(),
      stableCollateral: usdRequired.toString(),
      stableQuotes: quoteRequired.toString(),
      faucet,
    },
    markets,
    steps,
  };
  return { ...body, digest: bootstrapDigest(body) };
}
