# @braylo/mcp-core

Shared pieces for the three servers in this repo: bearer checks, a fixed-window rate limit, JSON logs on stderr, and tool errors with a `code`.

This package is not published. The `publishConfig` and `files` fields are there so a later `npm publish` from `packages/core` has a name, a license, and a built `dist/`.

## What the servers call

| Export | Role |
|---|---|
| `loadAuthConfig` | Reads `MCP_API_KEY`, `MCP_API_KEYS`, or `MCP_API_KEYS_FILE`, and an optional `MCP_BEARER_HMAC_SECRET` |
| `createVerifier` | The object `requireBearerAuth` from the MCP SDK calls |
| `verifyBearer` | Same check, for tests and for the identity attached to a request |
| `issueHmacBearer` | Mints a `v1.` HMAC token. Not an OAuth token |
| `bootServer` | stdio, or `--http` |
| `guardCall` | Scope, then one rate-limit token, then the tool |
| `toolError` / `toolJson` | The only response shapes the tools return |
| `RateLimiter` | Fixed window, per key, in memory |
| `createLogger` | One JSON line per event, secrets redacted |

`MCP_API_KEY` is one token for client id `local` (or `MCP_CLIENT_ID`) with every scope this repo uses: `mcp`, `leads:read`, `leads:write`, `audit:read`, `booking:read`. A key file can narrow that. A token in a file must not start with `v1.`.

stdio cannot see a bearer header. `bootServer` picks the single configured key, or the key named by `MCP_CLIENT_ID` when there are several, and refuses to start otherwise. HMAC-only configuration is HTTP-only.

See the root README for the measured rate-limit cutoff, the 10-year `expiresAt` sentinel, and the limits that apply to every server.

## License

MIT
