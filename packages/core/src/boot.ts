import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { McpServer } from "@modelcontextprotocol/server";

import {
  createVerifier,
  loadAuthConfig,
  processClient,
  type ClientIdentity,
} from "./auth.js";
import { ConfigError } from "./errors.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";
import { createLogger, parseLogLevel, type Logger } from "./log.js";
import { authFailLimiterFromEnv, rateLimiterFromEnv, type RateLimiter } from "./rate-limit.js";
import { localhostAllowedHostnames } from "@modelcontextprotocol/server";

export interface OpenedServer {
  serverFor: (client: ClientIdentity) => McpServer;
  close?: () => void;
}

export interface BootOptions {
  name: string;
  version: string;
  defaultPort: number;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  open: (ctx: { env: NodeJS.ProcessEnv; limiter: RateLimiter; logger: Logger }) => OpenedServer;
}

export interface RunningServer {
  transport: "stdio" | "http";
  url?: string;
  close: () => Promise<void>;
}

interface CliArgs {
  http: boolean;
  port: number;
  host: string;
}

export function parseCliArgs(argv: string[], defaultPort: number): CliArgs {
  let http = false;
  let port = defaultPort;
  let host = "127.0.0.1";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--http") {
      http = true;
      continue;
    }
    if (arg === "--port") {
      const value = argv[i + 1];
      if (value === undefined || !/^[0-9]+$/.test(value)) throw new ConfigError("--port needs an integer.");
      port = Number(value);
      if (port < 0 || port > 65535) throw new ConfigError("--port must be from 0 to 65535. 0 asks the OS for a port.");
      i += 1;
      continue;
    }
    if (arg === "--host") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw new ConfigError("--host needs a value.");
      host = value;
      i += 1;
      continue;
    }
    throw new ConfigError(`Unknown argument ${JSON.stringify(arg)}.`);
  }
  return { http, port, host };
}

export function allowedHostsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env.MCP_ALLOWED_HOSTS;
  if (raw === undefined || raw.trim() === "") return localhostAllowedHostnames();
  const hosts = raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  if (hosts.length === 0) throw new ConfigError("MCP_ALLOWED_HOSTS is empty.");
  return hosts;
}

/**
 * Loads credentials, opens the server once, and serves stdio or HTTP.
 * Stdio uses one client for the process (the API key in the environment).
 * HTTP checks `Authorization: Bearer` on every request.
 */
export async function bootServer(options: BootOptions): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const logger = createLogger({ server: options.name, level: parseLogLevel(env.LOG_LEVEL) });
  const args = parseCliArgs(options.argv ?? process.argv.slice(2), options.defaultPort);
  const loaded = loadAuthConfig(env);
  for (const warning of loaded.warnings) logger.warn("auth_config", { warning });
  const limiter = rateLimiterFromEnv(env);
  const opened = options.open({ env, limiter, logger });
  logger.info("ready", {
    server: options.name,
    version: options.version,
    transport: args.http ? "http" : "stdio",
    rate_limit: limiter.limit,
    window_ms: limiter.windowMs,
  });

  let http: RunningHttpServer | undefined;
  let stdio: StdioServerHandle | undefined;
  if (args.http) {
    http = await startHttpServer({
      host: args.host,
      port: args.port,
      allowedHosts: allowedHostsFromEnv(env),
      auth: loaded.config,
      verifier: createVerifier(loaded.config),
      authFailLimiter: authFailLimiterFromEnv(env),
      logger,
      serverFor: opened.serverFor,
    });
  } else {
    const client = processClient(loaded.config, env);
    stdio = serveStdio(() => opened.serverFor(client));
    logger.info("stdio", { clientId: client.clientId });
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (http) await http.close();
    if (stdio) await stdio.close();
    opened.close?.();
  };
  const shutdown = (signal: string): void => {
    logger.info("shutdown", { signal });
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return {
    transport: args.http ? "http" : "stdio",
    url: http?.url,
    close,
  };
}
