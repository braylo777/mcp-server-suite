export { issueHmacBearer, loadAuthConfig, processClient, safeEqualString, verifyBearer, createVerifier } from "./auth.js";
export type { ApiKeyRecord, AuthConfig, ClientIdentity, LoadedAuth } from "./auth.js";
export { bootServer, parseCliArgs, allowedHostsFromEnv } from "./boot.js";
export type { BootOptions, OpenedServer, RunningServer } from "./boot.js";
export { ConfigError, toolError, toolJson } from "./errors.js";
export type { ErrorCode, ToolErrorBody } from "./errors.js";
export { ERROR_CODES } from "./errors.js";
export { guardCall } from "./guard.js";
export type { GuardContext } from "./guard.js";
export { startHttpServer, defaultAllowedHosts } from "./http.js";
export type { HttpServerOptions, RunningHttpServer } from "./http.js";
export { createLogger, parseLogLevel } from "./log.js";
export type { LogFields, LogLevel, Logger } from "./log.js";
export { RateLimiter, authFailLimiterFromEnv, rateLimiterFromEnv } from "./rate-limit.js";
export type { RateDecision, RateLimiterOptions } from "./rate-limit.js";
export { redact } from "./redact.js";
export {
  DEFAULT_SCOPES,
  SCOPE_AUDIT,
  SCOPE_BOOKING,
  SCOPE_LEADS_READ,
  SCOPE_LEADS_WRITE,
  SCOPE_MCP,
  STATIC_KEY_REPORTED_TTL_SECONDS,
  hasScope,
} from "./scopes.js";
