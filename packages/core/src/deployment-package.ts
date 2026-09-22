import { z } from "zod";
import {
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  keccak256,
  parseAbi,
  parseUnits,
  toBytes,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { credentialFreeRpc, loopbackRpc } from "./deployment-config.ts";
import type { Manifest, ManifestAsset } from "./types.ts";
import { ASSETS, asset as registryAsset, validateListing } from "./assets.ts";
import { LEGACY_REFERENCE, LEGACY_VOLATILITY } from "./manifest-assets.ts";
import {
  pythAbi,
  validateVerifiedEvidence,
  type VerifiedPriceFeed,
} from "./pyth.ts";
/** Session-close settlement defaults: covers weekends and holidays; two-hour challenge. */
const SESSION_LOOKBACK = 4 * 86400;
const SESSION_CHALLENGE_WINDOW = 7200;
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => getAddress(s))
  .refine((s) => s !== zeroAddress);
export const monUsdFeed =
  "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1" as Hex;
const raw = z
  .string()
  .regex(/^[1-9]\d*$/)
  .max(78)
  .refine(
    (s) => /^[1-9]\d*$/.test(s) && s.length <= 78 && BigInt(s) < 2n ** 256n,
  );
const price = z
  .string()
  .max(21)
  .refine(
    (s) =>
      s.length <= 21 &&
      /^(0|[1-9]\d*)(\.\d{1,8})?$/.test(s) &&
      parseUnits(s, 8) > 0n &&
      parseUnits(s, 8) <= 10n ** 18n,
  );
export const deploymentIntentSchema = z
  .object({
    version: z.literal(1),
    chainId: z.union([z.literal(31337), z.literal(10143)]),
    rpcUrl: z.string().max(2048).refine(credentialFreeRpc),
    deployer: address,
    maker: address,
    demoUser: address,
    factory: address,
    margin: address,
    oracle: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("demo"), price: price }).strict(),
      z.object({ mode: z.literal("pyth"), verifier: address }).strict(),
    ]),
    feed: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .refine((s) => s !== `0x${"0".repeat(64)}`),
    maxPriceAge: z.number().int().positive().max(3600),
    /**
     * Settlement rule for the primary feed. Last-price settlement suits feeds whose
     * signed updates are only available at intervals, e.g. harvested from a pusher.
     */
    feedSettlement: z
      .enum(["pyth-first-after-expiry", "pyth-latest-before-close"])
      .optional(),
    /** Underlyings listed beside MON; each is bound to its registry settlement policy. */
    assets: z
      .array(
        z
          .object({
            key: z.string().regex(/^[A-Z0-9]{2,16}$/),
            /** Controlled local reference price; never market data. */
            reference: price,
            volatility: z.number().min(0.01).max(5),
          })
          .strict(),
      )
      .max(63)
      .optional(),
    session: z
      .object({
        lookback: z.number().int().min(3600).max(604800),
        challengeWindow: z.number().int().min(300).max(172800),
      })
      .strict()
      .optional(),
    /** Actual verifier evidence admits otherwise-candidate assets for this testnet package only. */
    admissions: z
      .array(
        z
          .object({
            key: z.string().regex(/^[A-Z0-9]{2,16}$/),
            publishTime: z.number().int().positive().safe(),
            price: z.string().regex(/^[1-9]\d*$/),
            confidence: z.string().regex(/^\d+$/),
            exponent: z.number().int().min(-18).max(8),
            updates: z
              .array(
                z
                  .string()
                  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
                  .max(131074),
              )
              .min(1)
              .max(8),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    series: z
      .array(
        z
          .object({
            symbol: z.string().regex(/^[A-Z0-9./-]{2,80}$/),
            asset: z.string().max(16).default("MON"),
            expiry: z.number().int().positive().safe(),
            kind: z.enum(["call", "put", "bull-spread", "bear-spread"]),
            strike: price,
            upperStrike: price.optional(),
            cap: raw,
          })
          .strict(),
      )
      .min(1)
      .max(512),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.chainId === 10143 && c.feed.toLowerCase() !== monUsdFeed)
      ctx.addIssue({
        code: "custom",
        message: "This native-MON package requires the admitted MON/USD feed",
      });
    if (c.series.some((s) => !s.symbol.startsWith(`${s.asset}-`)))
      ctx.addIssue({
        code: "custom",
        message: "Listings must use their asset's symbol prefix",
      });
    const extra = (c.assets ?? []).map((a) => a.key);
    if (new Set(extra).size !== extra.length || extra.includes("MON"))
      ctx.addIssue({ code: "custom", message: "Duplicate listed assets" });
    for (const key of extra) {
      const spec = ASSETS.find((a) => a.key === key);
      // Candidates await oracle admission: local rehearsal only.
      if (
        !spec ||
        (c.chainId !== 31337 &&
          spec.status !== "listed" &&
          !c.admissions?.some((a) => a.key === key))
      )
        ctx.addIssue({
          code: "custom",
          message: "Asset is not admitted for this network",
        });
    }
    for (const s of c.series) {
      const spec =
        s.asset === "MON" || extra.includes(s.asset)
          ? ASSETS.find((a) => a.key === s.asset)
          : undefined;
      if (!spec?.kinds.includes(s.kind))
        ctx.addIssue({
          code: "custom",
          message: "Series asset is not listed or does not allow this kind",
        });
    }
    if (
      c.chainId === 31337
        ? !loopbackRpc(c.rpcUrl)
        : !c.rpcUrl.startsWith("https://") || c.oracle.mode !== "pyth"
    )
      ctx.addIssue({ code: "custom", message: "Network/oracle mode mismatch" });
    const canonicalPrice = (s: string) =>
      s.length <= 21 && /^(0|[1-9]\d*)(\.\d{1,8})?$/.test(s)
        ? parseUnits(s, 8).toString()
        : s;
    const terms = c.series.map(
      (s) =>
        `${s.asset}:${s.expiry}:${s.kind}:${canonicalPrice(s.strike)}:${canonicalPrice(s.upperStrike ?? "0")}`,
    );
    if (
      new Set(terms).size !== terms.length ||
      new Set(c.series.map((s) => s.symbol)).size !== c.series.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate series terms or symbols",
      });
    for (const s of c.series) {
      const spread = s.kind.endsWith("spread");
      if (spread !== (s.upperStrike !== undefined))
        ctx.addIssue({ code: "custom", message: "Spread bounds mismatch" });
      if (
        spread &&
        s.upperStrike &&
        /^(0|[1-9]\d*)(\.\d{1,8})?$/.test(s.strike) &&
        /^(0|[1-9]\d*)(\.\d{1,8})?$/.test(s.upperStrike) &&
        s.strike.length <= 21 &&
        s.upperStrike.length <= 21 &&
        parseUnits(s.upperStrike, 8) <= parseUnits(s.strike, 8)
      )
        ctx.addIssue({
          code: "custom",
          message: "Spread must have a higher upper strike",
        });
    }
  });
export type DeploymentIntent = z.infer<typeof deploymentIntentSchema>;
export function parseDeploymentIntent(input: unknown): DeploymentIntent {
  const result = deploymentIntentSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      "Invalid deployment intent. Check its network, public addresses, oracle, series and raw collateral caps.",
    );
  return result.data;
}
export const factoryDeploymentAbi = parseAbi([
  "function marginAccountAddress() view returns (address)",
  "function orderBookImplementation() view returns (address)",
  "function kuruAmmVaultImplementation() view returns (address)",
  "function computeAddress(address,address,uint96,uint32,uint32,uint96,uint96,uint256,uint256,uint96,address,bool) view returns (address)",
  "function deployProxy(uint8,address,address,uint96,uint32,uint32,uint96,uint96,uint256,uint256,uint96) returns (address)",
]);
export type ArtifactLoader = (name: string) => { abi: Abi; bytecode: Hex };
export interface DeploymentStep {
  index: number;
  nonce: number;
  label: string;
  to: Address | null;
  data: Hex;
  value: "0";
  contract?: string;
  expectedAddress?: Address;
  arguments: string[];
}
export interface DeploymentPackage {
  version: 1;
  kind: "unsigned-deployment";
  intent: DeploymentIntent;
  anchor: { number: string; hash: Hex; timestamp: string };
  nonceStart: number;
  dependencies: {
    codeHashes: Record<string, Hex>;
    orderBookImplementation: Address;
    vaultImplementation: Address;
    factoryImplementation: Hex;
  };
  artifactHashes: Record<string, Hex>;
  steps: DeploymentStep[];
  manifest: Manifest;
  digest: Hex;
  scope: string;
}
export const implementationSlot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
export function packageDigest(value: unknown) {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, value]) => [k, canonical(value)]),
          )
        : v;
  return keccak256(toBytes(JSON.stringify(canonical(value))));
}
export async function prepareDeploymentPackage(
  client: PublicClient,
  input: unknown,
  artifact: ArtifactLoader,
  pinned?: { nonceStart: number; blockNumber: bigint },
): Promise<DeploymentPackage> {
  const intent = parseDeploymentIntent(input);
  if ((await client.getChainId()) !== intent.chainId)
    throw new Error("Deployment RPC chain mismatch");
  const blockNumber =
    pinned?.blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const block = await client.getBlock({ blockNumber });
  if (!block.hash) throw new Error("Deployment anchor is not mined");
  if (intent.chainId === 10143 && intent.oracle.mode === "pyth") {
    for (const key of ["MON", ...(intent.assets ?? []).map((a) => a.key)]) {
      const admission = intent.admissions?.find((a) => a.key === key);
      if (!admission)
        throw new Error(
          `Public deployment needs authenticated ${key} admission evidence`,
        );
      if (admission.updates.reduce((n, u) => n + (u.length - 2) / 2, 0) > 65536)
        throw new Error("Admission payload exceeds its bounds");
      const feed = registryAsset(key).pythFeedId;
      const fee = await client.readContract({
        address: intent.oracle.verifier,
        abi: pythAbi,
        functionName: "getUpdateFee",
        args: [admission.updates as Hex[]],
        blockNumber,
      });
      const verified = await client.simulateContract({
        address: intent.oracle.verifier,
        abi: pythAbi,
        functionName: "parsePriceFeedUpdates",
        args: [
          admission.updates as Hex[],
          [feed],
          BigInt(admission.publishTime),
          BigInt(admission.publishTime),
        ],
        value: fee,
        account: intent.deployer,
        blockNumber,
      });
      validateVerifiedEvidence(
        {
          feed,
          updates: admission.updates as Hex[],
          price: admission.price,
          confidence: admission.confidence,
          exponent: admission.exponent,
          publishTime: admission.publishTime,
        },
        verified.result as readonly VerifiedPriceFeed[],
        admission.publishTime,
        block.timestamp,
      );
    }
  }
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({
      address: intent.deployer,
      blockTag: "latest",
    }),
    client.getTransactionCount({
      address: intent.deployer,
      blockTag: "pending",
    }),
  ]);
  if (!pinned && latest !== pending)
    throw new Error(
      "Deployer has pending transactions; prepare after they resolve",
    );
  const nonceStart = pinned?.nonceStart ?? latest;
  if (
    !Number.isSafeInteger(nonceStart) ||
    nonceStart < 0 ||
    nonceStart >
      Number.MAX_SAFE_INTEGER -
        (11 + (intent.assets?.length ?? 0) + intent.series.length * 4)
  )
    throw new Error("Invalid deployment nonce");
  for (const s of intent.series)
    if (
      BigInt(s.expiry) <= block.timestamp + 300n ||
      BigInt(s.expiry) > block.timestamp + 365n * 86400n
    )
      throw new Error(
        "Series expiries must leave at least five minutes and fit the engine's one-year bound",
      );
  // Session-close settlement is only correct when expiry is a real session close.
  for (const s of intent.series)
    if (registryAsset(s.asset).expiry.kind === "weekly-close")
      validateListing(
        {
          asset: s.asset,
          kind: s.kind,
          expiry: s.expiry,
          strike: Number(s.strike),
          upperStrike: s.upperStrike ? Number(s.upperStrike) : undefined,
        },
        Number(block.timestamp),
        { allowCandidates: true },
      );
  const read = (
    functionName:
      | "marginAccountAddress"
      | "orderBookImplementation"
      | "kuruAmmVaultImplementation",
  ) =>
    client.readContract({
      address: intent.factory,
      abi: factoryDeploymentAbi,
      functionName,
      blockNumber,
    });
  const [
    margin,
    orderBookImplementation,
    vaultImplementation,
    factoryImplementation,
  ] = await Promise.all([
    read("marginAccountAddress"),
    read("orderBookImplementation"),
    read("kuruAmmVaultImplementation"),
    client.getStorageAt({
      address: intent.factory,
      slot: implementationSlot,
      blockNumber,
    }),
  ]);
  if (margin.toLowerCase() !== intent.margin.toLowerCase())
    throw new Error("Kuru factory custody mismatch");
  const dependencies = [
    intent.factory,
    intent.margin,
    orderBookImplementation,
    vaultImplementation,
    ...(intent.oracle.mode === "pyth" ? [intent.oracle.verifier] : []),
  ];
  if (factoryImplementation && BigInt(factoryImplementation) !== 0n)
    dependencies.push(getAddress(`0x${factoryImplementation.slice(-40)}`));
  const codeHashes: Record<string, Hex> = {};
  for (const address of dependencies) {
    const code = await client.getCode({ address, blockNumber });
    if (!code || code === "0x")
      throw new Error("A deployment dependency has no code");
    codeHashes[address.toLowerCase()] = keccak256(code);
  }
  const deployerCode = await client.getCode({
    address: intent.deployer,
    blockNumber,
  });
  if (
    deployerCode &&
    deployerCode !== "0x" &&
    !/^0xef0100[0-9a-fA-F]{40}$/.test(deployerCode)
  )
    throw new Error("Deployment requires an EOA or EIP-7702 EOA sender");
  const steps: DeploymentStep[] = [],
    artifactHashes: Record<string, Hex> = {};
  const params = (args: readonly unknown[]) =>
    args.map((a) => (typeof a === "bigint" ? a.toString() : String(a)));
  function deploy(name: string, args: unknown[] = []) {
    const a = artifact(name);
    artifactHashes[name] = keccak256(a.bytecode);
    const nonce = nonceStart + steps.length,
      expectedAddress = getContractAddress({
        from: intent.deployer,
        nonce: BigInt(nonce),
      });
    steps.push({
      index: steps.length,
      nonce,
      label: `Deploy ${name}`,
      to: null,
      data: encodeDeployData({ ...a, args }),
      value: "0",
      contract: name,
      expectedAddress,
      arguments: params(args),
    });
    return expectedAddress;
  }
  function call(
    to: Address,
    abi: Abi,
    name: string,
    args: unknown[],
    label = name,
    expectedAddress?: Address,
  ) {
    steps.push({
      index: steps.length,
      nonce: nonceStart + steps.length,
      label,
      to,
      data: encodeFunctionData({ abi, functionName: name, args }),
      value: "0",
      arguments: params(args),
      ...(expectedAddress ? { expectedAddress } : {}),
    });
  }
  const session = intent.session ?? {
    lookback: SESSION_LOOKBACK,
    challengeWindow: SESSION_CHALLENGE_WINDOW,
  };
  const windows = [BigInt(session.lookback), BigInt(session.challengeWindow)];
  // Both adapters are always deployed, so listing a scheduled asset later is one bind.
  const usdc = deploy("DemoUSDC"),
    wmon = deploy("WrappedMON"),
    cryptoAdapter =
      intent.oracle.mode === "demo"
        ? deploy("DemoOracle")
        : deploy("PythExpiryOracle", [intent.oracle.verifier]),
    sessionAdapter =
      intent.oracle.mode === "demo"
        ? deploy("DemoSessionOracle", windows)
        : deploy("PythSessionCloseOracle", [
            intent.oracle.verifier,
            ...windows,
          ]),
    oracle = deploy("OracleRouter");
  const mon = registryAsset("MON");
  const assets: ManifestAsset[] = [
    { key: "MON", reference: undefined, volatility: LEGACY_VOLATILITY },
    ...(intent.assets ?? []),
  ].map(({ key, reference, volatility }) => {
    const spec = registryAsset(key);
    const policy =
      key === "MON"
        ? (intent.feedSettlement ?? spec.settlement)
        : spec.settlement;
    const scheduled = policy === "pyth-latest-before-close";
    return {
      key,
      name: spec.name,
      assetClass: spec.assetClass,
      assetId: key === "MON" ? (intent.feed as Hex) : spec.pythFeedId,
      adapter: scheduled ? sessionAdapter : cryptoAdapter,
      policy,
      maxLiveAge: spec.maxLiveAge,
      challengeWindow: scheduled ? session.challengeWindow : 0,
      schedule: spec.schedule,
      scheduleSnapshot: spec.scheduleSnapshot,
      volatility,
      reference: Number(
        reference ??
          (intent.oracle.mode === "demo"
            ? intent.oracle.price
            : LEGACY_REFERENCE),
      ),
      deliverable: spec.deliverableToken === "wmon",
    };
  });
  if (
    new Set(assets.map((a) => a.assetId.toLowerCase())).size !== assets.length
  )
    throw new Error("Listed assets must use distinct feeds");
  for (const a of assets)
    call(
      oracle,
      artifact("OracleRouter").abi,
      "bind",
      [a.assetId, a.adapter, BigInt(a.maxLiveAge)],
      `Bind ${a.key} settlement`,
    );
  if (intent.oracle.mode === "demo")
    call(
      cryptoAdapter,
      artifact("DemoOracle").abi,
      "publish",
      [intent.feed, parseUnits(intent.oracle.price, 8)],
      "Publish controlled reference",
    );
  const engine = deploy("OptionsEngine", [
      usdc,
      oracle,
      BigInt(intent.maxPriceAge),
    ]),
    router = deploy("StrategyRouter", [engine]);
  call(
    engine,
    artifact("OptionsEngine").abi,
    "approveUnderlying",
    [wmon, true],
    "Approve native-backed WMON",
  );
  const series: Manifest["series"] = [];
  for (const cfg of intent.series) {
    const id = series.length + 1,
      token = getContractAddress({ from: engine, nonce: BigInt(id) });
    const kind = ["call", "put", "bull-spread", "bear-spread"].indexOf(
      cfg.kind,
    );
    const listed = assets.find((a) => a.key === cfg.asset)!;
    call(
      engine,
      artifact("OptionsEngine").abi,
      "createSeries",
      [
        listed.deliverable ? wmon : zeroAddress,
        listed.assetId,
        BigInt(cfg.expiry),
        kind,
        parseUnits(cfg.strike, 8),
        cfg.upperStrike ? parseUnits(cfg.upperStrike, 8) : 0n,
        BigInt(cfg.cap),
        cfg.symbol,
      ],
      `Create ${cfg.symbol}`,
      token,
    );
    const bookArgs = [
      token,
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
    const market = await client.readContract({
      address: intent.factory,
      abi: factoryDeploymentAbi,
      functionName: "computeAddress",
      args: [...bookArgs, zeroAddress, false],
      blockNumber,
    });
    call(
      intent.factory,
      factoryDeploymentAbi,
      "deployProxy",
      [0, ...bookArgs],
      `Create Kuru book for ${cfg.symbol}`,
      market,
    );
    const venue = deploy("KuruExactAdapter", [
      market,
      intent.margin,
      BigInt(cfg.expiry),
    ]);
    call(
      router,
      artifact("StrategyRouter").abi,
      "register",
      [BigInt(id), venue],
      `Register ${cfg.symbol} route`,
    );
    series.push({
      id,
      token,
      market,
      venue,
      symbol: cfg.symbol,
      expiry: cfg.expiry,
      strike: Number(cfg.strike),
      upperStrike: Number(cfg.upperStrike ?? "0"),
      kind: cfg.kind,
      asset: cfg.asset,
    });
  }
  if ((await client.getBlock({ blockNumber })).hash !== block.hash)
    throw new Error("Deployment anchor was reorganized");
  if (
    !pinned &&
    (await client.getTransactionCount({
      address: intent.deployer,
      blockTag: "pending",
    })) !== nonceStart
  )
    throw new Error(
      "Deployer nonce changed while preparing; create a fresh package",
    );
  const manifest: Manifest = {
    chainId: intent.chainId,
    rpcUrl: intent.rpcUrl,
    mode: intent.chainId === 31337 ? "local-fork" : "testnet",
    venueMode: "kuru",
    engine,
    oracle,
    router,
    usdc,
    wmon,
    assetId: intent.feed as Hex,
    deployer: intent.deployer,
    maker: intent.maker,
    demoUser: intent.demoUser,
    deployedBlock: blockNumber.toString(),
    createdAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    series,
    kuruMargin: intent.margin,
    kuruFactory: intent.factory,
    oracleMode: intent.oracle.mode,
    assets,
  };
  const body: Omit<DeploymentPackage, "digest"> = {
    version: 1,
    kind: "unsigned-deployment",
    intent,
    anchor: {
      number: blockNumber.toString(),
      hash: block.hash,
      timestamp: block.timestamp.toString(),
    },
    nonceStart,
    dependencies: {
      codeHashes,
      orderBookImplementation,
      vaultImplementation,
      factoryImplementation: factoryImplementation ?? `0x${"0".repeat(64)}`,
    },
    artifactHashes,
    steps,
    manifest,
    scope:
      "Test assets and protocol/listing deployment only. No maker funding or genuine Pyth proof admission is included.",
  };
  return { ...body, digest: packageDigest(body) };
}
