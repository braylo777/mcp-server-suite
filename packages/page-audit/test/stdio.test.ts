import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { childEnv } from "../../../test/mcp.ts";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("the page-audit process starts over stdio and lists its tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: childEnv({ MCP_API_KEY: "stdio-audit-key-0123456789" }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "stdio-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["audit_html", "audit_url"]);
  } finally {
    await client.close();
  }
});
