import { describe, expect, test } from "vitest";
import { coalesceFresh } from "./fresh-coalescer.ts";

function harness() {
  let version = 0,
    running = 0,
    maxRunning = 0,
    runs = 0;
  const releases: (() => void)[] = [];
  let failNext = false;
  const read = coalesceFresh(async () => {
    runs++;
    running++;
    maxRunning = Math.max(maxRunning, running);
    const observed = version;
    await new Promise<void>((resolve) => releases.push(resolve));
    running--;
    if (failNext) {
      failNext = false;
      throw new Error("read failed");
    }
    return observed;
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      releases.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return {
    read,
    flush,
    write: () => version++,
    fail: () => (failNext = true),
    releaseOne: () => releases.shift()?.(),
    stats: () => ({ runs, maxRunning }),
  };
}

describe("coalesceFresh", () => {
  test("a caller arriving during a run receives state from after its write", async () => {
    const h = harness();
    const stale = h.read();
    h.write();
    const fresh = h.read();
    await h.flush();
    expect(await stale).toBe(0);
    expect(await fresh).toBe(1);
  });

  test("callers during one run share a single follow-up and never overlap", async () => {
    const h = harness();
    const first = h.read();
    h.write();
    const followers = [h.read(), h.read(), h.read()];
    await h.flush();
    await first;
    expect(new Set(await Promise.all(followers))).toEqual(new Set([1]));
    expect(h.stats()).toEqual({ runs: 2, maxRunning: 1 });
  });

  test("a call between run completion and the follow-up start cannot overlap", async () => {
    const h = harness();
    const first = h.read();
    const queued = h.read();
    // Settle only the first run, then probe every microtask boundary while the
    // queued follow-up is still being scheduled.
    h.releaseOne();
    const late: Promise<number>[] = [];
    for (let depth = 0; depth < 12; depth++) {
      late.push(h.read());
      await Promise.resolve();
    }
    await h.flush();
    await Promise.all([first, queued, ...late]);
    expect(h.stats().maxRunning).toBe(1);
  });

  test("a failed run does not block the follow-up", async () => {
    const h = harness();
    h.fail();
    const failed = h.read();
    const next = h.read();
    await h.flush();
    await expect(failed).rejects.toThrow("read failed");
    await expect(next).resolves.toBe(0);
  });
});
