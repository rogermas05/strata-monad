import { describe, it, expect, vi } from "vitest";
import { parseEvidence, fetchUpdates } from "./hermes.ts";
const feed = `0x${"ab".repeat(32)}` as const;
function payload(time = 1001, previous = 999) {
  return {
    binary: { encoding: "hex", data: ["deadbeef"] },
    parsed: [
      {
        id: feed.slice(2),
        price: {
          price: "103000000",
          conf: "1000",
          expo: -8,
          publish_time: time,
        },
        metadata: { prev_publish_time: previous },
      },
    ],
  };
}
describe("historical evidence admission", () => {
  it("requires the first update surrounding the requested expiry", () => {
    expect(parseEvidence(payload(), feed, 1000).updates).toEqual([
      "0xdeadbeef",
    ]);
    expect(() => parseEvidence(payload(1002, 1001), feed, 1000)).toThrow(
      "unique first",
    );
    expect(() => parseEvidence(payload(999, 998), feed, 1000)).toThrow(
      "unique first",
    );
  });
  it("rejects wrong feeds, wide confidence and malformed bytes", () => {
    expect(() =>
      parseEvidence(payload(), `0x${"cd".repeat(32)}`, 1000),
    ).toThrow("requested feed");
    const p = payload();
    p.parsed[0].price.conf = "2000000";
    expect(parseEvidence(p, feed, 1000).confidence).toBe("2000000");
    expect(() => parseEvidence(p, feed)).toThrow("confidence");
    const odd = payload();
    odd.binary.data = ["abc"];
    expect(() => parseEvidence(odd, feed, 1000)).toThrow("encoding");
  });
  it("rejects values that cannot fit the adapter's integer and normalization bounds", () => {
    for (const [price, conf, expo] of [
      [(2n ** 63n).toString(), "0", -8],
      ["103000000", (2n ** 64n).toString(), -8],
      ["1", "0", -18],
      ["103000000", "0", 8],
    ] as const) {
      const p = payload();
      Object.assign(p.parsed[0].price, { price, conf, expo });
      expect(() => parseEvidence(p, feed, 1000)).toThrow();
    }
    expect(() =>
      parseEvidence(payload(), feed, Number.MAX_SAFE_INTEGER + 1),
    ).toThrow("expiry");
    const huge = payload();
    huge.binary.data = ["ab".repeat(65537)];
    expect(() => parseEvidence(huge, feed, 1000)).toThrow("64 KiB");
  });
});

it("batches live feeds into one signed payload and rejects incomplete or unsafe metadata", async () => {
  const other = `0x${"cd".repeat(32)}` as const;
  const value = payload();
  value.parsed.push({ ...value.parsed[0], id: other.slice(2) });
  const mock = vi.fn().mockImplementation(async () => Response.json(value));
  vi.stubGlobal("fetch", mock);
  try {
    const access = { endpoint: "https://provider.invalid", apiKey: "fixture" };
    const result = await fetchUpdates(access, [feed, other]);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(
      new URL(String(mock.mock.calls[0][0])).searchParams.getAll("ids[]"),
    ).toEqual([feed, other]);
    expect(result.get(feed)?.updates).toEqual(result.get(other)?.updates);
    value.parsed.pop();
    await expect(fetchUpdates(access, [feed, other])).rejects.toThrow(
      "requested feed",
    );
    value.parsed[0].price.conf = "2000000";
    await expect(fetchUpdates(access, [feed])).rejects.toThrow("confidence");
  } finally {
    vi.unstubAllGlobals();
  }
});
