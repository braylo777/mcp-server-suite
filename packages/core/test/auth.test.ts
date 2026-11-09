import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { OAuthError } from "@modelcontextprotocol/server";

import {
  issueHmacBearer,
  loadAuthConfig,
  processClient,
  safeEqualString,
  verifyBearer,
} from "../src/auth.ts";
import { STATIC_KEY_REPORTED_TTL_SECONDS } from "../src/scopes.ts";

const TOKEN = "local-token-0123456789abcdef";

test("safeEqualString matches equal strings and rejects other lengths", () => {
  assert.equal(safeEqualString("abcdef", "abcdef"), true);
  assert.equal(safeEqualString("abcdef", "abcdeg"), false);
  assert.equal(safeEqualString("abcdef", "abc"), false);
});

test("MCP_API_KEY shorthand grants the default scopes to client local", () => {
  const loaded = loadAuthConfig({ MCP_API_KEY: TOKEN });
  assert.equal(loaded.config.keys.length, 1);
  assert.equal(loaded.config.keys[0]?.clientId, "local");
  assert.ok(loaded.config.keys[0]?.scopes.includes("mcp"));
  assert.ok(loaded.config.keys[0]?.scopes.includes("leads:write"));
  const identity = verifyBearer(loaded.config, TOKEN, 1_700_000_000);
  assert.equal(identity.clientId, "local");
  assert.equal(identity.expiresAt, 1_700_000_000 + STATIC_KEY_REPORTED_TTL_SECONDS);
});

test("a key file is the only source when both a file and MCP_API_KEY are set", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-keys-"));
  const path = join(dir, "keys.json");
  writeFileSync(
    path,
    JSON.stringify({ keys: [{ clientId: "shop", token: "file-token-0123456789", scopes: ["mcp", "leads:read"] }] }),
  );
  chmodSync(path, 0o600);
  const loaded = loadAuthConfig({ MCP_API_KEYS_FILE: path, MCP_API_KEY: TOKEN });
  assert.deepEqual(loaded.config.keys.map((key) => key.clientId), ["shop"]);
  assert.ok(loaded.warnings.some((warning) => warning.includes("MCP_API_KEY is ignored")));
});

test("unknown, blank, and expired bearers are rejected", () => {
  const config = loadAuthConfig({
    MCP_API_KEYS: JSON.stringify({
      keys: [{ clientId: "shop", token: TOKEN, scopes: ["mcp"], expiresAt: 1_800_000_000 }],
    }),
  }).config;
  assert.throws(() => verifyBearer(config, "nope-token-0123456789", 1_700_000_000), OAuthError);
  assert.throws(() => verifyBearer(config, "   ", 1_700_000_000), OAuthError);
  assert.throws(() => verifyBearer(config, TOKEN, 1_800_000_000), OAuthError);
  const ok = verifyBearer(config, TOKEN, 1_700_000_000);
  assert.equal(ok.expiresAt, 1_800_000_000);
});

test("HMAC bearers round-trip, and a flipped signature or an old exp does not", () => {
  const secret = "hmac-secret-0123456789";
  const now = 1_700_000_000;
  const token = issueHmacBearer(secret, { clientId: "shop", scopes: ["mcp", "audit:read"], ttlSeconds: 60, nowSeconds: now });
  const config = loadAuthConfig({ MCP_BEARER_HMAC_SECRET: secret }).config;
  const identity = verifyBearer(config, token, now + 10);
  assert.equal(identity.clientId, "shop");
  assert.deepEqual(identity.scopes, ["mcp", "audit:read"]);
  assert.throws(() => verifyBearer(config, token, now + 61), OAuthError);
  const [, body, sig] = token.split(".");
  const flippedChar = sig?.[0] === "A" ? "B" : "A";
  const flipped = `v1.${body}.${flippedChar}${sig?.slice(1) ?? ""}`;
  assert.throws(() => verifyBearer(config, flipped, now + 10), OAuthError);
  assert.throws(() => verifyBearer({ keys: [] }, token, now + 10), OAuthError);
});

test("stdio requires one API key and refuses a process that only has an HMAC secret", () => {
  const loaded = loadAuthConfig({ MCP_API_KEY: TOKEN, MCP_CLIENT_ID: "desk" });
  assert.equal(processClient(loaded.config, { MCP_CLIENT_ID: "desk" }, 1_700_000_000).clientId, "desk");
  const hmacOnly = loadAuthConfig({ MCP_BEARER_HMAC_SECRET: "hmac-secret-0123456789" });
  assert.throws(() => processClient(hmacOnly.config, {}), /stdio/);
});

test("two keys require MCP_CLIENT_ID for stdio", () => {
  const loaded = loadAuthConfig({
    MCP_API_KEYS: JSON.stringify({
      keys: [
        { clientId: "a", token: "token-a-0123456789abcd", scopes: ["mcp"] },
        { clientId: "b", token: "token-b-0123456789abcd", scopes: ["mcp"] },
      ],
    }),
  });
  assert.throws(() => processClient(loaded.config, {}), /MCP_CLIENT_ID/);
  assert.equal(processClient(loaded.config, { MCP_CLIENT_ID: "b" }).clientId, "b");
});
