import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  requireBearerAuth,
  type McpServer,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

import { verifyBearer, type AuthConfig, type ClientIdentity } from "./auth.js";
import type { Logger } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  allowedHosts: string[];
  auth: AuthConfig;
  verifier: OAuthTokenVerifier;
  authFailLimiter: RateLimiter;
  logger: Logger;
  serverFor: (client: ClientIdentity) => McpServer;
  requiredScopes?: string[];
}

export interface RunningHttpServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const handler = createMcpHandler((ctx) => {
    const info = ctx.authInfo;
    if (!info) {
      throw new Error("HTTP factory was called without authInfo.");
    }
    return options.serverFor({
      clientId: info.clientId,
      scopes: info.scopes,
      expiresAt: info.expiresAt ?? 0,
    });
  });

  const gate = requireBearerAuth({
    verifier: options.verifier,
    requiredScopes: options.requiredScopes ?? ["mcp"],
  });

  const server = createServer((req, res) => {
    void handle(req, res, options, gate, handler).catch((error) => {
      if (error instanceof BodyTooLarge) {
        options.logger.warn("body_too_large", { message: error.message });
        if (!res.headersSent) {
          writeJson(res, 413, { error: { code: "payload_too_large", message: "Request body exceeds 1000000 bytes." } });
        }
        req.destroy();
        return;
      }
      options.logger.error("http_threw", { message: error instanceof Error ? error.message : "unknown error" });
      if (!res.headersSent) writeJson(res, 500, { error: { code: "internal", message: "Request failed." } });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("HTTP server did not bind a TCP port.");
  }
  const url = `http://${options.host}:${address.port}/mcp`;
  options.logger.info("listening", { url, host: options.host, port: address.port });
  return {
    url,
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions,
  gate: ReturnType<typeof requireBearerAuth>,
  handler: ReturnType<typeof createMcpHandler>,
): Promise<void> {
  const started = Date.now();
  const request = await toWebRequest(req);
  const hostDenied = hostHeaderValidationResponse(request, options.allowedHosts);
  if (hostDenied) {
    await writeWeb(res, hostDenied);
    return;
  }
  const originDenied = originValidationResponse(request, localhostAllowedOrigins());
  if (originDenied) {
    await writeWeb(res, originDenied);
    return;
  }
  const path = new URL(request.url).pathname;
  if (path !== "/mcp") {
    writeJson(res, 404, { error: { code: "not_found", message: "MCP endpoint is /mcp." } });
    return;
  }
  const auth = await gate(request);
  if (auth instanceof Response) {
    if (auth.status === 401) {
      const ip = req.socket.remoteAddress ?? "unknown";
      const decision = options.authFailLimiter.take(ip);
      if (!decision.allowed) {
        writeJson(
          res,
          429,
          {
            error: {
              code: "rate_limited",
              message: "Too many failed authentication attempts from this address.",
              details: { retry_after_ms: decision.retryAfterMs, limit: decision.limit },
            },
          },
          { "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))) },
        );
        options.logger.warn("auth_fail_limited", { ip, retry_after_ms: decision.retryAfterMs });
        return;
      }
    }
    options.logger.info("auth_rejected", { status: auth.status, ms: Date.now() - started });
    await writeWeb(res, auth);
    return;
  }
  // Re-read scopes from our verifier so a static key's reported expiry matches verifyBearer.
  const identity = verifyBearer(options.auth, auth.token);
  const response = await handler.fetch(request, {
    authInfo: { ...auth, clientId: identity.clientId, scopes: [...identity.scopes], expiresAt: identity.expiresAt },
  });
  options.logger.info("http_mcp", { clientId: identity.clientId, status: response.status, ms: Date.now() - started });
  await writeWeb(res, response);
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLarge();
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  return new Request(url, { method, headers, body: body.length > 0 ? body : undefined });
}

class BodyTooLarge extends Error {
  constructor() {
    super("Request body exceeds 1000000 bytes.");
    this.name = "BodyTooLarge";
  }
}

async function writeWeb(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(),
    ...extraHeaders,
  });
  res.end(payload);
}

export function defaultAllowedHosts(): string[] {
  return localhostAllowedHostnames();
}

export { BodyTooLarge };
