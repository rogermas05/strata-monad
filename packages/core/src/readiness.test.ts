import { describe, expect, it } from "vitest";
import { assessReadiness, requiresLiveMarket } from "./readiness.ts";

const input = {
  now: 100_000,
  lastSuccessfulRefreshAt: 99_000,
  lastAttemptAt: 99_000,
  lastProgressAt: 98_000,
  refreshFailed: false,
  oracleValid: true,
  chainTimestamp: 2_000_000_000,
  pricePublishedAt: 1_999_999_990,
  maxPriceAge: 3600,
};
describe("market readiness", () => {
  it("uses cache age independently of a time-travelled chain clock", () => {
    expect(assessReadiness(input).status).toBe("ready");
    expect(assessReadiness({ ...input, now: 115_001 }).status).toBe("offline");
  });
  it("fails closed on a failed refresh even with a recently good cache", () => {
    expect(
      assessReadiness({ ...input, refreshFailed: true }).newExposureAllowed,
    ).toBe(false);
    expect(assessReadiness(input).newExposureAllowed).toBe(true);
  });
  it("rejects missing, future, invalid and expired observations", () => {
    for (const override of [
      { oracleValid: false },
      { pricePublishedAt: 0 },
      { pricePublishedAt: input.chainTimestamp + 1 },
      { pricePublishedAt: input.chainTimestamp - 3600 },
    ])
      expect(assessReadiness({ ...input, ...override }).status).toBe(
        "degraded",
      );
  });
  it("detects a frozen tip, with an explicit local checkpoint exemption", () => {
    expect(assessReadiness({ ...input, lastProgressAt: 1 }).status).toBe(
      "degraded",
    );
    expect(
      assessReadiness({ ...input, lastProgressAt: 1, localMaintenance: true })
        .status,
    ).toBe("ready");
  });
  it("only gates new market exposure; exits and nonce revocation remain available", () => {
    for (const action of ["trade", "write", "place"])
      expect(requiresLiveMarket(action)).toBe(true);
    for (const action of [
      "cancel",
      "withdraw",
      "close",
      "redeem",
      "settle-writer",
      "finalize",
      "submit-recovery",
      "revoke-authorizations",
    ])
      expect(requiresLiveMarket(action)).toBe(false);
  });
});
