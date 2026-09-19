import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import { validateVerifiedEvidence, type VerifiedPriceFeed } from "./pyth.ts";
import type { Evidence } from "./hermes.ts";
const evidence: Evidence = {
  updates: ["0xdeadbeef"],
  feed: `0x${"ab".repeat(32)}`,
  publishTime: 1001,
  previousPublishTime: 999,
  price: "103000000",
  confidence: "2000000",
  exponent: -8,
};
const verified: VerifiedPriceFeed = {
  id: evidence.feed,
  price: { price: 103000000n, conf: 2000000n, expo: -8, publishTime: 1001n },
};
describe("verified proof admission metadata (synthetic unit fixtures)", () => {
  it("retains exact observed values and the Solidity abi.encode(bytes[]) hash", () => {
    const checked = validateVerifiedEvidence(evidence, [verified], 1000, 1010n);
    expect(checked.normalizedPrice).toBe("103000000");
    expect(checked.confidence).toBe("2000000");
    expect(checked.proofHash).toBe(
      keccak256(encodeAbiParameters([{ type: "bytes[]" }], [evidence.updates])),
    );
  });
  it("rejects metadata disagreement, wrong feed and wrong publication windows", () => {
    expect(() =>
      validateVerifiedEvidence(
        { ...evidence, price: "104000000" },
        [verified],
        1000,
        1010n,
      ),
    ).toThrow("differs");
    expect(() =>
      validateVerifiedEvidence(
        evidence,
        [{ ...verified, id: `0x${"cd".repeat(32)}` }],
        1000,
        1010n,
      ),
    ).toThrow("feed");
    expect(() =>
      validateVerifiedEvidence(evidence, [verified], 1002, 1010n),
    ).toThrow("window");
    expect(() =>
      validateVerifiedEvidence(evidence, [verified], 1000, 1000n),
    ).toThrow("window");
  });
  it("cannot admit a normalized price that rounds to zero", () => {
    const tiny = { ...evidence, price: "1", exponent: -18 };
    expect(() =>
      validateVerifiedEvidence(
        tiny,
        [{ ...verified, price: { ...verified.price, price: 1n, expo: -18 } }],
        1000,
        1010n,
      ),
    ).toThrow("normalized");
  });
});
