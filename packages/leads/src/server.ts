import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  SCOPE_LEADS_READ,
  SCOPE_LEADS_WRITE,
  guardCall,
  toolError,
  toolJson,
  type ClientIdentity,
  type Logger,
  type RateLimiter,
} from "@braylo/mcp-core";

import { LEAD_STATUSES, type LeadStatus, type LeadStore } from "./store.js";

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PHONE_CHARS = /[0-9+]/g;

const leadSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  source: z.string().nullable(),
  status: z.enum(LEAD_STATUSES),
  notes: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface LeadsServerOptions {
  client: ClientIdentity;
  store: LeadStore;
  limiter: RateLimiter;
  logger: Logger;
  version?: string;
}

export function createLeadsServer(options: LeadsServerOptions): McpServer {
  const server = new McpServer({ name: "braylo-leads", version: options.version ?? "0.1.0" });
  const guard = (tool: string, scope: string, fn: () => Promise<CallToolResult>) =>
    guardCall({ client: options.client, limiter: options.limiter, logger: options.logger, tool, scope }, fn);

  server.registerTool(
    "create_lead",
    {
      title: "Create lead",
      description:
        "Insert one lead into the local SQLite file. Email is stored lowercased and must be unique. Status defaults to new.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().max(254),
        phone: z.string().trim().max(40).optional(),
        source: z.string().trim().max(80).optional(),
        status: z.enum(LEAD_STATUSES).optional(),
        note: z.string().trim().max(4000).optional(),
      }),
      outputSchema: z.object({ lead: leadSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guard("create_lead", SCOPE_LEADS_WRITE, async () => {
        const email = checkEmail(args.email);
        if (typeof email !== "string") return email;
        const phone = args.phone === undefined ? null : normalizePhone(args.phone);
        if (phone !== null && typeof phone !== "string") return phone;
        const created = options.store.create({
          name: args.name,
          email,
          phone,
          source: args.source ?? null,
          status: args.status ?? "new",
          note: args.note ?? null,
        });
        if (!created.ok) {
          return toolError("conflict", "A lead with that email already exists.", { email });
        }
        return toolJson({ lead: created.lead });
      }),
  );

  server.registerTool(
    "get_lead",
    {
      title: "Get lead",
      description: "Fetch one lead and up to 20 newest events (created, updated, status, note).",
      inputSchema: z.object({ id: z.string().trim().min(1).max(80) }),
      outputSchema: z.object({
        lead: leadSchema,
        events: z.array(z.object({ id: z.number(), at: z.string(), kind: z.string(), body: z.string() })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard("get_lead", SCOPE_LEADS_READ, async () => {
        const found = options.store.get(args.id);
        if (!found) return toolError("not_found", "No lead has that id.", { id: args.id });
        return toolJson(found);
      }),
  );

  server.registerTool(
    "update_lead",
    {
      title: "Update lead",
      description:
        "Change name, phone, source, or status, and optionally append a note. Email is not editable. At least one field is required.",
      inputSchema: z.object({
        id: z.string().trim().min(1).max(80),
        name: z.string().trim().min(1).max(120).optional(),
        phone: z.string().trim().max(40).nullable().optional(),
        source: z.string().trim().max(80).nullable().optional(),
        status: z.enum(LEAD_STATUSES).optional(),
        note: z.string().trim().max(4000).optional(),
      }),
      outputSchema: z.object({ lead: leadSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guard("update_lead", SCOPE_LEADS_WRITE, async () => {
        if (args.name === undefined && args.phone === undefined && args.source === undefined && args.status === undefined && args.note === undefined) {
          return toolError("invalid_input", "Provide at least one of name, phone, source, status, or note.");
        }
        let phone: string | null | undefined;
        if (args.phone === undefined) phone = undefined;
        else if (args.phone === null || args.phone.trim() === "") phone = null;
        else {
          const normalized = normalizePhone(args.phone);
          if (normalized === null) phone = null;
          else if (typeof normalized !== "string") return normalized;
          else phone = normalized;
        }
        const updated = options.store.update({
          id: args.id,
          name: args.name,
          phone,
          source: args.source === "" ? null : args.source,
          status: args.status,
          note: args.note,
        });
        if (!updated.ok) return toolError("not_found", "No lead has that id.", { id: args.id });
        return toolJson({ lead: updated.lead });
      }),
  );

  server.registerTool(
    "search_leads",
    {
      title: "Search leads",
      description:
        "List leads newest-first. query matches name, email, phone, source, and notes as a literal substring (% and _ are not wildcards). status filters exactly. limit defaults to 20, max 100.",
      inputSchema: z.object({
        query: z.string().trim().max(200).optional(),
        status: z.enum(LEAD_STATUSES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
      outputSchema: z.object({
        leads: z.array(leadSchema),
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard("search_leads", SCOPE_LEADS_READ, async () => {
        const limit = args.limit ?? 20;
        const offset = args.offset ?? 0;
        const found = options.store.search({ query: args.query, status: args.status, limit, offset });
        return toolJson({ ...found, limit, offset });
      }),
  );

  server.registerTool(
    "add_note",
    {
      title: "Add note",
      description: "Append a note to a lead and record a note event.",
      inputSchema: z.object({
        id: z.string().trim().min(1).max(80),
        note: z.string().trim().min(1).max(4000),
      }),
      outputSchema: z.object({ lead: leadSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guard("add_note", SCOPE_LEADS_WRITE, async () => {
        const updated = options.store.update({ id: args.id, note: args.note });
        if (!updated.ok) return toolError("not_found", "No lead has that id.", { id: args.id });
        return toolJson({ lead: updated.lead });
      }),
  );

  return server;
}

function checkEmail(email: string): string | ReturnType<typeof toolError> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL.test(normalized)) {
    return toolError("invalid_input", "email is not a usable address.", { field: "email" });
  }
  return normalized;
}

function normalizePhone(phone: string): string | null | ReturnType<typeof toolError> {
  const trimmed = phone.trim();
  if (trimmed.length === 0) return null;
  const kept = trimmed.match(PHONE_CHARS)?.join("") ?? "";
  if (!/^\+?[0-9]{7,15}$/.test(kept)) {
    return toolError("invalid_input", "phone must contain 7–15 digits after removing spaces and punctuation.", {
      field: "phone",
    });
  }
  return kept;
}

export function isLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(value);
}
