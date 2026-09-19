import { encodeAbiParameters, keccak256, parseAbi, type Hex } from "viem";
import type { Evidence } from "./hermes.ts";

export const pythAbi = parseAbi([
  "function getUpdateFee(bytes[]) view returns (uint256)",
  "function getPriceUnsafe(bytes32) view returns ((int64 price,uint64 conf,int32 expo,uint256 publishTime))",
  "function updatePriceFeeds(bytes[]) payable",
  "function parsePriceFeedUpdates(bytes[],bytes32[],uint64,uint64) payable returns ((bytes32 id,(int64 price,uint64 conf,int32 expo,uint256 publishTime) price,(int64 price,uint64 conf,int32 expo,uint256 publishTime) emaPrice)[])",
  "function parsePriceFeedUpdatesUnique(bytes[],bytes32[],uint64,uint64) payable returns ((bytes32 id,(int64 price,uint64 conf,int32 expo,uint256 publishTime) price,(int64 price,uint64 conf,int32 expo,uint256 publishTime) emaPrice)[])",
]);
export interface VerifiedPriceFeed {
  id: Hex;
  price: { price: bigint; conf: bigint; expo: number; publishTime: bigint };
}

/** Must receive the result of the actual configured verifier's eth_call, never provider metadata. */
export function validateVerifiedEvidence(
  evidence: Evidence,
  result: readonly VerifiedPriceFeed[],
  expiry: number,
  blockTimestamp: bigint,
) {
  if (
    result.length !== 1 ||
    result[0].id.toLowerCase() !== evidence.feed.toLowerCase()
  )
    throw new Error("Verifier returned an unexpected feed");
  const price = result[0].price;
  if (price.publishTime < BigInt(expiry) || price.publishTime > blockTimestamp)
    throw new Error("Verified observation is outside the expiry window");
  if (
    price.price !== BigInt(evidence.price) ||
    price.conf !== BigInt(evidence.confidence) ||
    price.expo !== evidence.exponent ||
    price.publishTime !== BigInt(evidence.publishTime)
  )
    throw new Error(
      "Provider metadata differs from the authenticated observation",
    );
  if (
    price.price <= 0n ||
    price.price > 2n ** 63n - 1n ||
    price.conf < 0n ||
    price.conf > 2n ** 64n - 1n ||
    price.expo < -18 ||
    price.expo > 8
  )
    throw new Error("Verified price is outside the oracle bounds");
  const shift = price.expo + 8;
  const normalizedPrice =
    shift >= 0
      ? price.price * 10n ** BigInt(shift)
      : price.price / 10n ** BigInt(-shift);
  if (normalizedPrice <= 0n || normalizedPrice > 10n ** 18n)
    throw new Error("Verified normalized price is outside the oracle bounds");
  return {
    publishedAt: price.publishTime.toString(),
    rawPrice: price.price.toString(),
    confidence: price.conf.toString(),
    exponent: price.expo,
    normalizedPrice: normalizedPrice.toString(),
    proofHash: keccak256(
      encodeAbiParameters([{ type: "bytes[]" }], [evidence.updates]),
    ),
  };
}
