import { describe, expect, test } from "vitest";
import {
  ASSETS,
  asset,
  newYorkTime,
  validateListing,
  weeklyExpiries,
} from "./assets.ts";
import { isOpen, parseSchedule, weeklyCloses } from "./market-schedule.ts";

const NOW = newYorkTime(2026, 10, 12, 1, 0); // Monday 12 Oct 2026, 01:00 ET
const spy = asset("SPY");
const spySchedule = parseSchedule(spy.schedule, spy.scheduleSnapshot);

describe("Pyth market schedules", () => {
  test("regular US equity sessions open at 09:30 and close at 16:00 New York time", () => {
    expect(isOpen(spySchedule, newYorkTime(2026, 10, 12, 9, 29))).toBe(false);
    expect(isOpen(spySchedule, newYorkTime(2026, 10, 12, 9, 30))).toBe(true);
    expect(isOpen(spySchedule, newYorkTime(2026, 10, 12, 15, 59))).toBe(true);
    expect(isOpen(spySchedule, newYorkTime(2026, 10, 12, 16, 0))).toBe(false);
    expect(isOpen(spySchedule, newYorkTime(2026, 10, 17, 12, 0))).toBe(false);
  });

  test("a normal week expires at the Friday close, across the DST change", () => {
    const [first] = weeklyCloses(spySchedule, NOW, 1);
    expect(first).toBe(Date.UTC(2026, 9, 16, 20) / 1000); // 16:00 EDT
    const afterDst = weeklyCloses(spySchedule, newYorkTime(2026, 11, 2, 9), 1);
    expect(afterDst[0]).toBe(Date.UTC(2026, 10, 6, 21) / 1000); // 16:00 EST
  });

  test("holiday weeks expire at the last real session, including early closes", () => {
    // Day after Thanksgiving closes at 13:00.
    expect(weeklyCloses(spySchedule, newYorkTime(2026, 11, 23, 9), 1)).toEqual([
      newYorkTime(2026, 11, 27, 13),
    ]);
    // Christmas Day is a Friday holiday: Thursday's 13:00 early close.
    expect(weeklyCloses(spySchedule, newYorkTime(2026, 12, 21, 9), 1)).toEqual([
      newYorkTime(2026, 12, 24, 13),
    ]);
    // Good Friday 2027: Thursday's regular close.
    expect(weeklyCloses(spySchedule, newYorkTime(2027, 3, 22, 9), 1)).toEqual([
      newYorkTime(2027, 3, 25, 16),
    ]);
  });

  test("near-continuous metals close weekly on Friday, not at the daily break", () => {
    const gold = asset("XAU");
    const schedule = parseSchedule(gold.schedule, gold.scheduleSnapshot);
    expect(weeklyCloses(schedule, NOW, 1)).toEqual([
      newYorkTime(2026, 10, 16, 17),
    ]);
    expect(isOpen(schedule, newYorkTime(2026, 10, 13, 17, 30))).toBe(false);
    expect(isOpen(schedule, newYorkTime(2026, 10, 13, 18, 0))).toBe(true);
    expect(weeklyCloses(schedule, newYorkTime(2026, 11, 23, 9), 1)).toEqual([
      newYorkTime(2026, 11, 27, 14, 45),
    ]);
  });

  test("refuses dates outside the schedule snapshot window", () => {
    expect(() =>
      weeklyCloses(spySchedule, newYorkTime(2027, 11, 1, 9), 1),
    ).toThrow("outside the schedule snapshot window");
    expect(() => parseSchedule("America/New_York;C,C;", "2026-10-12")).toThrow(
      "seven weekly entries",
    );
    expect(() =>
      parseSchedule("America/New_York;1600-0930,C,C,C,C,C,C;", "2026-10-12"),
    ).toThrow("Invalid session range");
  });
});

describe("asset registry and listing rules", () => {
  test("every asset has a 32-byte Pyth feed ID and a consistent policy", () => {
    for (const spec of ASSETS) {
      expect(spec.pythFeedId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(spec.kinds.includes("call")).toBe(!!spec.deliverableToken);
      expect(spec.settlement).toBe(
        spec.expiry.kind === "weekly-close"
          ? "pyth-latest-before-close"
          : "pyth-first-after-expiry",
      );
    }
    expect(new Set(ASSETS.map((a) => a.pythFeedId)).size).toBe(ASSETS.length);
  });

  test("crypto expires weekly at Friday 08:00 UTC", () => {
    expect(weeklyExpiries(asset("MON"), NOW, 2)).toEqual([
      Date.UTC(2026, 9, 16, 8) / 1000,
      Date.UTC(2026, 9, 23, 8) / 1000,
    ]);
  });

  test("accepts listed assets on valid expiries", () => {
    const [expiry] = weeklyExpiries(asset("MON"), NOW, 1);
    expect(
      validateListing({ asset: "MON", kind: "call", expiry, strike: 1.05 }, NOW)
        .key,
    ).toBe("MON");
  });

  test("candidate RWAs need explicit admission, cash kinds and a session-close expiry", () => {
    const [close] = weeklyExpiries(spy, NOW, 1);
    expect(() =>
      validateListing(
        { asset: "SPY", kind: "put", expiry: close, strike: 500 },
        NOW,
      ),
    ).toThrow("pending oracle admission");
    const allow = { allowCandidates: true };
    expect(
      validateListing(
        { asset: "SPY", kind: "put", expiry: close, strike: 500 },
        NOW,
        allow,
      ).key,
    ).toBe("SPY");
    expect(() =>
      validateListing(
        { asset: "SPY", kind: "call", expiry: close, strike: 500 },
        NOW,
        allow,
      ),
    ).toThrow("list a bull spread");
    expect(() =>
      validateListing(
        { asset: "SPY", kind: "put", expiry: close - 3600, strike: 500 },
        NOW,
        allow,
      ),
    ).toThrow("session closes");
    expect(() =>
      validateListing(
        { asset: "SPY", kind: "bull-spread", expiry: close, strike: 500 },
        NOW,
        allow,
      ),
    ).toThrow("Invalid strikes");
  });
});

describe("session changes", () => {
  test("reports the next open and close, and none for 24/7 markets", async () => {
    const { nextSessionChange } = await import("./market-schedule.ts");
    // Saturday → Monday 09:30 open.
    expect(nextSessionChange(spySchedule, newYorkTime(2026, 10, 17, 12))).toBe(
      newYorkTime(2026, 10, 19, 9, 30),
    );
    // During the session → 16:00 close.
    expect(nextSessionChange(spySchedule, newYorkTime(2026, 10, 19, 11))).toBe(
      newYorkTime(2026, 10, 19, 16),
    );
    const gold = asset("XAU");
    const goldSchedule = parseSchedule(gold.schedule, gold.scheduleSnapshot);
    // Gold's 18:00 open runs into the next day without a change.
    expect(nextSessionChange(goldSchedule, newYorkTime(2026, 10, 13, 19))).toBe(
      newYorkTime(2026, 10, 14, 17),
    );
    const mon = asset("MON");
    expect(
      nextSessionChange(parseSchedule(mon.schedule, mon.scheduleSnapshot), NOW),
    ).toBeNull();
  });
});
