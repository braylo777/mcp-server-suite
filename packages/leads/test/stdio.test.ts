import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { childEnv } from "../../../test/mcp.ts";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("the leads process starts over stdio and lists its tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leads-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: childEnv({
      MCP_API_KEY: "stdio-leads-key-0123456789",
      MCP_LEADS_DB: join(dir, "leads.sqlite"),
    }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "stdio-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["add_note", "create_lead", "get_lead", "search_leads", "update_lead"]);
  } finally {
    await client.close();
  }
});

test("the leads process exits when no credential is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leads-stdio-"));
  const child = spawn(process.execPath, [cli], {
    env: childEnv({ MCP_LEADS_DB: join(dir, "leads.sqlite") }),
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 1);
  const text = Buffer.concat(stderr).toString("utf8");
  assert.match(text, /No credentials configured/);
});
