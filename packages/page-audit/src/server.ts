import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { SCOPE_AUDIT, guardCall, toolError, toolJson, type ClientIdentity, type Logger, type RateLimiter } from "@braylo/mcp-core";

import { auditUrl } from "./fetch.js";
import { AUDIT_RULES, auditMarkup, type AuditDocument } from "./rules.js";

const auditSchema = z.object({
  url: z.string().nullable(),
  final_url: z.string().nullable(),
  status: z.number().nullable(),
  redirects: z.number(),
  ttfb_ms: z.number().nullable(),
  total_ms: z.number().nullable(),
  bytes: z.number(),
  truncated: z.boolean(),
  content_type: z.string().nullable(),
  title: z.string().nullable(),
  meta_description: z.string().nullable(),
  h1: z.array(z.string()),
  canonical: z.string().nullable(),
  lang: z.string().nullable(),
  images: z.object({
    total: z.number(),
    missing_alt: z.number(),
    empty_alt: z.number(),
    missing_alt_sample: z.array(z.string()),
  }),
  words: z.number(),
  findings: z.array(z.object({ id: z.string(), severity: z.enum(["error", "warn", "info"]), message: z.string() })),
  counts: z.object({ error: z.number(), warn: z.number(), info: z.number() }),
});

export interface AuditServerOptions {
  client: ClientIdentity;
  limiter: RateLimiter;
  logger: Logger;
  allowPrivate: boolean;
  version?: string;
}

export function createAuditServer(options: AuditServerOptions): McpServer {
  const server = new McpServer({ name: "braylo-page-audit", version: options.version ?? "0.1.0" });
  const guard = (tool: string, fn: () => Promise<ReturnType<typeof toolJson> | ReturnType<typeof toolError>>) =>
    guardCall({ client: options.client, limiter: options.limiter, logger: options.logger, tool, scope: SCOPE_AUDIT }, fn);

  server.registerTool(
    "audit_url",
    {
      title: "Audit a URL",
      description:
        "Fetch one http(s) URL from this machine and return timing plus deterministic HTML findings. Private and loopback addresses are refused unless the server was started with MCP_AUDIT_ALLOW_PRIVATE=1. Timings are a single sample from this process, not a lab score. There is no SEO score.",
      inputSchema: z.object({
        url: z.string().trim().min(1).max(2000),
        timeout_ms: z.number().int().min(100).max(15_000).optional(),
      }),
      outputSchema: z.object({ audit: auditSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard("audit_url", async () => {
        const result = await auditUrl({
          url: args.url,
          timeoutMs: args.timeout_ms ?? 8000,
          allowPrivate: options.allowPrivate,
        });
        if (!result.ok) return toolError(result.code, result.message, result.details);
        return toolJson({ audit: result.audit satisfies AuditDocument });
      }),
  );

  server.registerTool(
    "audit_html",
    {
      title: "Audit HTML",
      description:
        "Run the same markup checks on an HTML string you already have. No network and no timing findings. The byte cap is the same as a fetched body.",
      inputSchema: z.object({
        html: z.string().max(AUDIT_RULES.maxBytes),
        url: z.string().trim().max(2000).optional(),
      }),
      outputSchema: z.object({ audit: auditSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard("audit_html", async () => {
        if (args.html.trim().length === 0) return toolError("invalid_input", "html is empty.", { field: "html" });
        const audit = auditMarkup({
          html: args.html,
          bytes: Buffer.byteLength(args.html),
          truncated: false,
          url: args.url ?? null,
          finalUrl: args.url ?? null,
        });
        return toolJson({ audit });
      }),
  );

  return server;
}
