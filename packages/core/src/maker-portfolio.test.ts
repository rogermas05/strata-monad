import { expect, it } from "vitest";
import {
  makerPortfolioRisk,
  type MakerRiskPosition,
} from "./maker-portfolio.ts";
const limits = {
  maxGrossClaims: 100n,
  maxExpiryClaims: 60n,
  maxWrittenClaims: 200n,
  maxSeriesClaims: 50n,
};
const p = (
  id: number,
  expiry: number,
  net: bigint,
  bid = 0n,
  ask = 0n,
): MakerRiskPosition => ({
  marketId: id,
  expiry,
  heldClaims: net > 0n ? net : 0n,
  writtenClaims: net < 0n ? -net : 0n,
  bidClaims: bid,
  askClaims: ask,
});
it("reserves simultaneous fills without offsetting opposite series or expiries", () => {
  const r = makerPortfolioRisk(
    [p(1, 10, 20n, 10n, 40n), p(2, 10, -20n, 40n, 10n), p(3, 20, 0n, 25n, 25n)],
    limits,
  );
  expect(r.grossClaims).toBe(40n);
  expect(r.reservedGrossClaims).toBe(85n);
  expect(r.expiries[0].reservedGrossClaims).toBe(60n);
  expect(r.markets[0]).toEqual({ marketId: 1, bidClaims: 10n, askClaims: 50n });
});
it("bounds both sides by other resting reservations and global/expiry limits", () => {
  const r = makerPortfolioRisk(
    [p(1, 10, 0n), p(2, 10, 0n, 40n, 40n), p(3, 20, 0n, 45n, 45n)],
    limits,
  );
  expect(r.markets[0]).toEqual({ marketId: 1, bidClaims: 15n, askClaims: 15n });
  const q = makerPortfolioRisk([p(1, 10, 0n), p(2, 10, 0n, 50n, 50n)], limits);
  expect(q.markets[0].bidClaims).toBe(10n);
});
it("allows only movement toward flat when actual positions exceed the new budget", () => {
  const r = makerPortfolioRisk([p(1, 10, -80n), p(2, 20, 70n)], limits);
  expect(r.actualBreached).toBe(true);
  expect(r.markets[0]).toEqual({ marketId: 1, bidClaims: 80n, askClaims: 0n });
  expect(r.markets[1]).toEqual({ marketId: 2, bidClaims: 0n, askClaims: 70n });
});
it("counts all issued obligations, while self-issued funded inventory stays directionally neutral", () => {
  const r = makerPortfolioRisk(
    [
      { ...p(1, 10, 0n), heldClaims: 180n, writtenClaims: 180n },
      { ...p(2, 20, 0n), heldClaims: 10n, writtenClaims: 10n },
    ],
    limits,
  );
  expect(r.grossClaims).toBe(0n);
  expect(r.issuanceCapacity).toBe(10n);
  expect(
    makerPortfolioRisk(
      [{ ...p(1, 10, 0n), heldClaims: 201n, writtenClaims: 201n }],
      limits,
    ).issuanceBreached,
  ).toBe(true);
});
it("all combinations of independent partial bid/ask fills stay within the reserved gross bound", () => {
  const positions = [
    p(1, 10, 1n, 3n, 2n),
    p(2, 10, -2n, 2n, 3n),
    p(3, 20, 0n, 2n, 2n),
  ];
  const bound = makerPortfolioRisk(positions, limits).reservedGrossClaims;
  const abs = (n: bigint) => (n < 0n ? -n : n);
  // Enumerate actual positions after every independent partial-fill combination.
  for (let aBuy = 0n; aBuy <= 3n; aBuy++)
    for (let aSell = 0n; aSell <= 2n; aSell++)
      for (let bBuy = 0n; bBuy <= 2n; bBuy++)
        for (let bSell = 0n; bSell <= 3n; bSell++)
          for (let cBuy = 0n; cBuy <= 2n; cBuy++)
            for (let cSell = 0n; cSell <= 2n; cSell++) {
              const actual =
                abs(1n + aBuy - aSell) +
                abs(-2n + bBuy - bSell) +
                abs(cBuy - cSell);
              expect(actual).toBeLessThanOrEqual(bound);
            }
});
it("rejects duplicate/missing-domain or negative custody inputs", () => {
  expect(() =>
    makerPortfolioRisk([p(1, 10, 0n), p(1, 20, 0n)], limits),
  ).toThrow("Invalid");
  expect(() =>
    makerPortfolioRisk([{ ...p(1, 10, 0n), heldClaims: -1n }], limits),
  ).toThrow("Invalid");
  expect(() =>
    makerPortfolioRisk([], { ...limits, maxGrossClaims: 0n }),
  ).toThrow("Invalid");
});
