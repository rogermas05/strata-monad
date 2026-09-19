import { parseAbi, type Abi, type Address, type Hex } from "viem";
import type { Evidence } from "./hermes.ts";
import { pythAbi } from "./pyth.ts";

/** Seconds before a close searched for its last print when the market has reopened. */
export const CLOSE_SEARCH_SECONDS = 300;

export const sessionCloseOracleAbi = parseAbi([
  "function pyth() view returns (address)",
  "function challengeWindow() view returns (uint64)",
  "function settlementPrice(bytes32,uint64) view returns (uint256)",
  "function candidate(bytes32,uint64) view returns (uint64 publishedAt,int64 rawPrice,uint64 confidence,int32 exponent,uint256 price,bytes32 proofHash)",
  "function propose(bytes32,uint64,bytes[]) payable",
  "function finalize(bytes32,uint64,bytes[]) payable returns (uint256)",
]);

/** `at(feed)` is the latest update; `at(feed, t)` the one held for second `t`, if any. */
export type UpdateSource = (
  feed: Hex,
  timestamp?: number,
) => Promise<Evidence | null>;

/**
 * Latest update published at or before a session close. While the market is
 * still closed that is simply the latest update; after it reopens, the seconds
 * before the close are searched backwards.
 */
export async function closingEvidence(
  source: UpdateSource,
  feed: Hex,
  expiry: number,
  searchSeconds = CLOSE_SEARCH_SECONDS,
): Promise<Evidence | null> {
  const latest = await source(feed);
  if (latest && latest.publishTime <= expiry) return latest;
  for (let t = expiry; t >= expiry - searchSeconds; t--) {
    const update = await source(feed, t);
    if (update && update.publishTime <= expiry) return update;
  }
  return null;
}

export type SessionCloseStep = "done" | "propose" | "finalize" | "wait";

/** What a keeper should do for one scheduled (asset, expiry). */
export function sessionCloseStep(input: {
  now: number;
  expiry: number;
  challengeWindow: number;
  settled: boolean;
  candidatePublishedAt: number;
  /** Publish time of the best evidence found, if any. */
  evidencePublishedAt?: number;
}): SessionCloseStep {
  if (input.settled) return "done";
  if (input.now < input.expiry) return "wait";
  if (input.now >= input.expiry + input.challengeWindow)
    return input.candidatePublishedAt > 0 ? "finalize" : "wait";
  return input.evidencePublishedAt !== undefined &&
    input.evidencePublishedAt <= input.expiry &&
    input.evidencePublishedAt > input.candidatePublishedAt
    ? "propose"
    : "wait";
}

export interface KeeperChain {
  read: (
    address: Address,
    abi: Abi,
    functionName: string,
    args?: unknown[],
  ) => Promise<unknown>;
  send: (
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
    value: bigint,
  ) => Promise<Hex>;
  /** Chain time in seconds. */
  now: () => Promise<number>;
}

/**
 * One keeper pass for a scheduled asset's expiry on a PythSessionCloseOracle:
 * proposes the last print inside the challenge window, then fixes it afterwards.
 * Returns the step taken. Provider failure never produces a price.
 */
export async function settleSessionClose(
  chain: KeeperChain,
  source: UpdateSource,
  asset: { assetId: Hex; adapter: Address },
  expiry: number,
): Promise<SessionCloseStep> {
  const [settled, candidate, challengeWindow, now] = await Promise.all([
    chain.read(asset.adapter, sessionCloseOracleAbi, "settlementPrice", [
      asset.assetId,
      BigInt(expiry),
    ]) as Promise<bigint>,
    chain.read(asset.adapter, sessionCloseOracleAbi, "candidate", [
      asset.assetId,
      BigInt(expiry),
    ]) as Promise<readonly [bigint, ...unknown[]]>,
    chain.read(
      asset.adapter,
      sessionCloseOracleAbi,
      "challengeWindow",
    ) as Promise<bigint>,
    chain.now(),
  ]);
  const state = {
    now,
    expiry,
    challengeWindow: Number(challengeWindow),
    settled: settled > 0n,
    candidatePublishedAt: Number(candidate[0]),
  };
  const withoutEvidence = sessionCloseStep(state);
  if (withoutEvidence === "done") return "done";
  if (withoutEvidence === "finalize") {
    await chain.send(
      asset.adapter,
      sessionCloseOracleAbi,
      "finalize",
      [asset.assetId, BigInt(expiry), []],
      0n,
    );
    return "finalize";
  }
  if (now < expiry || now >= expiry + state.challengeWindow) return "wait";
  const evidence = await closingEvidence(source, asset.assetId, expiry);
  if (
    !evidence ||
    sessionCloseStep({
      ...state,
      evidencePublishedAt: evidence.publishTime,
    }) !== "propose"
  )
    return "wait";
  const verifier = (await chain.read(
    asset.adapter,
    sessionCloseOracleAbi,
    "pyth",
  )) as Address;
  const fee = (await chain.read(verifier, pythAbi, "getUpdateFee", [
    evidence.updates,
  ])) as bigint;
  await chain.send(
    asset.adapter,
    sessionCloseOracleAbi,
    "propose",
    [asset.assetId, BigInt(expiry), evidence.updates],
    fee,
  );
  return "propose";
}
