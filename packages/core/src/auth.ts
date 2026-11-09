import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";

import { ConfigError } from "./errors.js";
import {
  DEFAULT_SCOPES,
  STATIC_KEY_REPORTED_TTL_SECONDS,
  assertClientId,
  assertScope,
} from "./scopes.js";

export interface ApiKeyRecord {
  clientId: string;
  token: string;
  scopes: string[];
  /** Unix seconds. Omit for a key that does not expire. */
  expiresAt?: number;
}

export interface AuthConfig {
  keys: ApiKeyRecord[];
  hmacSecret?: string;
}

export interface ClientIdentity {
  clientId: string;
  scopes: readonly string[];
  expiresAt: number;
}

export interface LoadedAuth {
  config: AuthConfig;
  warnings: string[];
}

interface HmacPayload {
  v: 1;
  sub: string;
  scope: string;
  iat: number;
  exp: number;
}

/**
 * Compares two strings without short-circuiting when their lengths match.
 * Different lengths return false after a dummy compare. The length itself
 * still leaks; generate tokens with `openssl rand -hex 32` so they are the
 * same size.
 */
export function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function issueHmacBearer(
  secret: string,
  input: { clientId: string; scopes: readonly string[]; ttlSeconds: number; nowSeconds?: number },
): string {
  assertHmacSecret(secret);
  assertClientId(input.clientId);
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 60 * 60 * 24 * 30) {
    throw new ConfigError("HMAC bearer ttlSeconds must be an integer from 1 to 2592000 (30 days).");
  }
  for (const scope of input.scopes) assertScope(scope);
  if (!input.scopes.includes("mcp")) {
    throw new ConfigError("HMAC bearer scopes must include mcp.");
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: HmacPayload = {
    v: 1,
    sub: input.clientId,
    scope: input.scopes.join(" "),
    iat: now,
    exp: now + input.ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `v1.${body}.${sig}`;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): LoadedAuth {
  const warnings: string[] = [];
  const file = env.MCP_API_KEYS_FILE;
  const json = env.MCP_API_KEYS;
  const single = env.MCP_API_KEY;
  if (file && json) {
    throw new ConfigError("Set MCP_API_KEYS_FILE or MCP_API_KEYS, not both.");
  }
  let keys: ApiKeyRecord[] = [];
  if (file) {
    keys = readKeyFile(file, warnings);
  } else if (json) {
    keys = parseKeyDocument(json, "MCP_API_KEYS");
  } else if (single) {
    keys = [shorthandKey(single, env.MCP_CLIENT_ID)];
  }
  if ((file || json) && single) {
    warnings.push("MCP_API_KEY is ignored because MCP_API_KEYS_FILE or MCP_API_KEYS is set.");
  }
  const hmacSecret = env.MCP_BEARER_HMAC_SECRET;
  if (hmacSecret !== undefined && hmacSecret !== "") assertHmacSecret(hmacSecret);
  if (keys.length === 0 && !hmacSecret) {
    throw new ConfigError(
      "No credentials configured. Set MCP_API_KEY, MCP_API_KEYS, MCP_API_KEYS_FILE, or MCP_BEARER_HMAC_SECRET.",
    );
  }
  for (const key of keys) {
    if (key.token.length < 16) {
      warnings.push(`API key for client ${key.clientId} is shorter than 16 characters.`);
    }
  }
  return { config: { keys, hmacSecret: hmacSecret || undefined }, warnings };
}

export function processClient(config: AuthConfig, env: NodeJS.ProcessEnv, nowSeconds = unixSeconds()): ClientIdentity {
  if (config.keys.length === 0) {
    throw new ConfigError(
      "stdio has no per-request bearer. Set an API key. HMAC bearers are checked on HTTP requests only.",
    );
  }
  const wanted = env.MCP_CLIENT_ID;
  let record: ApiKeyRecord | undefined;
  if (wanted) {
    record = config.keys.find((key) => key.clientId === wanted);
    if (!record) throw new ConfigError(`MCP_CLIENT_ID ${JSON.stringify(wanted)} does not match a configured key.`);
  } else if (config.keys.length === 1) {
    record = config.keys[0];
  } else {
    throw new ConfigError("More than one API key is configured. Set MCP_CLIENT_ID for the stdio process.");
  }
  if (!record) throw new ConfigError("No API key is available for this stdio process.");
  if (record.expiresAt !== undefined && record.expiresAt <= nowSeconds) {
    throw new ConfigError(`API key for client ${record.clientId} is expired.`);
  }
  if (!record.scopes.includes("mcp")) {
    throw new ConfigError(`API key for client ${record.clientId} is missing the mcp scope.`);
  }
  return identityFromRecord(record, nowSeconds);
}

export function createVerifier(config: AuthConfig, now: () => number = Date.now): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const identity = verifyBearer(config, token, Math.floor(now() / 1000));
      return {
        token,
        clientId: identity.clientId,
        scopes: [...identity.scopes],
        expiresAt: identity.expiresAt,
      };
    },
  };
}

export function verifyBearer(config: AuthConfig, token: string, nowSeconds = unixSeconds()): ClientIdentity {
  if (token.trim() === "" || token !== token.trim() || /\s/.test(token)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Bearer token is empty or contains whitespace.");
  }
  if (token.startsWith("v1.")) {
    return verifyHmacBearer(config.hmacSecret, token, nowSeconds);
  }
  for (const key of config.keys) {
    if (!safeEqualString(key.token, token)) continue;
    if (key.expiresAt !== undefined && key.expiresAt <= nowSeconds) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "API key is expired.");
    }
    return identityFromRecord(key, nowSeconds);
  }
  throw new OAuthError(OAuthErrorCode.InvalidToken, "Bearer token was not recognized.");
}

function verifyHmacBearer(secret: string | undefined, token: string, nowSeconds: number): ClientIdentity {
  if (!secret) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearers are not enabled on this server.");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearer is malformed.");
  }
  const expected = createHmac("sha256", secret).update(parts[1]).digest("base64url");
  if (!safeEqualString(parts[2], expected)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearer signature does not match.");
  }
  let payload: HmacPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as HmacPayload;
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearer payload is not JSON.");
  }
  if (payload.v !== 1 || typeof payload.sub !== "string" || typeof payload.scope !== "string") {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearer payload is not a v1 token.");
  }
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearer is missing iat or exp.");
  }
  if (payload.exp <= nowSeconds) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearer is expired.");
  }
  if (payload.iat > nowSeconds + 60) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearer iat is in the future.");
  }
  const scopes = payload.scope.split(" ").filter((scope) => scope.length > 0);
  try {
    assertClientId(payload.sub);
    for (const scope of scopes) assertScope(scope);
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearer client id or scope is invalid.");
  }
  if (!scopes.includes("mcp")) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "HMAC bearer is missing the mcp scope.");
  }
  return { clientId: payload.sub, scopes, expiresAt: payload.exp };
}

function identityFromRecord(record: ApiKeyRecord, nowSeconds: number): ClientIdentity {
  return {
    clientId: record.clientId,
    scopes: record.scopes,
    expiresAt: record.expiresAt ?? nowSeconds + STATIC_KEY_REPORTED_TTL_SECONDS,
  };
}

function shorthandKey(token: string, clientId: string | undefined): ApiKeyRecord {
  assertTokenShape(token, "MCP_API_KEY");
  const id = clientId && clientId.length > 0 ? clientId : "local";
  assertClientId(id);
  return { clientId: id, token, scopes: [...DEFAULT_SCOPES] };
}

function readKeyFile(path: string, warnings: string[]): ApiKeyRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    throw new ConfigError(`Could not read MCP_API_KEYS_FILE: ${message}`);
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      warnings.push(`MCP_API_KEYS_FILE is readable by group or others (mode ${mode.toString(8)}).`);
    }
  } catch {
    // stat failing after a successful read is not worth hiding the keys.
  }
  return parseKeyDocument(text, path);
}

function parseKeyDocument(text: string, label: string): ApiKeyRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`${label} is not JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { keys?: unknown }).keys)) {
    throw new ConfigError(`${label} must be an object with a keys array.`);
  }
  const records: ApiKeyRecord[] = [];
  const seenTokens = new Set<string>();
  for (const entry of (parsed as { keys: unknown[] }).keys) {
    if (!entry || typeof entry !== "object") throw new ConfigError(`${label} has a key entry that is not an object.`);
    const row = entry as Record<string, unknown>;
    if (typeof row.clientId !== "string" || typeof row.token !== "string" || !Array.isArray(row.scopes)) {
      throw new ConfigError(`${label} key entries need clientId, token, and scopes.`);
    }
    assertClientId(row.clientId);
    assertTokenShape(row.token, label);
    if (seenTokens.has(row.token)) throw new ConfigError(`${label} contains a duplicate token.`);
    seenTokens.add(row.token);
    const scopes: string[] = [];
    for (const scope of row.scopes) {
      if (typeof scope !== "string") throw new ConfigError(`${label} scopes must be strings.`);
      assertScope(scope);
      scopes.push(scope);
    }
    if (!scopes.includes("mcp")) throw new ConfigError(`${label} key for ${row.clientId} is missing the mcp scope.`);
    let expiresAt: number | undefined;
    if (row.expiresAt !== undefined && row.expiresAt !== null) {
      if (typeof row.expiresAt !== "number" || !Number.isInteger(row.expiresAt)) {
        throw new ConfigError(`${label} expiresAt must be a unix-seconds integer.`);
      }
      expiresAt = row.expiresAt;
    }
    const record: ApiKeyRecord = { clientId: row.clientId, token: row.token, scopes };
    if (expiresAt !== undefined) record.expiresAt = expiresAt;
    records.push(record);
  }
  if (records.length === 0) throw new ConfigError(`${label} keys array is empty.`);
  return records;
}

function assertTokenShape(token: string, label: string): void {
  if (token.length < 8 || token.length > 512 || /\s/.test(token)) {
    throw new ConfigError(`${label} token must be 8–512 characters with no whitespace.`);
  }
  if (token.startsWith("v1.")) {
    throw new ConfigError(`${label} token must not start with "v1." (reserved for HMAC bearers).`);
  }
}

function assertHmacSecret(secret: string): void {
  if (secret.length < 16 || secret.length > 256) {
    throw new ConfigError("MCP_BEARER_HMAC_SECRET must be 16–256 characters.");
  }
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
