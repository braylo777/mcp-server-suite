import { issueHmacBearer } from "../packages/core/src/auth.ts";
import { DEFAULT_SCOPES } from "../packages/core/src/scopes.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const secret = process.env.MCP_BEARER_HMAC_SECRET;
if (!secret) {
  process.stderr.write("Set MCP_BEARER_HMAC_SECRET.\n");
  process.exit(1);
}
const clientId = flag("--client") ?? "local";
const ttl = Number(flag("--ttl") ?? "3600");
const scopes = (flag("--scopes") ?? DEFAULT_SCOPES.join(",")).split(",").map((scope) => scope.trim()).filter(Boolean);
process.stdout.write(`${issueHmacBearer(secret, { clientId, scopes, ttlSeconds: ttl })}\n`);
