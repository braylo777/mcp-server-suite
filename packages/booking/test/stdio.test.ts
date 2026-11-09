import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { childEnv } from "../../../test/mcp.ts";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("the booking process starts over stdio and lists its tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "booking-stdio-"));
  const ics = join(dir, "shop.ics");
  writeFileSync(ics, "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//braylo//test//EN\nEND:VCALENDAR\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: childEnv({
      MCP_API_KEY: "stdio-booking-key-0123456789",
      MCP_BOOKING_ICS: ics,
    }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "stdio-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["busy_blocks", "describe_calendar", "find_slots", "list_events"]);
  } finally {
    await client.close();
  }
});
