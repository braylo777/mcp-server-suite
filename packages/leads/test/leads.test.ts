import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RateLimiter, SCOPE_LEADS_READ, SCOPE_LEADS_WRITE, SCOPE_MCP } from "@braylo/mcp-core";
import { quietLogger, readResult, testClient, withClient } from "../../../test/mcp.ts";
import { createLeadsServer } from "../src/server.ts";
import { LeadStore } from "../src/store.ts";

function setup(scopes = [SCOPE_MCP, SCOPE_LEADS_READ, SCOPE_LEADS_WRITE], limit = 20) {
  const dir = mkdtempSync(join(tmpdir(), "leads-"));
  const store = new LeadStore(join(dir, "leads.sqlite"));
  const limiter = new RateLimiter({ limit, windowMs: 60_000 });
  const server = createLeadsServer({
    client: testClient(scopes),
    store,
    limiter,
    logger: quietLogger("leads"),
  });
  return { store, server };
}

test("create, get, note, search, and a duplicate email", async () => {
  const { store, server } = setup();
  try {
    await withClient(server, async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, ["add_note", "create_lead", "get_lead", "search_leads", "update_lead"]);

      const created = readResult(await client.callTool({
        name: "create_lead",
        arguments: { name: "Ada North", email: "Ada@Example.com", phone: "(415) 555-0100", source: "counter", note: "Asked about catering" },
      }));
      assert.equal(created.isError, false);
      const lead = (created.body as { lead: { id: string; email: string; phone: string; status: string } }).lead;
      assert.equal(lead.email, "ada@example.com");
      assert.equal(lead.phone, "4155550100");
      assert.equal(lead.status, "new");

      const again = readResult(await client.callTool({
        name: "create_lead",
        arguments: { name: "Other", email: "ada@example.com" },
      }));
      assert.equal(again.isError, true);
      assert.equal((again.body as { error: { code: string } }).error.code, "conflict");

      const badEmail = readResult(await client.callTool({
        name: "create_lead",
        arguments: { name: "No", email: "not-an-email" },
      }));
      assert.equal((badEmail.body as { error: { code: string } }).error.code, "invalid_input");

      const updated = readResult(await client.callTool({
        name: "update_lead",
        arguments: { id: lead.id, status: "contacted" },
      }));
      assert.equal((updated.body as { lead: { status: string } }).lead.status, "contacted");

      await client.callTool({ name: "add_note", arguments: { id: lead.id, note: "Called Tuesday" } });
      const fetched = readResult(await client.callTool({ name: "get_lead", arguments: { id: lead.id } }));
      const events = (fetched.body as { events: { kind: string }[]; lead: { notes: string } }).events;
      assert.ok(events.some((event) => event.kind === "status"));
      assert.ok(events.some((event) => event.kind === "note"));
      assert.match((fetched.body as { lead: { notes: string } }).lead.notes, /Called Tuesday/);

      const missing = readResult(await client.callTool({ name: "get_lead", arguments: { id: "lead_missing" } }));
      assert.equal((missing.body as { error: { code: string } }).error.code, "not_found");

      await client.callTool({ name: "create_lead", arguments: { name: "100% Organic", email: "organic@example.com", status: "qualified" } });
      await client.callTool({ name: "create_lead", arguments: { name: "Plain", email: "plain@example.com", status: "new" } });
      const literal = readResult(await client.callTool({ name: "search_leads", arguments: { query: "%" } }));
      const literalLeads = (literal.body as { leads: { name: string }[]; total: number }).leads;
      assert.deepEqual(literalLeads.map((row) => row.name), ["100% Organic"]);
      const qualified = readResult(await client.callTool({ name: "search_leads", arguments: { status: "qualified", limit: 1, offset: 0 } }));
      assert.equal((qualified.body as { total: number }).total, 1);
    });
  } finally {
    store.close();
  }
});

test("a read-only key cannot create, and the third call hits the limiter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leads-"));
  const store = new LeadStore(join(dir, "leads.sqlite"));
  const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 });
  const logger = quietLogger("leads");
  const reader = createLeadsServer({ client: testClient([SCOPE_MCP, SCOPE_LEADS_READ]), store, limiter, logger });
  try {
    await withClient(reader, async (client) => {
      const denied = readResult(await client.callTool({ name: "create_lead", arguments: { name: "A", email: "a@example.com" } }));
      assert.equal((denied.body as { error: { code: string } }).error.code, "forbidden");
    });
    const writer = createLeadsServer({
      client: testClient([SCOPE_MCP, SCOPE_LEADS_WRITE, SCOPE_LEADS_READ], "writer"),
      store,
      limiter,
      logger,
    });
    await withClient(writer, async (client) => {
      const first = readResult(await client.callTool({ name: "create_lead", arguments: { name: "A", email: "a@example.com" } }));
      const second = readResult(await client.callTool({ name: "create_lead", arguments: { name: "B", email: "b@example.com" } }));
      const third = readResult(await client.callTool({ name: "create_lead", arguments: { name: "C", email: "c@example.com" } }));
      assert.equal(first.isError, false);
      assert.equal(second.isError, false);
      assert.equal((third.body as { error: { code: string } }).error.code, "rate_limited");
    });
  } finally {
    store.close();
  }
});
