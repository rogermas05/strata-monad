import {
  assertWorkerLease,
  loadCloudState,
  saveCloudState,
} from "./cloud-store.ts";

/** Worst-case native cost, including Pyth fees. Unused reservations stay charged. */
export const DAILY_WORKER_BUDGET = 300_000_000_000_000_000n; // 0.3 MON per role
export const WORKER_RESERVE = 250_000_000_000_000_000n; // preserve 0.25 MON
export type GasBudget = {
  day: string;
  reserved: string;
  intents: Record<string, string>;
};

export function reserveGasCost(
  previous: GasBudget | undefined,
  intent: string,
  cost: bigint,
  balance: bigint,
  now = Date.now(),
): GasBudget {
  const day = new Date(now).toISOString().slice(0, 10);
  const budget =
    previous?.day === day ? previous : { day, reserved: "0", intents: {} };
  const already = BigInt(budget.intents[intent] ?? "0");
  const extra = cost > already ? cost - already : 0n;
  if (
    cost <= 0n ||
    BigInt(budget.reserved) + extra > DAILY_WORKER_BUDGET ||
    balance - cost < WORKER_RESERVE
  )
    throw new Error("Demo gas budget reached; automatic transactions paused");
  if (!extra) return budget;
  return {
    day,
    reserved: (BigInt(budget.reserved) + extra).toString(),
    intents: { ...budget.intents, [intent]: cost.toString() },
  };
}

/** Called immediately before broadcast, while the distributed signer lease is held. */
export async function reserveWorkerGas(
  domain: string,
  intent: string,
  cost: bigint,
  balance: bigint,
) {
  await assertWorkerLease();
  const key = `worker-gas-budget:${domain.toLowerCase()}`;
  const previous = await loadCloudState<GasBudget>(key);
  let next: GasBudget;
  try {
    next = reserveGasCost(previous, intent, cost, balance);
  } catch (error) {
    const now = Date.now();
    await saveCloudState("worker-gas-pause", {
      until: (Math.floor(now / 86400_000) + 1) * 86400_000,
    });
    throw error;
  }
  if (next !== previous) await saveCloudState(key, next);
}
