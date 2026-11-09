import type { CalendarEvent } from "./ics.js";
import {
  addDays,
  dateOrdinal,
  hm,
  mondayOrdinal,
  parseHm,
  utcToWall,
  wallTimeToUtc,
  weekdayIndex,
  ymd,
  type WallTime,
} from "./time.js";
import type { HoursConfig } from "./hours.js";
import { WEEKDAYS } from "./hours.js";

export const MAX_DAYS_WALKED = 20_000;
export const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
export const MAX_SLOTS = 200;

export interface Occurrence {
  uid: string;
  summary: string;
  start: string;
  end: string;
  all_day: boolean;
}

export interface BusyBlock {
  start: string;
  end: string;
}

export interface Slot {
  start: string;
  end: string;
  start_local: string;
}

export function expandEvent(
  event: CalendarEvent,
  windowStart: Date,
  windowEnd: Date,
): { ok: true; occurrences: Occurrence[] } | { ok: false; reason: "recurrence_cap" } {
  if (!event.rrule) {
    const occurrences = overlaps(event.start, event.end, windowStart, windowEnd) ? [toOccurrence(event, event.start, event.end)] : [];
    return { ok: true, occurrences };
  }
  const rule = event.rrule;
  const startWall = utcToWall(event.start.getTime(), event.zone);
  const occurrences: Occurrence[] = [];
  let produced = 0;
  let walked = 0;
  let cursor = atMidnight(startWall);
  if (rule.count === undefined) {
    const nearWindow = utcToWall(windowStart.getTime() - 8 * 86_400_000, event.zone);
    if (dateOrdinal(nearWindow) > dateOrdinal(cursor)) cursor = atMidnight(nearWindow);
  }
  const last = utcToWall(windowEnd.getTime() + 86_400_000, event.zone);
  while (walked < MAX_DAYS_WALKED) {
    walked += 1;
    if (dateOrdinal(cursor) > dateOrdinal(last)) break;
    if (ruleMatches(rule, startWall, cursor)) {
      let occStart: Date;
      let occEnd: Date;
      try {
        if (event.allDay) {
          const midnight = atMidnight(cursor);
          occStart = wallTimeToUtc(midnight, event.zone);
          occEnd = wallTimeToUtc(addDays(midnight, event.allDayDays), event.zone);
        } else {
          occStart = wallTimeToUtc(
            { ...cursor, hour: startWall.hour, minute: startWall.minute, second: startWall.second },
            event.zone,
          );
          occEnd = new Date(occStart.getTime() + (event.end.getTime() - event.start.getTime()));
        }
      } catch {
        cursor = addDays(cursor, 1);
        continue;
      }
      if (occStart.getTime() < event.start.getTime()) {
        cursor = addDays(cursor, 1);
        continue;
      }
      if (rule.until && occStart.getTime() > rule.until.getTime()) break;
      if (rule.count !== undefined && produced >= rule.count) break;
      const excluded =
        event.exdates.some((date) => date.getTime() === occStart.getTime()) || event.exdateDays.includes(ymd(cursor));
      if (!excluded && overlaps(occStart, occEnd, windowStart, windowEnd)) {
        occurrences.push(toOccurrence(event, occStart, occEnd));
      }
      produced += 1;
    }
    cursor = addDays(cursor, 1);
  }
  if (walked >= MAX_DAYS_WALKED && dateOrdinal(cursor) <= dateOrdinal(last)) {
    return { ok: false, reason: "recurrence_cap" };
  }
  return { ok: true, occurrences };
}

export function busyBlocks(occurrences: Occurrence[]): BusyBlock[] {
  const sorted = occurrences
    .map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end) }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const block of sorted) {
    const last = merged[merged.length - 1];
    if (!last || block.start > last.end) merged.push({ ...block });
    else last.end = Math.max(last.end, block.end);
  }
  return merged.map((block) => ({ start: new Date(block.start).toISOString(), end: new Date(block.end).toISOString() }));
}

export function findOpenSlots(input: {
  hours: HoursConfig;
  from: Date;
  to: Date;
  durationMinutes: number;
  stepMinutes: number;
  busy: BusyBlock[];
}): { slots: Slot[]; truncated: boolean } {
  const slots: Slot[] = [];
  let truncated = false;
  const busy = input.busy.map((block) => ({ start: Date.parse(block.start), end: Date.parse(block.end) }));
  let day = atMidnight(utcToWall(input.from.getTime(), input.hours.timezone));
  const lastDay = atMidnight(utcToWall(input.to.getTime(), input.hours.timezone));
  while (dateOrdinal(day) <= dateOrdinal(lastDay)) {
    const weekday = WEEKDAYS[weekdayIndex(day)];
    if (!weekday) break;
    const ranges = input.hours.hours[weekday];
    for (const range of ranges) {
      const open = parseHm(range[0]);
      const close = parseHm(range[1]);
      if (open === undefined || close === undefined) continue;
      for (let minute = open; minute + input.durationMinutes <= close; minute += input.stepMinutes) {
        const wall: WallTime = {
          ...day,
          hour: Math.floor(minute / 60),
          minute: minute % 60,
          second: 0,
        };
        let start: Date;
        try {
          start = wallTimeToUtc(wall, input.hours.timezone);
        } catch {
          continue;
        }
        const end = new Date(start.getTime() + input.durationMinutes * 60_000);
        if (start < input.from || end > input.to) continue;
        const hitsBusy = busy.some((block) => start.getTime() < block.end && end.getTime() > block.start);
        if (hitsBusy) continue;
        if (slots.length >= MAX_SLOTS) {
          truncated = true;
          return { slots, truncated };
        }
        slots.push({
          start: start.toISOString(),
          end: end.toISOString(),
          start_local: `${ymd(wall)}T${hm(wall)}`,
        });
      }
    }
    day = addDays(day, 1);
  }
  return { slots, truncated };
}

function ruleMatches(rule: CalendarEvent["rrule"], start: WallTime, cursor: WallTime): boolean {
  if (!rule) return false;
  if (rule.freq === "DAILY") {
    const delta = dateOrdinal(cursor) - dateOrdinal(start);
    return delta >= 0 && delta % rule.interval === 0;
  }
  if (rule.freq === "WEEKLY") {
    const days = rule.byday ?? [weekdayIndex(start)];
    if (!days.includes(weekdayIndex(cursor))) return false;
    const weeks = (mondayOrdinal(cursor) - mondayOrdinal(start)) / 7;
    return weeks >= 0 && weeks % rule.interval === 0;
  }
  const wanted = rule.bymonthday ?? start.day;
  if (cursor.day !== wanted) return false;
  const months = (cursor.year - start.year) * 12 + (cursor.month - start.month);
  return months >= 0 && months % rule.interval === 0;
}

function overlaps(start: Date, end: Date, windowStart: Date, windowEnd: Date): boolean {
  return start < windowEnd && end > windowStart;
}

function toOccurrence(event: CalendarEvent, start: Date, end: Date): Occurrence {
  return {
    uid: event.uid,
    summary: event.summary,
    start: start.toISOString(),
    end: end.toISOString(),
    all_day: event.allDay,
  };
}

function atMidnight(wall: WallTime): WallTime {
  return { year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0, second: 0 };
}
