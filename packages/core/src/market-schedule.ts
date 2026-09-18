/**
 * Pyth market-hours schedules, e.g.
 *   "America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;1127/0930-1300,1225/C"
 * Seven weekly entries run Monday→Sunday. Each is "O" (open all day), "C" (closed)
 * or "&"-joined HHMM-HHMM intervals in the schedule's time zone. Holiday overrides
 * are MMDD without a year; Pyth publishes a rolling window, so a schedule snapshot
 * is only valid for about a year after it was taken.
 */

export interface Interval {
  start: number; // minutes after local midnight
  end: number; // exclusive; 1440 means midnight of the next day
}

export interface MarketSchedule {
  timeZone: string;
  weekly: Interval[][]; // index 0 = Monday
  holidays: Map<string, Interval[]>; // "MMDD" → sessions (empty = closed)
  /** First day (UTC, YYYY-MM-DD) of the window the holiday list describes. */
  snapshotDate: string;
}

const MAX_HORIZON_DAYS = 330;
const MINUTES_PER_DAY = 1440;

function parseDay(entry: string): Interval[] {
  if (entry === "O") return [{ start: 0, end: MINUTES_PER_DAY }];
  if (entry === "C") return [];
  return entry.split("&").map((range) => {
    const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(range);
    if (!match) throw new Error(`Invalid session range "${range}"`);
    const [, sh, sm, eh, em] = match.map(Number);
    const interval = { start: sh * 60 + sm, end: eh * 60 + em };
    if (
      sm > 59 ||
      em > 59 ||
      interval.start >= interval.end ||
      interval.end > MINUTES_PER_DAY
    )
      throw new Error(`Invalid session range "${range}"`);
    return interval;
  });
}

export function parseSchedule(
  schedule: string,
  snapshotDate: string,
): MarketSchedule {
  const [timeZone, weeklyPart, holidayPart = ""] = schedule.split(";");
  if (!timeZone || !weeklyPart) throw new Error("Invalid market schedule");
  new Intl.DateTimeFormat("en-US", { timeZone }); // throws for unknown zones
  const weekly = weeklyPart.split(",").map(parseDay);
  if (weekly.length !== 7)
    throw new Error("Schedule needs seven weekly entries");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate))
    throw new Error("Snapshot date must be YYYY-MM-DD");
  const holidays = new Map<string, Interval[]>();
  for (const item of holidayPart.split(",").filter(Boolean)) {
    const [day, sessions] = item.split("/");
    if (!/^\d{4}$/.test(day) || !sessions)
      throw new Error(`Invalid holiday "${item}"`);
    holidays.set(day, parseDay(sessions));
  }
  return { timeZone, weekly, holidays, snapshotDate };
}

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function localParts(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestamp * 1000));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    minutes: get("hour") * 60 + get("minute"),
    second: get("second"),
  };
}

/** Unix seconds for a wall-clock time in a zone, correct across DST changes. */
export function zonedTime(
  date: LocalDate,
  minutes: number,
  timeZone: string,
): number {
  const target =
    Date.UTC(date.year, date.month - 1, date.day) / 1000 + minutes * 60;
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, timeZone);
    const seen =
      Date.UTC(p.year, p.month - 1, p.day) / 1000 + p.minutes * 60 + p.second;
    guess += target - seen;
  }
  return guess;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function weekdayIndex(date: LocalDate) {
  // 0 = Monday … 6 = Sunday
  return (
    (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) %
    7
  );
}

function key(date: LocalDate) {
  return `${String(date.month).padStart(2, "0")}${String(date.day).padStart(2, "0")}`;
}

function iso(date: LocalDate) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function assertWithinSnapshot(schedule: MarketSchedule, date: LocalDate) {
  const start = Date.parse(`${schedule.snapshotDate}T00:00:00Z`);
  const days = (Date.parse(`${iso(date)}T00:00:00Z`) - start) / 86_400_000;
  if (days < -1 || days > MAX_HORIZON_DAYS)
    throw new Error(
      `${iso(date)} is outside the schedule snapshot window; refresh the Pyth schedule`,
    );
}

export function sessionsOn(
  schedule: MarketSchedule,
  date: LocalDate,
): Interval[] {
  assertWithinSnapshot(schedule, date);
  return (
    schedule.holidays.get(key(date)) ?? schedule.weekly[weekdayIndex(date)]
  );
}

export function isOpen(schedule: MarketSchedule, timestamp: number): boolean {
  const p = localParts(timestamp, schedule.timeZone);
  return sessionsOn(schedule, p).some(
    (s) => p.minutes >= s.start && p.minutes < s.end,
  );
}

/**
 * The last session close in each Monday–Sunday week, from the week containing
 * `from`. Sessions that run into the next day without a gap are not closes.
 * Weeks with no trading are skipped. Returns Unix seconds.
 */
export function weeklyCloses(
  schedule: MarketSchedule,
  from: number,
  weeks: number,
): number[] {
  const start = localParts(from, schedule.timeZone);
  let monday = addDays(start, -weekdayIndex(start));
  const closes: number[] = [];
  for (let w = 0; w < weeks; w++, monday = addDays(monday, 7)) {
    let last: number | undefined;
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      const sessions = sessionsOn(schedule, date);
      for (const s of sessions) {
        const continues =
          s.end === MINUTES_PER_DAY &&
          (sessionsOn(schedule, addDays(date, 1))[0]?.start ?? -1) === 0;
        if (continues) continue;
        const close = zonedTime(date, s.end, schedule.timeZone);
        if (close > from) last = close;
      }
    }
    if (last !== undefined) closes.push(last);
  }
  return closes;
}

/**
 * Next time the open/closed state changes after `timestamp`, or null for
 * markets that never close. Joined sessions (e.g. 18:00–24:00 then 00:00–17:00)
 * do not count as a change.
 */
export function nextSessionChange(
  schedule: MarketSchedule,
  timestamp: number,
): number | null {
  const state = isOpen(schedule, timestamp);
  const start = localParts(timestamp, schedule.timeZone);
  const candidates: number[] = [];
  for (let d = 0; d < 10; d++) {
    const date = addDays(start, d);
    for (const s of sessionsOn(schedule, date))
      candidates.push(
        zonedTime(date, s.start, schedule.timeZone),
        zonedTime(date, s.end, schedule.timeZone),
      );
  }
  for (const t of candidates.filter((t) => t > timestamp).sort((a, b) => a - b))
    if (isOpen(schedule, t) !== state) return t;
  return null;
}
