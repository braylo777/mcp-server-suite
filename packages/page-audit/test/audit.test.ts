import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { RateLimiter, SCOPE_AUDIT, SCOPE_MCP } from "@braylo/mcp-core";
import { quietLogger, readResult, testClient, withClient } from "../../../test/mcp.ts";
import { isBlockedAddress } from "../src/net.ts";
import { createAuditServer } from "../src/server.ts";

const LONG_DESCRIPTION = "Coffee, pastry, and a quiet table by the window on weekdays.";

function serverFor(allowPrivate: boolean, limit = 20) {
  return createAuditServer({
    client: testClient([SCOPE_MCP, SCOPE_AUDIT]),
    limiter: new RateLimiter({ limit, windowMs: 60_000 }),
    logger: quietLogger("audit"),
    allowPrivate,
  });
}

test("address classification blocks private ranges and allows public resolvers", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "2001:4860:4860::8888"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("audit_html reports the fixture findings and stays quiet on a complete page", async () => {
  const server = serverFor(false);
  await withClient(server, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["audit_html", "audit_url"]);
    const thin = readResult(await client.callTool({
      name: "audit_html",
      arguments: {
        html: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>North Wharf Coffee</title></head><body><h1>North Wharf Coffee</h1><p>Espresso and pastry on the wharf.</p><img src="/shop.jpg"><img alt="Cappuccino" src="/cup.jpg"></body></html>`,
      },
    }));
    const findings = (thin.body as { audit: { findings: { id: string }[]; ttfb_ms: null; words: number } }).audit;
    assert.deepEqual(findings.findings.map((finding) => finding.id).sort(), [
      "images_missing_alt",
      "missing_canonical",
      "missing_meta_description",
      "thin_content",
    ]);
    assert.equal(findings.ttfb_ms, null);
    assert.ok(findings.words < 50);

    const words = Array.from({ length: 55 }, (_, index) => `word${index}`).join(" ");
    const complete = readResult(await client.callTool({
      name: "audit_html",
      arguments: {
        html: `<!doctype html><html lang="en"><head><title>North Wharf Coffee</title><meta name="description" content="${LONG_DESCRIPTION}"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com/"></head><body><h1>North Wharf Coffee</h1><p>${words}</p><img alt="Cup" src="/cup.jpg"></body></html>`,
      },
    }));
    assert.deepEqual((complete.body as { audit: { findings: unknown[] } }).audit.findings, []);
  });
});

test("markup rules flag a long title, a second h1, and noindex", async () => {
  const server = serverFor(false);
  await withClient(server, async (client) => {
    const html = `<html><head><title>North Wharf Coffee Roastery and the weekday ferry crowd by the pier</title><meta name="description" content="${LONG_DESCRIPTION}"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com/"></head><body><h1>One</h1><h1>Two</h1><p>${Array.from({ length: 55 }, (_, i) => `w${i}`).join(" ")}</p></body></html>`;
    const result = readResult(await client.callTool({ name: "audit_html", arguments: { html } }));
    const ids = (result.body as { audit: { findings: { id: string }[] } }).audit.findings.map((finding) => finding.id).sort();
    assert.deepEqual(ids, ["missing_lang", "multiple_h1", "robots_noindex", "title_length"]);
  });
});

test("audit_url refuses loopback unless private fetches are enabled, then records a real timing", async () => {
  let hits = 0;
  const site = createServer((req, res) => {
    hits += 1;
    if (req.url === "/next") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html lang="en"><head><title>North Wharf Coffee</title><meta name="description" content="${LONG_DESCRIPTION}"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com/"></head><body><h1>Hi</h1><p>${Array.from({ length: 55 }, (_, i) => `w${i}`).join(" ")}</p></body></html>`);
      return;
    }
    res.writeHead(302, { location: "/next" });
    res.end();
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", () => resolve()));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const blocked = serverFor(false);
    await withClient(blocked, async (client) => {
      const result = readResult(await client.callTool({ name: "audit_url", arguments: { url, timeout_ms: 1000 } }));
      assert.equal((result.body as { error: { code: string; details: { reason: string } } }).error.code, "forbidden");
      assert.equal((result.body as { error: { details: { reason: string } } }).error.details.reason, "private_or_reserved_address");
    });
    assert.equal(hits, 0);

    const opened = serverFor(true);
    await withClient(opened, async (client) => {
      const credential = readResult(await client.callTool({ name: "audit_url", arguments: { url: "http://user:pass@127.0.0.1/secret" } }));
      assert.equal((credential.body as { error: { code: string } }).error.code, "invalid_input");
      const fileUrl = readResult(await client.callTool({ name: "audit_url", arguments: { url: "file:///etc/passwd" } }));
      assert.equal((fileUrl.body as { error: { code: string } }).error.code, "invalid_input");
      const result = readResult(await client.callTool({ name: "audit_url", arguments: { url, timeout_ms: 2000 } }));
      assert.equal(result.isError, false);
      const audit = (result.body as { audit: { status: number; redirects: number; ttfb_ms: number; total_ms: number; findings: { id: string }[] } }).audit;
      assert.equal(audit.status, 200);
      assert.equal(audit.redirects, 1);
      assert.equal(typeof audit.ttfb_ms, "number");
      assert.ok(audit.ttfb_ms >= 0);
      assert.ok(audit.total_ms >= audit.ttfb_ms);
      assert.equal(audit.findings.some((finding) => finding.id === "slow_ttfb"), false);
    });
    assert.equal(hits, 2);
  } finally {
    await new Promise<void>((resolve, reject) => site.close((error) => (error ? reject(error) : resolve())));
  }
});

test("the third audit call is rate limited", async () => {
  const server = serverFor(false, 2);
  await withClient(server, async (client) => {
    const html = "<html><title>Hi</title></html>";
    await client.callTool({ name: "audit_html", arguments: { html } });
    await client.callTool({ name: "audit_html", arguments: { html } });
    const third = readResult(await client.callTool({ name: "audit_html", arguments: { html } }));
    assert.equal((third.body as { error: { code: string } }).error.code, "rate_limited");
  });
});
