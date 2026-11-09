import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RateLimiter, SCOPE_BOOKING, SCOPE_MCP } from "@braylo/mcp-core";
import { quietLogger, readResult, testClient, withClient } from "../../../test/mcp.ts";
import { DEFAULT_HOURS, parseHoursJson } from "../src/hours.ts";
import { createBookingServer } from "../src/server.ts";
import { utcToWall, wallTimeToUtc } from "../src/time.ts";

function writeIcs(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "booking-"));
  const path = join(dir, "shop.ics");
  writeFileSync(path, body);
  return path;
}

function serverFor(ics: string, hours = DEFAULT_HOURS, limit = 30) {
  return createBookingServer({
    client: testClient([SCOPE_MCP, SCOPE_BOOKING]),
    limiter: new RateLimiter({ limit, windowMs: 60_000 }),
    logger: quietLogger("booking"),
    icsPath: writeIcs(ics),
    hours,
  });
}

const CALENDAR = (body: string) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//braylo//test//EN\n${body}\nEND:VCALENDAR\n`;

test("wall-clock conversion handles standard time, daylight time, and a spring-forward gap", () => {
  const winter = wallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0, second: 0 }, "America/New_York");
  const summer = wallTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9, minute: 0, second: 0 }, "America/New_York");
  assert.equal(winter.toISOString(), "2026-01-15T14:00:00.000Z");
  assert.equal(summer.toISOString(), "2026-07-15T13:00:00.000Z");
  assert.equal(utcToWall(winter.getTime(), "America/New_York").hour, 9);
  assert.throws(
    () => wallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, "America/New_York"),
    /nonexistent_local_time/,
  );
});

test("weekly recurrence, an EXDATE, and a folded summary", async () => {
  const ics = CALENDAR(`BEGIN:VEVENT
UID:weekly-1
SUMMARY:Stand
 ing
DTSTART:20260105T150000Z
DTEND:20260105T160000Z
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
EXDATE:20260112T150000Z
END:VEVENT`);
  const server = serverFor(ics);
  await withClient(server, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["busy_blocks", "describe_calendar", "find_slots", "list_events"]);
    const listed = readResult(await client.callTool({
      name: "list_events",
      arguments: { from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
    }));
    const events = (listed.body as { events: { start: string; summary: string }[] }).events;
    assert.deepEqual(events.map((event) => event.start), [
      "2026-01-05T15:00:00.000Z",
      "2026-01-19T15:00:00.000Z",
      "2026-01-26T15:00:00.000Z",
    ]);
    assert.equal(events[0]?.summary, "Standing");
  });
});

test("slots skip a busy hour, refuse to cross a lunch gap, and an all-day event blocks the day", async () => {
  const busy = serverFor(CALENDAR(`BEGIN:VEVENT
UID:busy-1
SUMMARY:Install
DTSTART:20260106T100000Z
DTEND:20260106T110000Z
END:VEVENT`));
  await withClient(busy, async (client) => {
    const result = readResult(await client.callTool({
      name: "find_slots",
      arguments: { from: "2026-01-06T00:00:00Z", to: "2026-01-07T00:00:00Z", duration_minutes: 60, step_minutes: 60 },
    }));
    const slots = (result.body as { slots: { start: string }[] }).slots.map((slot) => slot.start);
    assert.deepEqual(slots, [
      "2026-01-06T09:00:00.000Z",
      "2026-01-06T11:00:00.000Z",
      "2026-01-06T12:00:00.000Z",
      "2026-01-06T13:00:00.000Z",
      "2026-01-06T14:00:00.000Z",
      "2026-01-06T15:00:00.000Z",
      "2026-01-06T16:00:00.000Z",
    ]);
  });

  const hours = parseHoursJson(JSON.stringify({
    timezone: "UTC",
    hours: { fri: [["09:00", "12:00"], ["13:00", "17:00"]] },
  }), undefined);
  const lunch = serverFor(CALENDAR(""), hours);
  await withClient(lunch, async (client) => {
    const result = readResult(await client.callTool({
      name: "find_slots",
      arguments: { from: "2026-01-09T00:00:00Z", to: "2026-01-10T00:00:00Z", duration_minutes: 60, step_minutes: 60 },
    }));
    const starts = (result.body as { slots: { start_local: string }[] }).slots.map((slot) => slot.start_local);
    assert.deepEqual(starts, [
      "2026-01-09T09:00",
      "2026-01-09T10:00",
      "2026-01-09T11:00",
      "2026-01-09T13:00",
      "2026-01-09T14:00",
      "2026-01-09T15:00",
      "2026-01-09T16:00",
    ]);
  });

  const allDay = serverFor(CALENDAR(`BEGIN:VEVENT
UID:closed
SUMMARY:Closed
DTSTART;VALUE=DATE:20260106
DTEND;VALUE=DATE:20260107
END:VEVENT`));
  await withClient(allDay, async (client) => {
    const result = readResult(await client.callTool({
      name: "find_slots",
      arguments: { from: "2026-01-06T00:00:00Z", to: "2026-01-07T00:00:00Z", duration_minutes: 30 },
    }));
    assert.deepEqual((result.body as { slots: unknown[] }).slots, []);
  });
});

test("a free Tuesday has 16 half-hour slots, a long window is rejected, and a yearly rule refuses the file", async () => {
  const free = serverFor(CALENDAR(""));
  await withClient(free, async (client) => {
    const result = readResult(await client.callTool({
      name: "find_slots",
      arguments: { from: "2026-01-06T00:00:00Z", to: "2026-01-07T00:00:00Z", duration_minutes: 30, step_minutes: 30 },
    }));
    assert.equal((result.body as { slots: unknown[] }).slots.length, 16);
    const tooLong = readResult(await client.callTool({
      name: "find_slots",
      arguments: { from: "2026-01-01T00:00:00Z", to: "2027-02-01T00:00:00Z", duration_minutes: 30 },
    }));
    assert.equal((tooLong.body as { error: { code: string } }).error.code, "invalid_input");
    const naive = readResult(await client.callTool({
      name: "list_events",
      arguments: { from: "2026-01-06", to: "2026-01-07T00:00:00Z" },
    }));
    assert.equal((naive.body as { error: { code: string } }).error.code, "invalid_input");
  });

  const yearly = serverFor(CALENDAR(`BEGIN:VEVENT
UID:year
SUMMARY:Anniversary
DTSTART:20260106T150000Z
DTEND:20260106T160000Z
RRULE:FREQ=YEARLY
END:VEVENT`));
  await withClient(yearly, async (client) => {
    const described = readResult(await client.callTool({ name: "describe_calendar", arguments: {} }));
    const unsupported = (described.body as { unsupported: { reason: string }[] }).unsupported;
    assert.equal(unsupported[0]?.reason, "unsupported_freq:YEARLY");
    const slots = readResult(await client.callTool({
      name: "find_slots",
      arguments: { from: "2026-01-06T00:00:00Z", to: "2026-01-07T00:00:00Z", duration_minutes: 30 },
    }));
    assert.equal((slots.body as { error: { code: string } }).error.code, "unsupported");
  });
});

test("a weekly 9:00 America/New_York meeting stays at 09:00 local across DST", async () => {
  const ics = CALENDAR(`BEGIN:VEVENT
UID:dst
SUMMARY:Shop hours check
DTSTART;TZID=America/New_York:20260107T090000
DTEND;TZID=America/New_York:20260107T100000
RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=30
END:VEVENT`);
  const hours = parseHoursJson(JSON.stringify({ timezone: "America/New_York", hours: DEFAULT_HOURS.hours }), undefined);
  const server = serverFor(ics, hours);
  await withClient(server, async (client) => {
    const winter = readResult(await client.callTool({
      name: "list_events",
      arguments: { from: "2026-01-07T00:00:00Z", to: "2026-01-08T00:00:00Z" },
    }));
    const summer = readResult(await client.callTool({
      name: "list_events",
      arguments: { from: "2026-07-08T00:00:00Z", to: "2026-07-09T00:00:00Z" },
    }));
    assert.equal((winter.body as { events: { start: string }[] }).events[0]?.start, "2026-01-07T14:00:00.000Z");
    assert.equal((summer.body as { events: { start: string }[] }).events[0]?.start, "2026-07-08T13:00:00.000Z");
  });
});

test("the third booking call is rate limited and a missing file is not_found", async () => {
  const server = createBookingServer({
    client: testClient([SCOPE_MCP, SCOPE_BOOKING]),
    limiter: new RateLimiter({ limit: 2, windowMs: 60_000 }),
    logger: quietLogger("booking"),
    icsPath: writeIcs(CALENDAR("")),
    hours: DEFAULT_HOURS,
  });
  await withClient(server, async (client) => {
    const args = { from: "2026-01-06T00:00:00Z", to: "2026-01-07T00:00:00Z" };
    await client.callTool({ name: "list_events", arguments: args });
    await client.callTool({ name: "list_events", arguments: args });
    const third = readResult(await client.callTool({ name: "list_events", arguments: args }));
    assert.equal((third.body as { error: { code: string } }).error.code, "rate_limited");
  });
  const missing = createBookingServer({
    client: testClient([SCOPE_MCP, SCOPE_BOOKING], "other"),
    limiter: new RateLimiter({ limit: 5, windowMs: 60_000 }),
    logger: quietLogger("booking"),
    icsPath: join(tmpdir(), "does-not-exist-braylo.ics"),
    hours: DEFAULT_HOURS,
  });
  await withClient(missing, async (client) => {
    const result = readResult(await client.callTool({ name: "describe_calendar", arguments: {} }));
    assert.equal((result.body as { error: { code: string } }).error.code, "not_found");
  });
});
