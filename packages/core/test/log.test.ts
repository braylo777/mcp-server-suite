import assert from "node:assert/strict";
import { test } from "node:test";

import { toolError, toolJson } from "../src/errors.ts";
import { createLogger } from "../src/log.ts";
import { redact } from "../src/redact.ts";

test("logger writes one JSON line and redacts bearer material", () => {
  const lines: string[] = [];
  const logger = createLogger({
    server: "leads",
    level: "debug",
    stream: { write: (chunk) => lines.push(chunk) },
    now: () => new Date("2026-01-15T00:00:00.000Z"),
  });
  logger.info("tool_ok", { tool: "get_lead", authorization: "Bearer super-secret-token", note: "Authorization: Bearer super-secret-token" });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(parsed.server, "leads");
  assert.equal(parsed.msg, "tool_ok");
  assert.equal(parsed.authorization, "[redacted]");
  assert.equal(parsed.note, "Authorization: Bearer [redacted]");
  assert.equal(parsed.tool, "get_lead");
});

test("debug lines are dropped when the level is info", () => {
  const lines: string[] = [];
  const logger = createLogger({ server: "leads", level: "info", stream: { write: (chunk) => lines.push(chunk) } });
  logger.debug("hidden");
  logger.error("shown");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] ?? "{}").msg, "shown");
});

test("tool errors are JSON with a stable code and no structured success body", () => {
  const error = toolError("rate_limited", "Rate limit exceeded for this client.", { retry_after_ms: 10, limit: 3 });
  assert.equal(error.isError, true);
  assert.equal(error.structuredContent, undefined);
  const body = JSON.parse(error.content[0]?.type === "text" ? error.content[0].text : "{}") as {
    error: { code: string; details: { retry_after_ms: number } };
  };
  assert.equal(body.error.code, "rate_limited");
  assert.equal(body.error.details.retry_after_ms, 10);
  const ok = toolJson({ ok: true });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(ok.structuredContent, { ok: true });
});

test("redact walks nested objects and stops at a depth cap", () => {
  const nested = redact({ token: "abc", inner: { password: "x", keep: 1 } }) as { token: string; inner: { password: string; keep: number } };
  assert.equal(nested.token, "[redacted]");
  assert.equal(nested.inner.password, "[redacted]");
  assert.equal(nested.inner.keep, 1);
});
