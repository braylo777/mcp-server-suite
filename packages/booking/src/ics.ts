import { readFileSync } from "node:fs";

import { addDays, isTimeZone, utcToWall, wallTimeToUtc, ymd, type WallTime } from "./time.js";

export const MAX_ICS_BYTES = 2_000_000;
export const MAX_VEVENTS = 5_000;

export interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  count?: number;
  until?: Date;
  /** 0 = Sunday … 6 = Saturday. Weekly only. */
  byday?: number[];
  bymonthday?: number;
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  allDay: boolean;
  /** Calendar days for an all-day event. 0 for timed events. */
  allDayDays: number;
  start: Date;
  end: Date;
  zone: string;
  rrule?: RRule;
  exdates: Date[];
  exdateDays: string[];
}

export interface ParseIssue {
  uid: string | null;
  reason: string;
}

export interface ParsedCalendar {
  events: CalendarEvent[];
  issues: ParseIssue[];
}

const DAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function readCalendar(path: string, defaultZone: string): ParsedCalendar {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      const missing = new Error(`Calendar file not found: ${path}`);
      (missing as Error & { code: string }).code = "ENOENT";
      throw missing;
    }
    throw error;
  }
  if (Buffer.byteLength(text) > MAX_ICS_BYTES) {
    const error = new Error(`Calendar file exceeds ${MAX_ICS_BYTES} bytes.`);
    (error as Error & { code: string }).code = "PAYLOAD";
    throw error;
  }
  return parseCalendar(text, defaultZone);
}

export function parseCalendar(text: string, defaultZone: string): ParsedCalendar {
  if (!isTimeZone(defaultZone)) {
    return { events: [], issues: [{ uid: null, reason: `bad_timezone:${defaultZone}` }] };
  }
  const lines = unfold(text);
  const events: CalendarEvent[] = [];
  const issues: ParseIssue[] = [];
  let mode: "idle" | "event" | "skip" = "idle";
  let skipDepth = 0;
  let buffer: string[] = [];
  let sawCalendar = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VCALENDAR") sawCalendar = true;
    if (mode === "skip") {
      if (upper.startsWith("BEGIN:")) skipDepth += 1;
      else if (upper.startsWith("END:")) {
        skipDepth -= 1;
        if (skipDepth <= 0) mode = "idle";
      }
      continue;
    }
    if (upper === "BEGIN:VTIMEZONE" || upper === "BEGIN:VALARM") {
      mode = "skip";
      skipDepth = 1;
      continue;
    }
    if (upper === "BEGIN:VEVENT") {
      mode = "event";
      buffer = [];
      continue;
    }
    if (upper === "END:VEVENT") {
      const built = buildEvent(buffer, defaultZone, events.length + issues.length + 1);
      if (built.event) events.push(built.event);
      if (built.issue) issues.push(built.issue);
      if (events.length + issues.length > MAX_VEVENTS) {
        issues.push({ uid: null, reason: "too_many_events" });
        break;
      }
      mode = "idle";
      buffer = [];
      continue;
    }
    if (mode === "event") buffer.push(line);
  }
  if (!sawCalendar && events.length === 0 && issues.length === 0) {
    issues.push({ uid: null, reason: "not_a_calendar" });
  }
  return { events, issues };
}

function buildEvent(lines: string[], defaultZone: string, index: number): { event?: CalendarEvent; issue?: ParseIssue } {
  const props = lines.map(parseLine).filter((line): line is Line => line !== undefined);
  const uid = unescapeText(prop(props, "UID")?.value ?? "") || `untitled-${index}`;
  const summary = unescapeText(prop(props, "SUMMARY")?.value ?? "") || "(no summary)";
  const startLine = prop(props, "DTSTART");
  if (!startLine) return { issue: { uid, reason: "missing_dtstart" } };
  const start = parseWhen(startLine, defaultZone);
  if (!start.ok) return { issue: { uid, reason: start.reason } };
  const endLine = prop(props, "DTEND");
  const durationLine = prop(props, "DURATION");
  if (endLine && durationLine) return { issue: { uid, reason: "dtend_and_duration" } };

  let end: Date;
  let allDayDays = 0;
  if (endLine) {
    const parsedEnd = parseWhen(endLine, start.zone);
    if (!parsedEnd.ok) return { issue: { uid, reason: parsedEnd.reason } };
    if (parsedEnd.allDay !== start.allDay) return { issue: { uid, reason: "mixed_date_and_time" } };
    end = parsedEnd.date;
  } else if (durationLine) {
    const ms = parseDuration(durationLine.value);
    if (ms === undefined || ms <= 0) return { issue: { uid, reason: "bad_duration" } };
    if (start.allDay && ms % 86_400_000 === 0) {
      allDayDays = ms / 86_400_000;
      end = wallTimeToUtc(addDays({ ...start.wall, hour: 0, minute: 0, second: 0 }, allDayDays), start.zone);
    } else {
      end = new Date(start.date.getTime() + ms);
    }
  } else if (start.allDay) {
    allDayDays = 1;
    end = wallTimeToUtc(addDays({ ...start.wall, hour: 0, minute: 0, second: 0 }, 1), start.zone);
  } else {
    return { issue: { uid, reason: "missing_end" } };
  }
  if (end.getTime() <= start.date.getTime()) return { issue: { uid, reason: "end_not_after_start" } };
  if (start.allDay) {
    allDayDays = Math.max(1, Math.round((end.getTime() - start.date.getTime()) / 86_400_000));
    const startWall = utcToWall(start.date.getTime(), start.zone);
    const endWall = utcToWall(end.getTime(), start.zone);
    const calendarDays = (Date.UTC(endWall.year, endWall.month - 1, endWall.day) - Date.UTC(startWall.year, startWall.month - 1, startWall.day)) / 86_400_000;
    if (Number.isFinite(calendarDays) && calendarDays >= 1) allDayDays = calendarDays;
  }

  const ruleLine = prop(props, "RRULE");
  let rrule: RRule | undefined;
  if (ruleLine) {
    const parsed = parseRrule(ruleLine.value, start.zone);
    if (!parsed.ok) return { issue: { uid, reason: parsed.reason } };
    rrule = parsed.rule;
  }

  const exdates: Date[] = [];
  const exdateDays: string[] = [];
  for (const line of props.filter((item) => item.name === "EXDATE")) {
    for (const value of line.value.split(",")) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const parsed = parseWhen({ name: "EXDATE", params: line.params, value: trimmed }, start.zone);
      if (!parsed.ok) return { issue: { uid, reason: parsed.reason } };
      if (parsed.allDay) exdateDays.push(ymd(parsed.wall));
      else exdates.push(parsed.date);
    }
  }

  const event: CalendarEvent = {
    uid,
    summary,
    allDay: start.allDay,
    allDayDays,
    start: start.date,
    end,
    zone: start.zone,
    exdates,
    exdateDays,
  };
  if (rrule) event.rrule = rrule;
  return { event };
}

interface WhenOk {
  ok: true;
  date: Date;
  wall: WallTime;
  allDay: boolean;
  zone: string;
}

function parseWhen(line: Line, defaultZone: string): WhenOk | { ok: false; reason: string } {
  const value = line.value.trim();
  const tzid = line.params.TZID;
  const dateOnly = line.params.VALUE === "DATE" || /^\d{8}$/.test(value);
  if (tzid && value.endsWith("Z")) return { ok: false, reason: "conflicting_time" };
  if (dateOnly) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!match || !match[1] || !match[2] || !match[3]) return { ok: false, reason: "bad_date" };
    const zone = tzid ?? defaultZone;
    if (!isTimeZone(zone)) return { ok: false, reason: `bad_timezone:${zone}` };
    const wall = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0, second: 0 };
    if (!realDate(wall)) return { ok: false, reason: "bad_date" };
    try {
      return { ok: true, date: wallTimeToUtc(wall, zone), wall, allDay: true, zone };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "bad_date" };
    }
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!match || !match[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) {
    return { ok: false, reason: "bad_datetime" };
  }
  const wall = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  };
  if (!realDate(wall) || wall.hour > 23) return { ok: false, reason: "bad_datetime" };
  const zone = match[7] === "Z" ? "UTC" : tzid ?? defaultZone;
  if (!isTimeZone(zone)) return { ok: false, reason: `bad_timezone:${zone}` };
  try {
    return { ok: true, date: wallTimeToUtc(wall, zone), wall, allDay: false, zone };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "bad_datetime" };
  }
}

function parseRrule(value: string, zone: string): { ok: true; rule: RRule } | { ok: false; reason: string } {
  const parts = new Map<string, string>();
  for (const piece of value.split(";")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) return { ok: false, reason: "bad_rrule" };
    parts.set(piece.slice(0, eq).toUpperCase(), piece.slice(eq + 1));
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") {
    return { ok: false, reason: freq ? `unsupported_freq:${freq}` : "bad_rrule" };
  }
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return { ok: false, reason: "bad_interval" };
  if (parts.has("COUNT") && parts.has("UNTIL")) return { ok: false, reason: "count_and_until" };
  const rule: RRule = { freq, interval };
  if (parts.has("COUNT")) {
    const count = Number(parts.get("COUNT"));
    if (!Number.isInteger(count) || count < 1 || count > 10_000) return { ok: false, reason: "bad_count" };
    rule.count = count;
  }
  if (parts.has("UNTIL")) {
    const until = parseWhen({ name: "UNTIL", params: {}, value: parts.get("UNTIL") ?? "" }, zone);
    if (!until.ok) return { ok: false, reason: "bad_until" };
    rule.until = until.date;
  }
  if (parts.has("BYDAY")) {
    if (freq !== "WEEKLY") return { ok: false, reason: "unsupported_byday" };
    const days = (parts.get("BYDAY") ?? "").split(",");
    const indexes: number[] = [];
    for (const day of days) {
      const index = DAY_INDEX[day.toUpperCase()];
      if (index === undefined) return { ok: false, reason: "bad_byday" };
      indexes.push(index);
    }
    rule.byday = indexes;
  }
  if (parts.has("BYMONTHDAY")) {
    if (freq !== "MONTHLY") return { ok: false, reason: "unsupported_bymonthday" };
    const day = Number(parts.get("BYMONTHDAY"));
    if (!Number.isInteger(day) || day < 1 || day > 31) return { ok: false, reason: "bad_bymonthday" };
    rule.bymonthday = day;
  }
  for (const key of parts.keys()) {
    if (!["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "WKST"].includes(key)) {
      return { ok: false, reason: `unsupported_rrule_part:${key}` };
    }
  }
  return { ok: true, rule };
}

function parseDuration(value: string): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  if (days + hours + minutes + seconds === 0) return undefined;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Line | undefined {
  const colon = line.indexOf(":");
  if (colon <= 0) return undefined;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const bits = left.split(";");
  const name = bits[0]?.toUpperCase();
  if (!name) return undefined;
  const params: Record<string, string> = {};
  for (const bit of bits.slice(1)) {
    const eq = bit.indexOf("=");
    if (eq <= 0) continue;
    params[bit.slice(0, eq).toUpperCase()] = bit.slice(eq + 1);
  }
  return { name, params, value };
}

function prop(lines: Line[], name: string): Line | undefined {
  return lines.find((line) => line.name === name);
}

function unfold(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines: string[] = [];
  for (const line of normalized.split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      const previous = lines[lines.length - 1] ?? "";
      lines[lines.length - 1] = previous + line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function realDate(wall: WallTime): boolean {
  const check = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  return check.getUTCFullYear() === wall.year && check.getUTCMonth() === wall.month - 1 && check.getUTCDate() === wall.day;
}
