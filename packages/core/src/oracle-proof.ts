import { z } from "zod";
import {
  getAddress,
  zeroAddress,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  type Address,
  type Hex,
  type Abi,
  type PublicClient,
} from "viem";
import type { Manifest } from "./types.ts";
import type { Evidence } from "./hermes.ts";
import { pythAbi, validateVerifiedEvidence } from "./pyth.ts";
import { OptionsEngine as engineAbi } from "./generated/contracts.ts";

export const oraclePolicyId = keccak256(
  new TextEncoder().encode("STRATA_PYTH_UNIQUE_FIRST_V1"),
);
export const sessionOraclePolicyId = keccak256(
  new TextEncoder().encode("STRATA_PYTH_LATEST_AT_OR_BEFORE_EXPIRY_V1"),
);
export const proofAdapter = (m: Manifest) =>
  m.assets?.find((a) => a.assetId.toLowerCase() === m.assetId.toLowerCase())
    ?.adapter ?? m.oracle;
export const proofPolicy = (m: Manifest) =>
  m.assets?.find((a) => a.assetId.toLowerCase() === m.assetId.toLowerCase())
    ?.policy === "pyth-latest-before-close"
    ? sessionOraclePolicyId
    : oraclePolicyId;
export const expiryOracleAbi = parseAbi([
  "function pyth() view returns (address)",
  "function POLICY_ID() view returns (bytes32)",
  "function settlementPrice(bytes32,uint64) view returns (uint256)",
  "function evidence(bytes32,uint64) view returns (uint64 publishedAt,int64 rawPrice,uint64 confidence,int32 exponent,bytes32 proofHash)",
  "function finalize(bytes32,uint64,bytes[]) payable returns (uint256)",
  "function livePrice(bytes32) view returns (uint256,uint64)",
  "function propose(bytes32,uint64,bytes[]) payable",
  "function lookback() view returns (uint64)",
  "function challengeWindow() view returns (uint64)",
]);
const validUnsigned = (value: string) =>
  /^(0|[1-9]\d*)$/.test(value) && value.length <= 78;
const atMost = (value: string, maximum: bigint) =>
  validUnsigned(value) && BigInt(value) <= maximum;
const uint = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(78)
  .refine((v) => atMost(v, 2n ** 256n - 1n));
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => getAddress(v))
  .refine((v) => v !== zeroAddress);
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as Hex);
const time = z.number().int().nonnegative().safe();
export const oracleProofSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["settlement", "live"]),
    action: z.enum(["propose", "finalize"]).optional(),
    chainId: z.number().int().positive().safe(),
    engine: address,
    oracle: address,
    verifier: address,
    feed: hash,
    policyId: hash,
    expiry: time.nullable(),
    updates: z
      .array(
        z
          .string()
          .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
          .transform((v) => v as Hex),
      )
      .min(1)
      .max(8),
    maxFee: uint,
    observation: z
      .object({
        publishedAt: uint,
        rawPrice: z
          .string()
          .regex(/^[1-9]\d*$/)
          .max(19)
          .refine((v) => atMost(v, 2n ** 63n - 1n)),
        confidence: uint.refine((v) => atMost(v, 2n ** 64n - 1n)),
        exponent: z.number().int().min(-18).max(8),
        normalizedPrice: uint.refine(
          (v) => atMost(v, 10n ** 18n) && BigInt(v) > 0n,
        ),
        proofHash: hash,
      })
      .strict(),
    verification: z
      .object({
        blockNumber: uint,
        blockHash: hash,
        blockTimestamp: uint,
        oracleCodeHash: hash,
        verifierCodeHash: hash,
      })
      .strict(),
    previousProviderPublishTime: time.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.updates.reduce((sum, item) => sum + (item.length - 2) / 2, 0) > 65536)
      ctx.addIssue({ code: "custom", message: "Proof exceeds 64 KiB" });
    if ((p.kind === "settlement") !== (p.expiry !== null))
      ctx.addIssue({
        code: "custom",
        message: "Settlement requires an expiry; live updates do not",
      });
    if (
      validUnsigned(p.observation.publishedAt) &&
      BigInt(p.observation.publishedAt) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      ctx.addIssue({
        code: "custom",
        message: "Publication timestamp exceeds supported bounds",
      });
  });
export type OracleProof = z.infer<typeof oracleProofSchema>;
export function parseOracleProof(
  value: unknown,
  manifest: Manifest,
): OracleProof {
  const proof = oracleProofSchema.parse(value);
  if (manifest.oracleMode !== "pyth")
    throw new Error(
      "This deployment uses a controlled oracle, not the Pyth adapter",
    );
  if (
    proof.chainId !== manifest.chainId ||
    proof.engine.toLowerCase() !== manifest.engine.toLowerCase() ||
    proof.oracle.toLowerCase() !== proofAdapter(manifest).toLowerCase() ||
    proof.feed.toLowerCase() !== manifest.assetId.toLowerCase() ||
    proof.policyId.toLowerCase() !== proofPolicy(manifest).toLowerCase()
  )
    throw new Error(
      "Proof package belongs to a different deployment or policy",
    );
  if (
    proof.expiry !== null &&
    !manifest.series.some((series) => series.expiry === proof.expiry)
  )
    throw new Error("Expiry is not listed by this deployment");
  if (
    (proof.kind === "live" && proof.action) ||
    (proof.kind === "settlement" &&
      (proofPolicy(manifest) === sessionOraclePolicyId
        ? !proof.action
        : !!proof.action))
  )
    throw new Error("Proof action does not match the adapter policy");
  if (
    keccak256(
      encodeAbiParameters([{ type: "bytes[]" }], [proof.updates]),
    ).toLowerCase() !== proof.observation.proofHash.toLowerCase()
  )
    throw new Error("Proof payload hash does not match the reviewed package");
  return proof;
}

/** Read-only checks against the configured contracts. Verifier trust still requires deployment admission. */
export async function prepareOracleProof(
  client: PublicClient,
  manifest: Manifest,
  evidence: Evidence,
  account: Address,
  expiry?: number,
): Promise<OracleProof> {
  if (
    manifest.oracleMode !== "pyth" ||
    evidence.feed.toLowerCase() !== manifest.assetId.toLowerCase()
  )
    throw new Error("Oracle mode or feed does not match this deployment");
  if ((await client.getChainId()) !== manifest.chainId)
    throw new Error("RPC chain does not match this deployment");
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const block = await client.getBlock({ blockNumber });
  const adapter = proofAdapter(manifest);
  const session = proofPolicy(manifest) === sessionOraclePolicyId;
  if (
    expiry !== undefined &&
    (!Number.isSafeInteger(expiry) ||
      expiry < 0 ||
      BigInt(expiry) > block.timestamp ||
      !manifest.series.some((series) => series.expiry === expiry))
  )
    throw new Error("Choose an elapsed listed expiry");
  const [oracleAddress, verifier, policy, maxAge, oracleCode] =
    await Promise.all([
      client.readContract({
        address: manifest.engine,
        abi: engineAbi as Abi,
        functionName: "oracle",
        blockNumber,
      }),
      client.readContract({
        address: adapter,
        abi: expiryOracleAbi,
        functionName: "pyth",
        blockNumber,
      }),
      client.readContract({
        address: adapter,
        abi: expiryOracleAbi,
        functionName: "POLICY_ID",
        blockNumber,
      }),
      client.readContract({
        address: manifest.engine,
        abi: engineAbi as Abi,
        functionName: "maxPriceAge",
        blockNumber,
      }),
      client.getCode({ address: adapter, blockNumber }),
    ]);
  if (
    (oracleAddress as Address).toLowerCase() !==
      manifest.oracle.toLowerCase() ||
    policy.toLowerCase() !== proofPolicy(manifest).toLowerCase() ||
    !oracleCode ||
    oracleCode === "0x"
  )
    throw new Error("Engine, oracle or policy admission mismatch");
  if (adapter.toLowerCase() !== manifest.oracle.toLowerCase()) {
    const binding = await client.readContract({
      address: manifest.oracle,
      abi: parseAbi([
        "function bindings(bytes32) view returns(address adapter,uint64 maxLiveAge)",
      ]),
      functionName: "bindings",
      args: [evidence.feed],
      blockNumber,
    });
    if (binding[0].toLowerCase() !== adapter.toLowerCase())
      throw new Error("Router adapter binding mismatch");
  }
  const verifierCode = await client.getCode({ address: verifier, blockNumber });
  if (!verifierCode || verifierCode === "0x")
    throw new Error("Configured verifier has no code");
  if (expiry !== undefined) {
    const cfg = manifest.series.find((series) => series.expiry === expiry)!;
    const series = (await client.readContract({
      address: manifest.engine,
      abi: engineAbi as Abi,
      functionName: "getSeries",
      args: [BigInt(cfg.id)],
      blockNumber,
    })) as { asset: Hex; expiry: bigint; token: Address };
    if (
      series.asset.toLowerCase() !== evidence.feed.toLowerCase() ||
      Number(series.expiry) !== expiry ||
      series.token.toLowerCase() !== cfg.token.toLowerCase()
    )
      throw new Error("Listed series does not match its onchain terms");
    if (
      (await client.readContract({
        address: adapter,
        abi: expiryOracleAbi,
        functionName: "settlementPrice",
        args: [evidence.feed, BigInt(expiry)],
        blockNumber,
      })) !== 0n
    )
      throw new Error("Expiry reference is already finalized");
  }
  // Reject oversized/malformed evidence before any payable simulation.
  oracleProofSchema.shape.updates.parse(evidence.updates);
  if (
    evidence.updates.reduce((sum, item) => sum + (item.length - 2) / 2, 0) >
    65536
  )
    throw new Error("Proof exceeds 64 KiB");
  const fee = await client.readContract({
    address: verifier,
    abi: pythAbi,
    functionName: "getUpdateFee",
    args: [evidence.updates],
    blockNumber,
  });
  const minTime =
    expiry !== undefined
      ? session
        ? expiry -
          Number(
            await client.readContract({
              address: adapter,
              abi: expiryOracleAbi,
              functionName: "lookback",
              blockNumber,
            }),
          )
        : expiry
      : Number(
          block.timestamp > (maxAge as bigint)
            ? block.timestamp - (maxAge as bigint)
            : 0n,
        );
  const simulation = await client.simulateContract({
    address: verifier,
    abi: pythAbi,
    functionName:
      expiry === undefined || session
        ? "parsePriceFeedUpdates"
        : "parsePriceFeedUpdatesUnique",
    args: [
      evidence.updates,
      [evidence.feed],
      BigInt(minTime),
      expiry !== undefined && session ? BigInt(expiry) : block.timestamp,
    ],
    account,
    value: fee,
    blockNumber,
  });
  const observation = validateVerifiedEvidence(
    evidence,
    simulation.result,
    minTime,
    block.timestamp,
  );
  if (
    expiry === undefined &&
    BigInt(observation.confidence) * 10000n >
      BigInt(observation.rawPrice) * 100n
  )
    throw new Error("Live price confidence exceeds 1%");
  let action: "propose" | "finalize" = "finalize";
  if (expiry !== undefined) {
    if (session)
      action =
        block.timestamp <
        BigInt(expiry) +
          (await client.readContract({
            address: adapter,
            abi: expiryOracleAbi,
            functionName: "challengeWindow",
            blockNumber,
          }))
          ? "propose"
          : "finalize";
    const finalization = await client.simulateContract({
      address: adapter,
      abi: expiryOracleAbi,
      functionName: action,
      args: [
        evidence.feed,
        BigInt(expiry),
        session && action === "finalize" ? [] : evidence.updates,
      ],
      account,
      value: session && action === "finalize" ? 0n : fee,
      blockNumber,
    });
    if (
      action === "finalize" &&
      finalization.result !== BigInt(observation.normalizedPrice)
    )
      throw new Error(
        "Adapter finalization disagrees with the verified observation",
      );
  } else
    await client.simulateContract({
      address: verifier,
      abi: pythAbi,
      functionName: "updatePriceFeeds",
      args: [evidence.updates],
      account,
      value: fee,
      blockNumber,
    });
  if ((await client.getBlock({ blockNumber })).hash !== block.hash)
    throw new Error(
      "Verification block was reorganized; prepare a fresh package",
    );
  return parseOracleProof(
    {
      version: 1,
      kind: expiry === undefined ? "live" : "settlement",
      chainId: manifest.chainId,
      engine: manifest.engine,
      oracle: adapter,
      ...(expiry !== undefined && session ? { action } : {}),
      verifier,
      feed: evidence.feed,
      policyId: policy,
      expiry: expiry ?? null,
      updates: evidence.updates,
      maxFee:
        session && expiry !== undefined && action === "finalize"
          ? "0"
          : fee.toString(),
      observation,
      verification: {
        blockNumber: blockNumber.toString(),
        blockHash: block.hash,
        blockTimestamp: block.timestamp.toString(),
        oracleCodeHash: keccak256(oracleCode),
        verifierCodeHash: keccak256(verifierCode),
      },
      ...(evidence.previousPublishTime === undefined
        ? {}
        : { previousProviderPublishTime: evidence.previousPublishTime }),
    },
    manifest,
  );
}
export async function recheckOracleProof(
  client: PublicClient,
  manifest: Manifest,
  input: unknown,
  account: Address,
) {
  const proof = parseOracleProof(input, manifest);
  const current = await prepareOracleProof(
    client,
    manifest,
    {
      updates: proof.updates,
      feed: proof.feed,
      publishTime: Number(proof.observation.publishedAt),
      previousPublishTime: proof.previousProviderPublishTime,
      price: proof.observation.rawPrice,
      confidence: proof.observation.confidence,
      exponent: proof.observation.exponent,
    },
    account,
    proof.expiry ?? undefined,
  );
  if (current.action !== proof.action)
    throw new Error(
      "Oracle submission stage changed; prepare and review a fresh package",
    );
  if (
    current.verifier.toLowerCase() !== proof.verifier.toLowerCase() ||
    current.verification.oracleCodeHash !== proof.verification.oracleCodeHash ||
    current.verification.verifierCodeHash !==
      proof.verification.verifierCodeHash
  )
    throw new Error("Oracle or verifier code changed; prepare a fresh package");
  if (BigInt(current.maxFee) > BigInt(proof.maxFee))
    throw new Error(
      "Oracle fee increased beyond the reviewed limit; prepare a fresh package",
    );
  if (JSON.stringify(current.observation) !== JSON.stringify(proof.observation))
    throw new Error("Verified observation differs from the reviewed package");
  return current;
}
