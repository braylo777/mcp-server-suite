import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  server: string;
  level?: LogLevel;
  stream?: { write(chunk: string): void };
  now?: () => Date;
}

export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  if (value === undefined || value === "") return "info";
  throw new Error(`LOG_LEVEL must be debug, info, warn, or error. Got ${JSON.stringify(value)}.`);
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? "info";
  const stream = options.stream ?? process.stderr;
  const now = options.now ?? (() => new Date());
  const write = (entryLevel: LogLevel, msg: string, fields?: LogFields): void => {
    if (RANK[entryLevel] < RANK[level]) return;
    const payload: Record<string, unknown> = {
      ts: now().toISOString(),
      level: entryLevel,
      server: options.server,
      msg,
    };
    if (fields) {
      const safe = redact(fields);
      if (safe && typeof safe === "object" && !Array.isArray(safe)) {
        Object.assign(payload, safe);
      }
    }
    try {
      stream.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Logging must not take down a tool call.
    }
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
