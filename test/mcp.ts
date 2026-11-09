import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";

import type { ClientIdentity } from "../packages/core/src/auth.ts";
import { createLogger, type Logger } from "../packages/core/src/log.ts";

export function testClient(scopes: string[], clientId = "test"): ClientIdentity {
  return { clientId, scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
}

export function quietLogger(server = "test"): Logger {
  return createLogger({ server, level: "error", stream: { write() {} } });
}

export async function withClient(server: McpServer, run: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "suite-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export function readResult(result: CallToolResult): { isError: boolean; body: unknown } {
  const block = result.content.find((item) => item.type === "text");
  if (!block || block.type !== "text") throw new Error("tool result has no text");
  return { isError: result.isError === true, body: JSON.parse(block.text) as unknown };
}

export function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LANG", "TZ"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, ...extra };
}
