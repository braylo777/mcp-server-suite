import type { ClientIdentity, Logger, RateLimiter } from "@braylo/mcp-core";

import { createAuditServer } from "./server.js";

export function openPageAudit(options: { env: NodeJS.ProcessEnv; limiter: RateLimiter; logger: Logger }) {
  const allowPrivate = options.env.MCP_AUDIT_ALLOW_PRIVATE === "1";
  if (allowPrivate) {
    options.logger.warn("audit_allow_private", {
      warning: "MCP_AUDIT_ALLOW_PRIVATE=1 lets this process fetch loopback and private addresses, including link-local metadata.",
    });
  }
  return {
    serverFor(client: ClientIdentity) {
      return createAuditServer({
        client,
        limiter: options.limiter,
        logger: options.logger,
        allowPrivate,
      });
    },
  };
}
