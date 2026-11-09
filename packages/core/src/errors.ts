import type { CallToolResult } from "@modelcontextprotocol/server";

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "rate_limited",
  "invalid_input",
  "not_found",
  "conflict",
  "payload_too_large",
  "upstream",
  "unsupported",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function toolError(code: ErrorCode, message: string, details?: Record<string, unknown>): CallToolResult {
  const error: ToolErrorBody["error"] = { code, message };
  if (details && Object.keys(details).length > 0) error.details = details;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error }) }],
  };
}

export function toolJson(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export class ConfigError extends Error {
  readonly code = "config" as const;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
