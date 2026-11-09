import { resolve } from "node:path";

import { createLogger, type Logger, type RateLimiter } from "@braylo/mcp-core";
import type { ClientIdentity } from "@braylo/mcp-core";

import { createLeadsServer } from "./server.js";
import { LeadStore } from "./store.js";

export function openLeads(options: { env: NodeJS.ProcessEnv; limiter: RateLimiter; logger: Logger }) {
  const configured = options.env.MCP_LEADS_DB;
  const dbPath = configured && configured.length > 0 ? configured : resolve("data/leads.sqlite");
  const store = new LeadStore(dbPath);
  options.logger.info("leads_db", { path: dbPath });
  return {
    serverFor(client: ClientIdentity) {
      return createLeadsServer({
        client,
        store,
        limiter: options.limiter,
        logger: options.logger,
      });
    },
    close() {
      store.close();
    },
  };
}

export function silentLogger(): Logger {
  return createLogger({ server: "braylo-leads", level: "error", stream: { write() {} } });
}
