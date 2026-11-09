export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function utcToWall(utcMs: number, timeZone: string): WallTime {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type);
    if (!part) throw new Error(`Intl did not return ${type}`);
    return Number(part.value);
  };
  let hour = pick("hour");
  const wall: WallTime = {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour,
    minute: pick("minute"),
    second: pick("second"),
  };
  // Some engines report midnight as 24:00 on the previous date.
  if (hour === 24) {
    wall.hour = 0;
    return addDays(wall, 1);
  }
  return wall;
}

/**
 * Convert a wall-clock time in an IANA zone to UTC.
 * A spring-forward gap throws `nonexistent_local_time`.
 * A fall-back overlap resolves to the offset in force after the second
 * correction (the later pass). Tests lock the chosen instant.
 */
export function wallTimeToUtc(wall: WallTime, timeZone: string): Date {
  if (!isTimeZone(timeZone)) throw new Error(`unknown_timezone:${timeZone}`);
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const first = offsetMs(guess, timeZone);
  let utc = guess - first;
  const second = offsetMs(utc, timeZone);
  if (second !== first) utc = guess - second;
  const back = utcToWall(utc, timeZone);
  if (!sameWall(back, wall)) throw new Error("nonexistent_local_time");
  return new Date(utc);
}

export function addDays(wall: WallTime, days: number): WallTime {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
  };
}

export function dateOrdinal(wall: WallTime): number {
  return Math.floor(Date.UTC(wall.year, wall.month - 1, wall.day) / 86_400_000);
}

export function weekdayIndex(wall: WallTime): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/** Monday-based week ordinal. Weekday math for RRULE uses Monday as WKST. */
export function mondayOrdinal(wall: WallTime): number {
  const ordinal = dateOrdinal(wall);
  const fromMonday = (weekdayIndex(wall) + 6) % 7;
  return ordinal - fromMonday;
}

export function ymd(wall: WallTime): string {
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}`;
}

export function hm(wall: WallTime): string {
  return `${pad(wall.hour, 2)}:${pad(wall.minute, 2)}`;
}

export function parseHm(value: string): number | undefined {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (!match || !match[1] || !match[2]) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function offsetMs(utcMs: number, timeZone: string): number {
  const wall = utcToWall(utcMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - utcMs;
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
