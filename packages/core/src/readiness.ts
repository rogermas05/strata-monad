export const SNAPSHOT_MAX_AGE_MS = 15_000;
export const TIP_STALL_MS = 30_000;

export interface ServiceReadiness {
  status: "ready" | "degraded" | "offline";
  newExposureAllowed: boolean;
  reason: string | null;
  evaluatedAt: number;
  lastSuccessfulRefreshAt: number;
  lastAttemptAt: number;
  lastProgressAt: number;
  maxPriceAge: number;
  oracleValid: boolean;
}

/** Wall-clock cache age is independent of the chain's clock (including local time travel). */
export function assessReadiness(input: {
  now: number;
  lastSuccessfulRefreshAt: number;
  lastAttemptAt: number;
  lastProgressAt: number;
  refreshFailed: boolean;
  oracleValid: boolean;
  chainTimestamp: number;
  pricePublishedAt: number;
  maxPriceAge: number;
  localMaintenance?: boolean;
}): ServiceReadiness {
  const cacheAge = Math.max(0, input.now - input.lastSuccessfulRefreshAt);
  const priceAge = input.chainTimestamp - input.pricePublishedAt;
  let status: ServiceReadiness["status"] = "ready";
  let reason: string | null = null;
  if (input.refreshFailed || !input.lastSuccessfulRefreshAt) {
    status = "offline";
    reason =
      "Node or indexer unavailable. Displaying the last confirmed state.";
  } else if (cacheAge > SNAPSHOT_MAX_AGE_MS) {
    status = "offline";
    reason = "Market data is stale. Waiting for a confirmed refresh.";
  } else if (
    !input.localMaintenance &&
    input.now - input.lastProgressAt > TIP_STALL_MS
  ) {
    status = "degraded";
    reason = "The connected node has stopped advancing.";
  } else if (
    !input.oracleValid ||
    input.pricePublishedAt <= 0 ||
    priceAge < 0
  ) {
    status = "degraded";
    reason = "A valid current oracle price is unavailable.";
  } else if (priceAge + cacheAge / 1000 > input.maxPriceAge) {
    status = "degraded";
    reason = "The oracle price has exceeded the issuance freshness limit.";
  }
  return {
    status,
    reason,
    newExposureAllowed: status === "ready",
    evaluatedAt: input.now,
    lastSuccessfulRefreshAt: input.lastSuccessfulRefreshAt,
    lastAttemptAt: input.lastAttemptAt,
    lastProgressAt: input.lastProgressAt,
    maxPriceAge: input.maxPriceAge,
    oracleValid: input.oracleValid,
  };
}

export function requiresLiveMarket(action: string): boolean {
  return ["trade", "write", "place"].includes(action);
}
