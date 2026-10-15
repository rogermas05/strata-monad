import { expect, it } from "vitest";
import {
  reserveGasCost,
  DAILY_WORKER_BUDGET,
  WORKER_RESERVE,
} from "./worker-gas-budget.ts";

it("caps cumulative worst-case gas across requests and restarts, including retries", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const cost = DAILY_WORKER_BUDGET / 2n;
  const first = reserveGasCost(
    undefined,
    "signed-hash-1",
    cost,
    10n ** 19n,
    now,
  );
  const restored = JSON.parse(JSON.stringify(first));
  expect(reserveGasCost(restored, "signed-hash-1", cost, 10n ** 19n, now)).toBe(
    restored,
  );
  const full = reserveGasCost(restored, "signed-hash-2", cost, 10n ** 19n, now);
  expect(() =>
    reserveGasCost(full, "signed-hash-3", 1n, 10n ** 19n, now),
  ).toThrow("budget");
  expect(
    reserveGasCost(full, "signed-hash-3", cost, 10n ** 19n, now + 86400_000)
      .reserved,
  ).toBe(String(cost));
  expect(() =>
    reserveGasCost(first, "signed-hash-1", cost, WORKER_RESERVE, now),
  ).toThrow("budget");
});
