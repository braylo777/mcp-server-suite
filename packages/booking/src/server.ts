import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { SCOPE_BOOKING, guardCall, toolError, toolJson, type ClientIdentity, type Logger, type RateLimiter } from "@braylo/mcp-core";

import { busyBlocks, expandEvent, findOpenSlots, MAX_DAYS_WALKED, MAX_SLOTS, MAX_WINDOW_MS, type Occurrence } from "./availability.js";
import type { HoursConfig } from "./hours.js";
import { readCalendar, type ParsedCalendar } from "./ics.js";

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const limits = {
  max_window_days: 366,
  max_days_walked: MAX_DAYS_WALKED,
  max_slots: MAX_SLOTS,
  recurrence: "DAILY, WEEKLY (BYDAY), MONTHLY (BYMONTHDAY). No yearly, no BYSETPOS, no RDATE.",
};

export interface BookingServerOptions {
  client: ClientIdentity;
  limiter: RateLimiter;
  logger: Logger;
  icsPath: string;
  hours: HoursConfig;
  version?: string;
}

export function createBookingServer(options: BookingServerOptions): McpServer {
  const server = new McpServer({ name: "braylo-booking", version: options.version ?? "0.1.0" });
  const guard = (tool: string, fn: () => Promise<ReturnType<typeof toolJson> | ReturnType<typeof toolError>>) =>
    guardCall({ client: options.client, limiter: options.limiter, logger: options.logger, tool, scope: SCOPE_BOOKING }, fn);

  server.registerTool(
    "describe_calendar",
    {
      title: "Describe calendar",
      description:
        "Read the .ics file and report the timezone, business hours, raw event count, and events this server will not expand. Does not list occurrences.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        path: z.string(),
        timezone: z.string(),
        hours: z.record(z.string(), z.array(z.tuple([z.string(), z.string()]))),
        vevents: z.number(),
        unsupported: z.array(z.object({ uid: z.string().nullable(), reason: z.string() })),
        limits: z.object({
          max_window_days: z.number(),
          max_days_walked: z.number(),
          max_slots: z.number(),
          recurrence: z.string(),
        }),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      guard("describe_calendar", async () => {
        const loaded = load(options);
        if ("error" in loaded) return loaded.error;
        return toolJson({
          path: options.icsPath,
          timezone: options.hours.timezone,
          hours: options.hours.hours,
          vevents: loaded.calendar.events.length,
          unsupported: loaded.calendar.issues,
          limits,
        });
      }),
  );

  server.registerTool(
    "list_events",
    {
      title: "List events",
      description:
        "Expand events that overlap [from, to). Instants must include Z or a numeric offset. The window cannot exceed 366 days. If any event in the file uses an unsupported rule, this refuses rather than hiding it.",
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      outputSchema: z.object({
        events: z.array(z.object({
          uid: z.string(),
          summary: z.string(),
          start: z.string(),
          end: z.string(),
          all_day: z.boolean(),
        })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard("list_events", async () => {
        const expanded = expandAll(options, args.from, args.to);
        if ("error" in expanded) return expanded.error;
        return toolJson({ events: expanded.occurrences });
      }),
  );

  server.registerTool(
    "busy_blocks",
    {
      title: "Busy blocks",
      description: "Merged half-open busy intervals for the window. Adjacent blocks are joined. Same refusal rule as list_events.",
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      outputSchema: z.object({ blocks: z.array(z.object({ start: z.string(), end: z.string() })) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard("busy_blocks", async () => {
        const expanded = expandAll(options, args.from, args.to);
        if ("error" in expanded) return expanded.error;
        return toolJson({ blocks: busyBlocks(expanded.occurrences) });
      }),
  );

  server.registerTool(
    "find_slots",
    {
      title: "Find open slots",
      description:
        "Slots that sit entirely inside one business-hours range and do not overlap busy time. duration_minutes and step_minutes are 5–480. step defaults to the duration. At most 200 slots are returned; truncated is true when more exist. A DST gap during the slot is skipped.",
      inputSchema: z.object({
        from: z.string(),
        to: z.string(),
        duration_minutes: z.number().int().min(5).max(480),
        step_minutes: z.number().int().min(5).max(240).optional(),
      }),
      outputSchema: z.object({
        timezone: z.string(),
        duration_minutes: z.number(),
        step_minutes: z.number(),
        slots: z.array(z.object({ start: z.string(), end: z.string(), start_local: z.string() })),
        truncated: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard("find_slots", async () => {
        const expanded = expandAll(options, args.from, args.to);
        if ("error" in expanded) return expanded.error;
        const step = args.step_minutes ?? args.duration_minutes;
        const found = findOpenSlots({
          hours: options.hours,
          from: expanded.from,
          to: expanded.to,
          durationMinutes: args.duration_minutes,
          stepMinutes: step,
          busy: busyBlocks(expanded.occurrences),
        });
        return toolJson({
          timezone: options.hours.timezone,
          duration_minutes: args.duration_minutes,
          step_minutes: step,
          slots: found.slots,
          truncated: found.truncated,
        });
      }),
  );

  return server;
}

function load(options: BookingServerOptions): { calendar: ParsedCalendar } | { error: ReturnType<typeof toolError> } {
  try {
    return { calendar: readCalendar(options.icsPath, options.hours.timezone) };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return { error: toolError("not_found", "Calendar file does not exist.", { path: options.icsPath }) };
    if (code === "PAYLOAD") return { error: toolError("payload_too_large", error instanceof Error ? error.message : "Calendar file is too large.") };
    return { error: toolError("internal", "Could not read the calendar file.") };
  }
}

function expandAll(
  options: BookingServerOptions,
  fromText: string,
  toText: string,
): { occurrences: Occurrence[]; from: Date; to: Date } | { error: ReturnType<typeof toolError> } {
  const window = parseWindow(fromText, toText);
  if ("error" in window) return window;
  const loaded = load(options);
  if ("error" in loaded) return loaded;
  if (loaded.calendar.issues.length > 0) {
    return {
      error: toolError("unsupported", "The calendar has events this server will not expand, so availability is refused.", {
        unsupported: loaded.calendar.issues,
      }),
    };
  }
  const occurrences = [];
  for (const event of loaded.calendar.events) {
    const expanded = expandEvent(event, window.from, window.to);
    if (!expanded.ok) {
      return { error: toolError("unsupported", "Recurrence walk hit its cap before the window ended.", { uid: event.uid, reason: expanded.reason }) };
    }
    occurrences.push(...expanded.occurrences);
  }
  return { occurrences, from: window.from, to: window.to };
}

function parseWindow(fromText: string, toText: string): { from: Date; to: Date } | { error: ReturnType<typeof toolError> } {
  if (!INSTANT.test(fromText) || !INSTANT.test(toText)) {
    return { error: toolError("invalid_input", "from and to must be ISO-8601 instants with Z or a numeric offset, including seconds.", { field: "from" }) };
  }
  const from = new Date(fromText);
  const to = new Date(toText);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: toolError("invalid_input", "from or to is not a real instant.") };
  }
  if (to.getTime() <= from.getTime()) return { error: toolError("invalid_input", "to must be after from.") };
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return { error: toolError("invalid_input", "The window is longer than 366 days.", { max_window_ms: MAX_WINDOW_MS }) };
  }
  return { from, to };
}
