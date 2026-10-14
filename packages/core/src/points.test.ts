import { describe, expect, test } from "vitest";
import type { Address } from "viem";
import {
  computePoints,
  epochDecay,
  pointsToStrata,
  type PointsInput,
} from "./points.ts";

const alice = "0x00000000000000000000000000000000000A11cE" as Address;
const bob = "0x0000000000000000000000000000000000000B0b" as Address;
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const claims = (n: number) => BigInt(n) * 10n ** 18n;
const base: PointsInput = {
  genesisStart: 0,
  launchTime: 1000,
  rolls: [],
  deposits: [],
  cancellations: [],
  withdrawals: [],
  fills: [],
  settlements: [],
};

describe("points", () => {
  test("earliest genesis deposits earn up to double", () => {
    const points = computePoints({
      ...base,
      deposits: [
        { account: alice, epoch: 0, amount: usdc(100), timestamp: 0 },
        { account: bob, epoch: 0, amount: usdc(100), timestamp: 1000 },
      ],
    });
    // 100 USDC × 5 points × 2 at the window opening; × 1 at launch.
    expect(points.get(alice.toLowerCase())?.genesis).toBe(usdc(1000));
    expect(points.get(bob.toLowerCase())?.genesis).toBe(usdc(500));
  });

  test("cancellations remove the latest genesis lots first", () => {
    const points = computePoints({
      ...base,
      deposits: [
        { account: alice, epoch: 0, amount: usdc(100), timestamp: 0 },
        { account: alice, epoch: 0, amount: usdc(100), timestamp: 500 },
      ],
      cancellations: [
        { account: alice, epoch: 0, amount: usdc(150), timestamp: 900 },
      ],
    });
    // Keeps 50 of the earliest lot at 2x.
    expect(points.get(alice.toLowerCase())?.genesis).toBe(usdc(500));
  });

  test("vault value earns per completed epoch with decay", () => {
    const points = computePoints({
      ...base,
      rolls: [
        { epoch: 0, pricePerShare: 10n ** 18n, timestamp: 1000 },
        { epoch: 1, pricePerShare: 11n * 10n ** 17n, timestamp: 2000 },
        { epoch: 2, pricePerShare: 11n * 10n ** 17n, timestamp: 3000 },
      ],
      deposits: [
        { account: alice, epoch: 0, amount: usdc(1000), timestamp: 1000 },
      ],
      withdrawals: [{ account: alice, epoch: 2, shares: usdc(1000) }],
    });
    // Epoch 1: 1000 × 1.0; epoch 2: 1000 shares × 1.1 × 0.9 decay.
    expect(points.get(alice.toLowerCase())?.deposits).toBe(
      usdc(1000) + usdc(990),
    );
  });

  test("withdrawn shares stop earning after their roll", () => {
    const points = computePoints({
      ...base,
      rolls: [
        { epoch: 0, pricePerShare: 10n ** 18n, timestamp: 1000 },
        { epoch: 1, pricePerShare: 10n ** 18n, timestamp: 2000 },
        { epoch: 2, pricePerShare: 10n ** 18n, timestamp: 3000 },
      ],
      deposits: [
        { account: alice, epoch: 0, amount: usdc(100), timestamp: 1000 },
      ],
      withdrawals: [{ account: alice, epoch: 1, shares: usdc(100) }],
    });
    expect(points.get(alice.toLowerCase())?.deposits).toBe(usdc(100));
  });

  test("only net losses on settled house fills mine points", () => {
    const points = computePoints({
      ...base,
      rolls: [{ epoch: 0, pricePerShare: 10n ** 18n, timestamp: 1000 }],
      fills: [
        // Alice pays 30 for 10 claims and recovers 5 from each at settlement.
        {
          account: alice,
          seriesId: 1,
          isBuy: true,
          quantity: claims(10),
          cost: usdc(30),
        },
        // Bob buys 10 for 20 and sells them back for 25: a profit, no points.
        {
          account: bob,
          seriesId: 1,
          isBuy: true,
          quantity: claims(10),
          cost: usdc(20),
        },
        {
          account: bob,
          seriesId: 1,
          isBuy: false,
          quantity: claims(10),
          cost: usdc(25),
        },
        // Unsettled series never counts.
        {
          account: alice,
          seriesId: 2,
          isBuy: true,
          quantity: claims(1),
          cost: usdc(9),
        },
      ],
      settlements: [{ seriesId: 1, expiry: 1500, payoutPerClaim: usdc(2.5) }],
    });
    expect(points.get(alice.toLowerCase())?.losses).toBe(usdc(50));
    expect(points.has(bob.toLowerCase())).toBe(false);
  });

  test("decay and conversion are exact", () => {
    expect(epochDecay(1)).toEqual({ n: 1n, d: 1n });
    expect(epochDecay(3)).toEqual({ n: 81n, d: 100n });
    expect(pointsToStrata(usdc(1.5))).toBe(15n * 10n ** 17n);
  });
});
