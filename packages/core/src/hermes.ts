import { z } from "zod";
import type { Hex } from "viem";

const schema = z.object({
  binary: z.object({
    encoding: z.literal("hex"),
    data: z
      .array(z.string().regex(/^(0x)?[0-9a-fA-F]+$/))
      .min(1)
      .max(8),
  }),
  parsed: z.array(
    z.object({
      id: z.string(),
      price: z.object({
        price: z.string().regex(/^-?\d+$/),
        conf: z.string().regex(/^\d+$/),
        expo: z.number().int(),
        publish_time: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
      }),
      metadata: z
        .object({
          prev_publish_time: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
        })
        .optional(),
    }),
  ),
});
export interface Evidence {
  updates: Hex[];
  feed: Hex;
  publishTime: number;
  previousPublishTime?: number;
  price: string;
  confidence: string;
  exponent: number;
}
/** Parsed metadata is a preliminary check only. Onchain Pyth verification remains authoritative. */
export function parseEvidence(
  value: unknown,
  feed: Hex,
  expiry?: number,
  /** False skips the live-confidence and unique-first checks; bounds still apply. */
  checkPolicy = true,
): Evidence {
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(feed) ||
    (expiry !== undefined && (!Number.isSafeInteger(expiry) || expiry < 0))
  )
    throw new Error("Invalid feed or expiry");
  const result = schema.parse(value),
    p = result.parsed.find(
      (p) =>
        p.id.replace(/^0x/, "").toLowerCase() === feed.slice(2).toLowerCase(),
    );
  if (!p)
    throw new Error("Provider response does not contain the requested feed");
  if (
    BigInt(p.price.price) <= 0n ||
    BigInt(p.price.price) > 2n ** 63n - 1n ||
    BigInt(p.price.conf) < 0n ||
    BigInt(p.price.conf) > 2n ** 64n - 1n ||
    p.price.expo < -18 ||
    p.price.expo > 8
  )
    throw new Error("Invalid price or numeric bounds");
  const shift = p.price.expo + 8;
  const normalized =
    shift >= 0
      ? BigInt(p.price.price) * 10n ** BigInt(shift)
      : BigInt(p.price.price) / 10n ** BigInt(-shift);
  if (normalized <= 0n || normalized > 10n ** 18n)
    throw new Error("Normalized price is outside the oracle bounds");
  if (
    checkPolicy &&
    expiry === undefined &&
    BigInt(p.price.conf) * 10000n > BigInt(p.price.price) * 100n
  )
    throw new Error("Live price confidence exceeds 1%");
  if (
    checkPolicy &&
    expiry !== undefined &&
    (p.price.publish_time < expiry ||
      p.metadata?.prev_publish_time === undefined ||
      p.metadata.prev_publish_time >= expiry)
  )
    throw new Error(
      "Historical response is not the unique first update for the expiry",
    );
  const updates = result.binary.data.map(
    (s) => (s.startsWith("0x") ? s : `0x${s}`) as Hex,
  );
  if (
    updates.some((u) => (u.length - 2) % 2 !== 0) ||
    updates.reduce((sum, u) => sum + (u.length - 2) / 2, 0) > 65536
  )
    throw new Error("Invalid proof encoding or proof exceeds 64 KiB");
  return {
    updates,
    feed,
    publishTime: p.price.publish_time,
    previousPublishTime: p.metadata?.prev_publish_time,
    price: p.price.price,
    confidence: p.price.conf,
    exponent: p.price.expo,
  };
}
export async function fetchEvidence({
  endpoint,
  apiKey,
  feed,
  expiry,
}: {
  endpoint: string;
  apiKey: string;
  feed: Hex;
  expiry?: number;
}): Promise<Evidence> {
  const url = new URL(
    `${endpoint.replace(/\/$/, "")}/v2/updates/price/${expiry ?? "latest"}`,
  );
  url.searchParams.set("ids[]", feed);
  url.searchParams.set("encoding", "hex");
  url.searchParams.set("parsed", "true");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Hermes request failed (HTTP ${response.status}); verify access and historical availability`,
    );
  return parseEvidence(await response.json(), feed, expiry);
}

export interface HermesAccess {
  endpoint: string;
  apiKey: string;
}
/** One signed accumulator for multiple live feeds, avoiding repeated signature payloads. */
export async function fetchUpdates(
  { endpoint, apiKey }: HermesAccess,
  feeds: Hex[],
): Promise<Map<Hex, Evidence>> {
  if (
    !feeds.length ||
    feeds.length > 64 ||
    new Set(feeds).size !== feeds.length
  )
    throw new Error("Invalid live feed batch");
  const url = new URL(`${endpoint.replace(/\/$/, "")}/v2/updates/price/latest`);
  for (const feed of feeds) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(feed)) throw new Error("Invalid feed");
    url.searchParams.append("ids[]", feed);
  }
  url.searchParams.set("encoding", "hex");
  url.searchParams.set("parsed", "true");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Hermes live batch failed (HTTP ${response.status})`);
  const value: unknown = await response.json();
  return new Map(feeds.map((feed) => [feed, parseEvidence(value, feed)]));
}
/**
 * One update for a feed: the latest, or the one Hermes holds for a timestamp
 * (null when it has none). No settlement policy is applied here.
 */
export async function fetchUpdate(
  { endpoint, apiKey }: HermesAccess,
  feed: Hex,
  timestamp?: number,
): Promise<Evidence | null> {
  const url = new URL(
    `${endpoint.replace(/\/$/, "")}/v2/updates/price/${timestamp ?? "latest"}`,
  );
  url.searchParams.set("ids[]", feed);
  url.searchParams.set("encoding", "hex");
  url.searchParams.set("parsed", "true");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `Hermes request failed (HTTP ${response.status}); verify access and entitlement for this feed`,
    );
  return parseEvidence(await response.json(), feed, timestamp, false);
}
