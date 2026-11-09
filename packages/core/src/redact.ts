const SECRET_KEYS = new Set([
  "authorization",
  "token",
  "api_key",
  "apikey",
  "password",
  "secret",
  "mcp_api_key",
  "bearer",
  "hmac",
]);

const BEARER = /bearer\s+\S+/gi;

/**
 * Redacts known secret fields and `Bearer …` strings.
 * A high-entropy token that is not labeled as one of those fields is left as-is.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    return value.replace(BEARER, "Bearer [redacted]");
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(inner, depth + 1);
    }
    return out;
  }
  return "[unlogged]";
}
