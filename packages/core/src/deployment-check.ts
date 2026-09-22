import {
  keccak256,
  parseAbi,
  parseUnits,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  zeroAddress,
} from "viem";
import type { Manifest } from "./types.ts";
import { assetFor, manifestAssets } from "./manifest-assets.ts";
import { OptionsEngine as engineAbi } from "./generated/contracts.ts";
import { StrategyRouter as routerAbi } from "./generated/contracts.ts";
import { KuruExactAdapter as adapterAbi } from "./generated/contracts.ts";
import { expiryOracleAbi, oraclePolicyId } from "./oracle-proof.ts";
const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);
const liveAbi = parseAbi([
  "function livePrice(bytes32) view returns (uint256,uint64)",
]);
const bindingAbi = parseAbi([
  "function bindings(bytes32) view returns (address adapter,uint64 maxLiveAge)",
]);
/** PythSessionCloseOracle.POLICY_ID. */
export const sessionClosePolicyId = keccak256(
  toBytes("STRATA_PYTH_LATEST_AT_OR_BEFORE_EXPIRY_V1"),
);
const bookAbi = parseAbi([
  "function getMarketParams() view returns (uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type Series = {
  token: Address;
  underlying: Address;
  collateral: Address;
  asset: Hex;
  expiry: bigint;
  kind: number;
  strike: bigint;
  upperStrike: bigint;
  escrow: bigint;
  shortQuantity: bigint;
};
export async function checkRpcPair(
  service: PublicClient,
  browser: PublicClient,
  manifest: Pick<Manifest, "chainId" | "deployedBlock">,
) {
  const chains = await Promise.all([
    service.getChainId(),
    browser.getChainId(),
  ]);
  if (chains.some((chain) => chain !== manifest.chainId))
    throw new Error("Service/browser RPC chain mismatch");
  const tips = await Promise.all([
    service.getBlockNumber({ cacheTime: 0 }),
    browser.getBlockNumber({ cacheTime: 0 }),
  ]);
  const blockNumber = tips[0] < tips[1] ? tips[0] : tips[1];
  if (blockNumber < BigInt(manifest.deployedBlock))
    throw new Error("An RPC has not reached the deployment block");
  const [block, browserBlock] = await Promise.all([
    service.getBlock({ blockNumber }),
    browser.getBlock({ blockNumber }),
  ]);
  if (!block.hash || !browserBlock.hash || !same(block.hash, browserBlock.hash))
    throw new Error("RPCs disagree on the canonical verification block");
  return { blockNumber, block };
}
export async function checkDeployment(
  service: PublicClient,
  browser: PublicClient,
  manifest: Manifest,
) {
  const { blockNumber, block } = await checkRpcPair(service, browser, manifest);
  const read = (
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
  ) => service.readContract({ address, abi, functionName, args, blockNumber });
  const addresses = [
    ...new Set(
      [
        manifest.engine,
        manifest.oracle,
        manifest.router,
        manifest.usdc,
        manifest.wmon,
        manifest.kuruMargin,
        manifest.kuruFactory,
        ...manifestAssets(manifest).map((a) => a.adapter),
        ...manifest.series.flatMap((s) => [s.token, s.market, s.venue]),
      ]
        .filter(Boolean)
        .map((a) => a!.toLowerCase() as Address),
    ),
  ];
  const codeHashes: Record<string, Hex> = {};
  // Bound transport work. Batch-capable HTTP transports can group these reads.
  for (let i = 0; i < addresses.length; i += 8)
    await Promise.all(
      addresses.slice(i, i + 8).map(async (address) => {
        const code = await service.getCode({ address, blockNumber });
        if (!code || code === "0x")
          throw new Error(`Deployment address has no code: ${address}`);
        codeHashes[address] = keccak256(code);
      }),
    );
  const [
    engineOracle,
    engineUsd,
    routerEngine,
    routerUsd,
    count,
    maxAge,
    usdDecimals,
    monDecimals,
  ] = await Promise.all([
    read(manifest.engine, engineAbi as Abi, "oracle"),
    read(manifest.engine, engineAbi as Abi, "usdc"),
    read(manifest.router, routerAbi as Abi, "engine"),
    read(manifest.router, routerAbi as Abi, "usdc"),
    read(manifest.engine, engineAbi as Abi, "seriesCount"),
    read(manifest.engine, engineAbi as Abi, "maxPriceAge"),
    read(manifest.usdc, tokenAbi, "decimals"),
    read(manifest.wmon, tokenAbi, "decimals"),
  ]);
  if (
    !same(engineOracle as string, manifest.oracle) ||
    !same(engineUsd as string, manifest.usdc) ||
    !same(routerEngine as string, manifest.engine) ||
    !same(routerUsd as string, manifest.usdc)
  )
    throw new Error("Engine/router configuration mismatch");
  if (
    count !== BigInt(manifest.series.length) ||
    usdDecimals !== 6 ||
    monDecimals !== 18 ||
    (maxAge as bigint) <= 0n
  )
    throw new Error("Series count, asset decimals or oracle window mismatch");
  let usdEscrow = 0n,
    monEscrow = 0n;
  const seriesChecks: Array<{ id: number; active: boolean; escrow: string }> =
    [];
  for (const cfg of manifest.series) {
    const [s, registered, decimals] = await Promise.all([
      read(manifest.engine, engineAbi as Abi, "getSeries", [
        BigInt(cfg.id),
      ]) as Promise<Series>,
      read(manifest.router, routerAbi as Abi, "venues", [BigInt(cfg.id)]),
      read(cfg.token, tokenAbi, "decimals"),
    ]);
    const kind = ["call", "put", "bull-spread", "bear-spread"].indexOf(
      cfg.kind,
    );
    if (
      !same(s.token, cfg.token) ||
      !same(
        s.underlying,
        assetFor(manifest, cfg).deliverable ? manifest.wmon : zeroAddress,
      ) ||
      !same(s.asset, assetFor(manifest, cfg).assetId) ||
      s.expiry !== BigInt(cfg.expiry) ||
      s.kind !== kind ||
      s.strike !== parseUnits(String(cfg.strike), 8) ||
      s.upperStrike !== parseUnits(String(cfg.upperStrike), 8) ||
      !same(s.collateral, kind === 0 ? manifest.wmon : manifest.usdc) ||
      !same(registered as string, cfg.venue) ||
      decimals !== 18
    )
      throw new Error(`Series ${cfg.id} terms or route mismatch`);
    const active = s.expiry > block.timestamp;
    if (active) {
      const required = (await read(
        manifest.engine,
        engineAbi as Abi,
        "requiredCollateral",
        [BigInt(cfg.id), s.shortQuantity],
      )) as bigint;
      if (s.escrow < required)
        throw new Error(`Series ${cfg.id} funding is insufficient`);
    }
    if (kind === 0) monEscrow += s.escrow;
    else usdEscrow += s.escrow;
    if (manifest.venueMode === "kuru") {
      const [base, quote, book, margin, expiry, parameters] = await Promise.all(
        [
          read(cfg.venue, adapterAbi as Abi, "base"),
          read(cfg.venue, adapterAbi as Abi, "quote"),
          read(cfg.venue, adapterAbi as Abi, "book"),
          read(cfg.venue, adapterAbi as Abi, "margin"),
          read(cfg.venue, adapterAbi as Abi, "expiry"),
          read(cfg.market, bookAbi, "getMarketParams"),
        ],
      );
      const p = parameters as readonly [
        number,
        bigint,
        Address,
        bigint,
        Address,
        bigint,
        number,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      if (
        !same(base as string, cfg.token) ||
        !same(quote as string, manifest.usdc) ||
        !same(book as string, cfg.market) ||
        !same(margin as string, manifest.kuruMargin!) ||
        expiry !== s.expiry ||
        p[0] !== 1000000 ||
        p[1] !== 1000n ||
        !same(p[2], cfg.token) ||
        p[3] !== 18n ||
        !same(p[4], manifest.usdc) ||
        p[5] !== 6n ||
        p[6] !== 1 ||
        p[7] !== 1n ||
        p[8] !== 1000000000n ||
        p[9] !== 0n ||
        p[10] !== 0n
      )
        throw new Error(`Series ${cfg.id} Kuru admission mismatch`);
    }
    seriesChecks.push({ id: cfg.id, active, escrow: s.escrow.toString() });
  }
  const [usdBalance, monBalance] = await Promise.all([
    read(manifest.usdc, tokenAbi, "balanceOf", [manifest.engine]),
    read(manifest.wmon, tokenAbi, "balanceOf", [manifest.engine]),
  ]);
  if ((usdBalance as bigint) < usdEscrow || (monBalance as bigint) < monEscrow)
    throw new Error("Aggregate engine assets do not cover recorded escrow");
  const assets = manifestAssets(manifest);
  // Router bindings are permanent: each asset must sit on its recorded adapter.
  if (manifest.assets)
    for (const asset of assets) {
      const [adapter, maxLiveAge] = (await read(
        manifest.oracle,
        bindingAbi,
        "bindings",
        [asset.assetId],
      )) as [Address, bigint];
      if (
        !same(adapter, asset.adapter) ||
        maxLiveAge !== BigInt(asset.maxLiveAge)
      )
        throw new Error(`Oracle binding mismatch for ${asset.key}`);
    }
  let verifier: Address | undefined;
  if (manifest.oracleMode === "pyth")
    for (const asset of assets) {
      const policy = await read(asset.adapter, expiryOracleAbi, "POLICY_ID");
      const expected =
        asset.policy === "pyth-latest-before-close"
          ? sessionClosePolicyId
          : oraclePolicyId;
      if (policy !== expected)
        throw new Error(`Settlement policy mismatch for ${asset.key}`);
      const adapterVerifier = (await read(
        asset.adapter,
        expiryOracleAbi,
        "pyth",
      )) as Address;
      if (verifier && !same(verifier, adapterVerifier))
        throw new Error("Oracle adapters use different verifiers");
      verifier = adapterVerifier;
      const code = await service.getCode({ address: verifier, blockNumber });
      if (!code || code === "0x")
        throw new Error("Oracle verifier has no code");
      codeHashes[verifier.toLowerCase()] = keccak256(code);
    }
  let live: { healthy: boolean; price?: string; publishedAt?: string } = {
    healthy: false,
  };
  try {
    const [price, publishedAt] = (await read(
      manifest.oracle,
      liveAbi,
      "livePrice",
      [manifest.assetId],
    )) as [bigint, bigint];
    live = {
      healthy:
        price > 0n &&
        publishedAt <= block.timestamp &&
        block.timestamp - publishedAt <= (maxAge as bigint),
      price: price.toString(),
      publishedAt: publishedAt.toString(),
    };
  } catch {
    /* Configuration checks remain useful during an oracle outage. This is not activation approval. */
  }
  const [canonical, browserCanonical] = await Promise.all([
    service.getBlock({ blockNumber }),
    browser.getBlock({ blockNumber }),
  ]);
  if (
    !canonical.hash ||
    !browserCanonical.hash ||
    !same(canonical.hash, block.hash!) ||
    !same(browserCanonical.hash, block.hash!)
  )
    throw new Error("Verification block was reorganized");
  return {
    version: 1,
    scope: "read-only-contract-configuration-and-rpc-consistency",
    chainId: manifest.chainId,
    engine: manifest.engine,
    block: {
      number: blockNumber.toString(),
      hash: block.hash,
      timestamp: block.timestamp.toString(),
    },
    rpcConsistent: true,
    codeHashes,
    oracle: {
      mode: manifest.oracleMode,
      maxPriceAge: String(maxAge),
      verifier,
      ...live,
      genuineSignedProofAdmission: "not-tested-by-this-command",
    },
    custody: {
      usdEscrow: usdEscrow.toString(),
      monEscrow: monEscrow.toString(),
      usdBalance: String(usdBalance),
      monBalance: String(monBalance),
    },
    series: seriesChecks,
    note: "Checks configured contracts and recorded custody. Does not authenticate historical payloads, certify proxy implementations, prove profitability or broadcast transactions.",
  };
}
