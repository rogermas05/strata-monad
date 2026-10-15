import { expect, it } from "vitest";
import { backfillRanges, replayLogRanges } from "./index-backfill.ts";

it("resumes after an interrupted cold start from the durable backfill boundary", async () => {
  let retained = { next: 1n, complete: false };
  let calls = 0;
  await expect(
    backfillRanges({
      from: retained.next,
      to: 20_050n,
      store: async () => {
        if (++calls === 151) throw new Error("Invocation interrupted");
      },
      checkpoint: async (next, complete) => {
        retained = { next, complete };
      },
    }),
  ).rejects.toThrow("Invocation interrupted");
  expect(retained).toEqual({ next: 10_001n, complete: false });
  const resumed: [bigint, bigint][] = [];
  await backfillRanges({
    from: retained.next,
    to: 20_050n,
    store: async (from, to) => {
      resumed.push([from, to]);
    },
    checkpoint: async (next, complete) => {
      retained = { next, complete };
    },
  });
  expect(resumed[0]).toEqual([10_001n, 10_100n]);
  expect(resumed.at(-1)).toEqual([20_001n, 20_050n]);
  expect(retained).toEqual({ next: 20_051n, complete: true });
});

it("marks an empty historical range complete without requesting logs", async () => {
  let calls = 0;
  let retained;
  await backfillRanges({
    from: 101n,
    to: 100n,
    store: async () => {
      calls++;
    },
    checkpoint: async (next, complete) => {
      retained = { next, complete };
    },
  });
  expect(calls).toBe(0);
  expect(retained).toEqual({ next: 101n, complete: true });
});

it("does not move the canonical cursor past a failed fetch or failed storage range", async () => {
  let cursor = 0n;
  const stored: bigint[] = [];
  const run = (failFetch: boolean) =>
    replayLogRanges({
      from: 1n,
      to: 2000n,
      range: 100n,
      fetch: async (from) => {
        if (failFetch && from === 401n) throw new Error("RPC interrupted");
        return from;
      },
      store: async (value, _from, to, advance) => {
        if (!failFetch && value === 1501n)
          throw new Error("Storage interrupted");
        stored.push(value);
        if (advance) cursor = to;
      },
      checkpoint: async () => {},
    });
  await expect(run(true)).rejects.toThrow("RPC interrupted");
  expect(stored).toEqual([]);
  expect(cursor).toBe(0n);
  await expect(run(false)).rejects.toThrow("Storage interrupted");
  expect(cursor).toBe(1000n);
  expect(stored.slice(0, 3)).toEqual([1n, 101n, 201n]);
});
