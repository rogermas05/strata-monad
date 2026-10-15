import { expect, it } from "vitest";
import { decodeCloudState, encodeCloudState } from "./cloud-state-codec.ts";

it("compresses a large snapshot and restores every price, balance and timestamp", () => {
  const snapshot = {
    timestamp: 1792000000,
    markets: Array.from({ length: 73 }, (_, id) => ({
      id,
      strike: 0.024,
      escrow: 1.200001,
      settlementPrice: null,
      bids: [{ price: 0.0003, quantity: 10 }],
    })),
    prices: Array.from({ length: 720 }, (_, i) => ({
      timestamp: 1792000000 + i,
      price: 0.024 + i / 1e8,
    })),
  };
  const stored = encodeCloudState("public-snapshot", snapshot);
  expect(JSON.stringify(stored).length).toBeLessThan(
    JSON.stringify(snapshot).length / 3,
  );
  expect(decodeCloudState(stored)).toEqual(snapshot);
});

it("keeps legacy rows readable and leaves manifests, leases and signing records untouched", () => {
  const value = {
    events: Array.from({ length: 1000 }, () => ["included", "0x1234"]),
  };
  expect(decodeCloudState(value)).toBe(value);
  expect(encodeCloudState("public-manifest", value)).toBe(value);
  expect(encodeCloudState("worker-health", value)).toBe(value);
  expect(
    decodeCloudState(encodeCloudState("read-model:10143:engine", value)),
  ).toEqual(value);
  expect(() => decodeCloudState({ strataEncoding: "gzip-base64-v1" })).toThrow(
    "Malformed compressed cloud state",
  );
});
