import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { createVerifier } from "../src/auth.ts";
import { guardCall } from "../src/guard.ts";
import { startHttpServer } from "../src/http.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import { toolJson } from "../src/errors.ts";
import { quietLogger, readResult } from "../../../test/mcp.ts";

const TOKEN_A = "http-token-a-0123456789";
const TOKEN_B = "http-token-b-0123456789";

test("HTTP requires a bearer, rate-limits failed guesses, and meters tool calls per client", async () => {
  const auth = {
    keys: [
      { clientId: "shop", token: TOKEN_A, scopes: ["mcp"] },
      { clientId: "other", token: TOKEN_B, scopes: ["mcp"] },
    ],
  };
  const toolLimiter = new RateLimiter({ limit: 1, windowMs: 60_000 });
  const logger = quietLogger("http");
  const running = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1", "localhost", "[::1]"],
    auth,
    verifier: createVerifier(auth),
    authFailLimiter: new RateLimiter({ limit: 3, windowMs: 60_000 }),
    logger,
    serverFor(client) {
      const server = new McpServer({ name: "ping", version: "0.0.0" });
      server.registerTool(
        "ping",
        { description: "Return the caller id" },
        async () =>
          guardCall({ client, limiter: toolLimiter, logger, tool: "ping", scope: "mcp" }, async () =>
            toolJson({ clientId: client.clientId }),
          ),
      );
      return server;
    },
  });
  try {
    const missing = await post(running.port, {});
    assert.equal(missing.status, 401);
    assert.match(String(missing.headers["www-authenticate"] ?? ""), /Bearer/);

    const firstBad = await post(running.port, {}, { authorization: "Bearer nope-token-000000" });
    const secondBad = await post(running.port, {}, { authorization: "Bearer nope-token-000001" });
    const thirdBad = await post(running.port, {}, { authorization: "Bearer nope-token-000002" });
    assert.equal(firstBad.status, 401);
    assert.equal(secondBad.status, 401);
    assert.equal(thirdBad.status, 429);

    const badHost = await post(running.port, {}, { host: "evil.example", authorization: `Bearer ${TOKEN_A}` });
    assert.equal(badHost.status, 403);

    const clientA = await connect(running.url, TOKEN_A);
    const clientB = await connect(running.url, TOKEN_B);
    try {
      const tools = await clientA.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), ["ping"]);
      const first = readResult(await clientA.callTool({ name: "ping" }));
      const second = readResult(await clientA.callTool({ name: "ping" }));
      const other = readResult(await clientB.callTool({ name: "ping" }));
      assert.equal(first.isError, false);
      assert.deepEqual(first.body, { clientId: "shop" });
      assert.equal(second.isError, true);
      assert.equal((second.body as { error: { code: string } }).error.code, "rate_limited");
      assert.equal(other.isError, false);
      assert.deepEqual(other.body, { clientId: "other" });
    } finally {
      await clientA.close();
      await clientB.close();
    }
  } finally {
    await running.close();
  }
});

async function connect(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: NodeJS.Dict<string | string[]>; text: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
