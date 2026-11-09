export const SCOPE_MCP = "mcp";
export const SCOPE_LEADS_READ = "leads:read";
export const SCOPE_LEADS_WRITE = "leads:write";
export const SCOPE_AUDIT = "audit:read";
export const SCOPE_BOOKING = "booking:read";

export const DEFAULT_SCOPES = [
  SCOPE_MCP,
  SCOPE_LEADS_READ,
  SCOPE_LEADS_WRITE,
  SCOPE_AUDIT,
  SCOPE_BOOKING,
] as const;

/** Reported to the SDK for a static API key, which has no real expiry. See the README. */
export const STATIC_KEY_REPORTED_TTL_SECONDS = 60 * 60 * 24 * 365 * 10;

const SCOPE_PATTERN = /^[a-z0-9:._-]{1,64}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function assertScope(scope: string): void {
  if (!SCOPE_PATTERN.test(scope)) {
    throw new Error(`Invalid scope ${JSON.stringify(scope)}. Use 1–64 characters from [a-z0-9:._-].`);
  }
}

export function assertClientId(clientId: string): void {
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(
      `Invalid clientId ${JSON.stringify(clientId)}. Use 1–64 characters from [A-Za-z0-9._:-].`,
    );
  }
}

export function hasScope(scopes: readonly string[], scope: string): boolean {
  return scopes.includes(scope);
}
