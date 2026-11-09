import type { CallToolResult } from "@modelcontextprotocol/server";

import type { ClientIdentity } from "./auth.js";
import { toolError } from "./errors.js";
import type { Logger } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";
import { hasScope } from "./scopes.js";

export interface GuardContext {
  client: ClientIdentity;
  limiter: RateLimiter;
  logger: Logger;
  tool: string;
  scope: string;
}

/**
 * Scope check, then one rate-limit token, then the tool body.
 * A missing scope does not consume the limit. Schema rejection happens in the
 * SDK before this runs, so a bad shape does not consume the limit either.
 * The limiter counts the call even when the body returns a tool error.
 */
export async function guardCall(ctx: GuardContext, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  if (!hasScope(ctx.client.scopes, ctx.scope)) {
    ctx.logger.info("forbidden", { tool: ctx.tool, clientId: ctx.client.clientId, scope: ctx.scope });
    return toolError("forbidden", `Missing scope ${ctx.scope}.`, { required_scope: ctx.scope });
  }
  const decision = ctx.limiter.take(ctx.client.clientId);
  if (!decision.allowed) {
    ctx.logger.warn("rate_limited", {
      tool: ctx.tool,
      clientId: ctx.client.clientId,
      retry_after_ms: decision.retryAfterMs,
      limit: decision.limit,
    });
    return toolError("rate_limited", "Rate limit exceeded for this client.", {
      limit: decision.limit,
      window_ms: decision.windowMs,
      retry_after_ms: decision.retryAfterMs,
    });
  }
  const started = Date.now();
  try {
    const result = await fn();
    ctx.logger.info(result.isError ? "tool_error" : "tool_ok", {
      tool: ctx.tool,
      clientId: ctx.client.clientId,
      ms: Date.now() - started,
    });
    return result;
  } catch (error) {
    ctx.logger.error("tool_threw", {
      tool: ctx.tool,
      clientId: ctx.client.clientId,
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : "unknown error",
    });
    return toolError("internal", "The tool failed before it could finish.");
  }
}
