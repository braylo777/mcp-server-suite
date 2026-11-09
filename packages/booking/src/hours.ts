import { ConfigError } from "@braylo/mcp-core";

import { isTimeZone, parseHm } from "./time.js";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface HoursConfig {
  timezone: string;
  hours: Record<Weekday, Array<[string, string]>>;
}

export const DEFAULT_HOURS: HoursConfig = {
  timezone: "UTC",
  hours: {
    sun: [],
    mon: [["09:00", "17:00"]],
    tue: [["09:00", "17:00"]],
    wed: [["09:00", "17:00"]],
    thu: [["09:00", "17:00"]],
    fri: [["09:00", "17:00"]],
    sat: [],
  },
};

export function hoursFromEnv(env: NodeJS.ProcessEnv): HoursConfig {
  const file = env.MCP_BOOKING_HOURS_JSON;
  const tz = env.MCP_BOOKING_TZ;
  if (!file || file.trim() === "") {
    if (!tz || tz === "UTC") return DEFAULT_HOURS;
    if (!isTimeZone(tz)) throw new ConfigError(`MCP_BOOKING_TZ is not an IANA time zone: ${tz}`);
    return { timezone: tz, hours: DEFAULT_HOURS.hours };
  }
  return parseHoursJson(file, tz);
}

export function parseHoursJson(text: string, tzFallback: string | undefined): HoursConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError("MCP_BOOKING_HOURS_JSON is not JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new ConfigError("Hours JSON must be an object.");
  const row = parsed as Record<string, unknown>;
  const timezone = typeof row.timezone === "string" && row.timezone.length > 0 ? row.timezone : tzFallback ?? "UTC";
  if (!isTimeZone(timezone)) throw new ConfigError(`Booking timezone is not an IANA time zone: ${timezone}`);
  const source = row.hours;
  if (source !== undefined && (typeof source !== "object" || source === null)) {
    throw new ConfigError("hours must be an object keyed by sun…sat.");
  }
  const hours = emptyHours();
  const table = (source ?? {}) as Record<string, unknown>;
  for (const day of WEEKDAYS) {
    const ranges = table[day];
    if (ranges === undefined) continue;
    if (!Array.isArray(ranges)) throw new ConfigError(`hours.${day} must be an array of [start, end] pairs.`);
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || typeof range[0] !== "string" || typeof range[1] !== "string") {
        throw new ConfigError(`hours.${day} entries must be ["HH:MM", "HH:MM"].`);
      }
      const start = parseHm(range[0]);
      const end = parseHm(range[1]);
      if (start === undefined || end === undefined || start >= end) {
        throw new ConfigError(`hours.${day} has an unusable range ${range[0]}–${range[1]}.`);
      }
      hours[day].push([range[0], range[1]]);
    }
  }
  return { timezone, hours };
}

function emptyHours(): HoursConfig["hours"] {
  return { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
}
