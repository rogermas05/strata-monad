import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { Evidence } from "./hermes.ts";
import {
  closingEvidence,
  sessionCloseStep,
  settleSessionClose,
  type KeeperChain,
  type UpdateSource,
} from "./settlement-keeper.ts";

const FEED = `0x${"ab".repeat(32)}` as Hex;
const ADAPTER = `0x${"11".repeat(20)}` as const;
const VERIFIER = `0x${"22".repeat(20)}` as const;
const CLOSE = 1_000_000;
const WINDOW = 7200;
const update = (publishTime: number): Evidence => ({
  updates: [`0x${publishTime.toString(16).padStart(8, "0")}`],
  feed: FEED,
  publishTime,
  price: "4194135",
  confidence: "1154",
  exponent: -3,
});
/** A feed that prints every second except during the listed closed interval. */
function feedSource(closedFrom: number, reopens: number, now: number) {
  const calls: (number | undefined)[] = [];
  const source: UpdateSource = async (_, timestamp) => {
    calls.push(timestamp);
    if (timestamp === undefined)
      return update(now >= reopens ? now : Math.min(now, closedFrom - 1));
    return timestamp >= closedFrom && timestamp < reopens
      ? null
      : update(timestamp);
  };
  return { source, calls };
}

describe("session-close settlement keeper (synthetic feed and chain)", () => {
  it("uses the latest update while the market is still closed", async () => {
    const { source, calls } = feedSource(CLOSE, CLOSE + 3600, CLOSE + 60);

    const evidence = await closingEvidence(source, FEED, CLOSE);

    expect(evidence?.publishTime).toBe(CLOSE - 1);
    expect(calls).toEqual([undefined]);
  });

  it("searches back from the close once the market has reopened", async () => {
    const { source } = feedSource(CLOSE - 4, CLOSE + 3600, CLOSE + 4000);

    const evidence = await closingEvidence(source, FEED, CLOSE);

    expect(evidence?.publishTime).toBe(CLOSE - 5);
  });

  it("returns nothing rather than a post-close price when no print is found", async () => {
    const { source } = feedSource(CLOSE - 1000, CLOSE + 3600, CLOSE + 4000);

    expect(await closingEvidence(source, FEED, CLOSE, 10)).toBeNull();
  });

  it("only proposes a strictly later print at or before the close, inside the window", () => {
    const base = {
      expiry: CLOSE,
      challengeWindow: WINDOW,
      settled: false,
      candidatePublishedAt: CLOSE - 30,
    };
    const step = (now: number, evidencePublishedAt?: number) =>
      sessionCloseStep({ ...base, now, evidencePublishedAt });

    expect(step(CLOSE - 1, CLOSE - 2)).toBe("wait");
    expect(step(CLOSE + 10, CLOSE - 1)).toBe("propose");
    expect(step(CLOSE + 10, CLOSE - 30)).toBe("wait");
    expect(step(CLOSE + 10, CLOSE + 1)).toBe("wait");
    expect(step(CLOSE + WINDOW, CLOSE - 1)).toBe("finalize");
    expect(
      sessionCloseStep({
        ...base,
        now: CLOSE + WINDOW,
        candidatePublishedAt: 0,
      }),
    ).toBe("wait");
    expect(sessionCloseStep({ ...base, now: CLOSE + 10, settled: true })).toBe(
      "done",
    );
  });

  it("proposes with the exact verifier fee, then fixes the candidate after the window", async () => {
    let now = CLOSE + 60;
    let candidate = 0;
    let settled = 0n;
    const sent: { functionName: string; value: bigint; args: unknown[] }[] = [];
    const chain: KeeperChain = {
      now: async () => now,
      read: async (address, _abi, functionName) => {
        if (functionName === "settlementPrice") return settled;
        if (functionName === "candidate") return [BigInt(candidate)];
        if (functionName === "challengeWindow") return BigInt(WINDOW);
        if (functionName === "pyth") return VERIFIER;
        if (functionName === "getUpdateFee" && address === VERIFIER) return 7n;
        throw new Error(`Unexpected read ${functionName}`);
      },
      send: async (_address, _abi, functionName, args, value) => {
        sent.push({ functionName, value, args });
        if (functionName === "propose") candidate = CLOSE - 1;
        if (functionName === "finalize") settled = 419413500000n;
        return "0x01";
      },
    };
    const { source } = feedSource(CLOSE, CLOSE + 3600, now);
    const asset = { assetId: FEED, adapter: ADAPTER };
    const pass = () => settleSessionClose(chain, source, asset, CLOSE);

    expect(await pass()).toBe("propose");
    expect(await pass()).toBe("wait");
    now = CLOSE + WINDOW;
    expect(await pass()).toBe("finalize");
    expect(await pass()).toBe("done");

    expect(sent.map((s) => [s.functionName, s.value])).toEqual([
      ["propose", 7n],
      ["finalize", 0n],
    ]);
    expect(sent[1].args[2]).toEqual([]);
  });
});
