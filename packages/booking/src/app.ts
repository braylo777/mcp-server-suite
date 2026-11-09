import { ConfigError, type ClientIdentity, type Logger, type RateLimiter } from "@braylo/mcp-core";

import { hoursFromEnv } from "./hours.js";
import { createBookingServer } from "./server.js";

export function openBooking(options: { env: NodeJS.ProcessEnv; limiter: RateLimiter; logger: Logger }) {
  const icsPath = options.env.MCP_BOOKING_ICS;
  if (!icsPath || icsPath.trim() === "") {
    throw new ConfigError("Set MCP_BOOKING_ICS to a local .ics file. There is no default calendar, because an empty one would look free.");
  }
  const hours = hoursFromEnv(options.env);
  options.logger.info("booking_calendar", { path: icsPath, timezone: hours.timezone });
  return {
    serverFor(client: ClientIdentity) {
      return createBookingServer({
        client,
        limiter: options.limiter,
        logger: options.logger,
        icsPath,
        hours,
      });
    },
  };
}
