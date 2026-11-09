# @braylo/mcp-leads

Local lead list for one business. SQLite on disk. The agent can create a lead, fetch it, change status, append a note, and search. Nothing is sent off the machine.

Not published. Until it is, run the built file. `npx @braylo/mcp-leads` will fail.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `create_lead` | `leads:write` | Insert. Email is stored lowercased and must be unique. Status defaults to `new` |
| `get_lead` | `leads:read` | One lead and up to 20 newest events |
| `update_lead` | `leads:write` | Name, phone, source, status, optional note. Email is not editable |
| `search_leads` | `leads:read` | Newest first. `query` is a literal substring (`%` and `_` are not wildcards). `limit` default 20, max 100 |
| `add_note` | `leads:write` | Append a note |

Statuses: `new`, `contacted`, `qualified`, `won`, `lost`. Any status can move to any other. The change is an event, not a locked workflow.

## Install

Build from the repo root first: `npm ci && npm test` (the test script builds).

Generate a key with `openssl rand -hex 32`. The snippets below use a placeholder. Replace the paths.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows.

```json
{
  "mcpServers": {
    "braylo-leads": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-suite/packages/leads/dist/cli.js"],
      "env": {
        "MCP_API_KEY": "replace-me",
        "MCP_LEADS_DB": "/absolute/path/to/leads.sqlite"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "braylo-leads": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-suite/packages/leads/dist/cli.js"],
      "env": {
        "MCP_API_KEY": "replace-me",
        "MCP_LEADS_DB": "/absolute/path/to/leads.sqlite"
      }
    }
  }
}
```

### Continue

`~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: braylo-leads
    command: node
    args:
      - /absolute/path/to/mcp-server-suite/packages/leads/dist/cli.js
    env:
      MCP_API_KEY: replace-me
      MCP_LEADS_DB: /absolute/path/to/leads.sqlite
```

Any other client that spawns a stdio MCP server uses the same `command`, `args`, and `env`. After a real publish, `command` can become `npx` and `args` `["-y", "@braylo/mcp-leads"]`. That has not been published.

### HTTP

```bash
MCP_API_KEY=replace-me MCP_LEADS_DB=/absolute/path/to/leads.sqlite \
  node packages/leads/dist/cli.js --http --port 7481
```

`POST http://127.0.0.1:7481/mcp` with `Authorization: Bearer replace-me`. The process listens on `127.0.0.1` unless you pass `--host`. `MCP_ALLOWED_HOSTS` is the Host allowlist (default `localhost`, `127.0.0.1`, `[::1]`). Binding a public interface does not add that name to the allowlist.

## Environment

| Variable | Default |
|---|---|
| `MCP_API_KEY` or `MCP_API_KEYS_FILE` | required |
| `MCP_LEADS_DB` | `data/leads.sqlite` under the current directory |
| `MCP_RATE_LIMIT` | `60` |
| `MCP_RATE_WINDOW_MS` | `60000` |
| `LOG_LEVEL` | `info` |

## Limits

Node's `node:sqlite` prints an experimental warning on Node 22. The schema is one `leads` table and one `lead_events` table. Search covers name, email, phone, source, and notes. Phone numbers are stored as digits, optional leading `+`, 7–15 digits. See the root README for auth, the rate limit, and logging.

## License

MIT
