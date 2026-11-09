# @braylo/mcp-page-audit

Fetches one URL from this machine, or accepts an HTML string, and returns what it measured plus a fixed set of markup findings. There is no SEO score and no Lighthouse run.

Not published. Run the built file.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `audit_url` | `audit:read` | GET the URL, follow up to 5 redirects, then the same checks as `audit_html`, plus status and timing |
| `audit_html` | `audit:read` | Checks on a string. No network, so `ttfb_ms` and `total_ms` are null |

Findings are ids, not a grade. The thresholds live in `src/rules.ts`:

| Id | When |
|---|---|
| `missing_title` / `title_length` | No title, or length outside 15–60 characters |
| `missing_meta_description` / `meta_description_length` | No `<meta name="description">`, or length outside 50–160 |
| `missing_h1` / `multiple_h1` | No h1, or more than one |
| `missing_canonical` | No canonical link |
| `missing_lang` | No `lang` on `<html>` |
| `missing_viewport` | No viewport meta |
| `robots_noindex` | robots meta contains `noindex` (info) |
| `images_missing_alt` | An `img` with no `alt` attribute. `alt=""` is counted separately and is not a finding |
| `thin_content` | Under 50 words of visible text in `<body>` |
| `large_html` | Over 1_000_000 bytes |
| `response_truncated` | Body cut at 1_500_000 bytes |
| `slow_ttfb` / `slow_response` | Headers over 800 ms, or the read over 3000 ms. One sample from this process. URL audits only |
| `non_success_status` | HTTP status 400 or above |
| `not_html` | Content-Type is not HTML. Markup checks still run if the body looks like HTML |

`fixtures/page/north-wharf.html` produces `missing_meta_description`, `missing_canonical`, `images_missing_alt`, and `thin_content`. A page that has the pieces above produces an empty `findings` array. Both are tests.

## Install

`npm ci && npm test` from the repo root builds `dist/cli.js`.

### Claude Desktop

```json
{
  "mcpServers": {
    "braylo-page-audit": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-suite/packages/page-audit/dist/cli.js"],
      "env": {
        "MCP_API_KEY": "replace-me"
      }
    }
  }
}
```

macOS path: `~/Library/Application Support/Claude/claude_desktop_config.json`. Windows: `%APPDATA%\Claude\claude_desktop_config.json`.

### Cursor

`~/.cursor/mcp.json` uses the same `mcpServers` object.

### Continue

```yaml
mcpServers:
  - name: braylo-page-audit
    command: node
    args:
      - /absolute/path/to/mcp-server-suite/packages/page-audit/dist/cli.js
    env:
      MCP_API_KEY: replace-me
```

Other stdio clients use the same command. `npx -y @braylo/mcp-page-audit` is the shape after a publish that has not happened.

### HTTP

```bash
MCP_API_KEY=replace-me node packages/page-audit/dist/cli.js --http --port 7482
```

`POST http://127.0.0.1:7482/mcp` with `Authorization: Bearer replace-me`.

## Environment

| Variable | Default |
|---|---|
| `MCP_API_KEY` or a key file | required |
| `MCP_AUDIT_ALLOW_PRIVATE` | unset. Set to `1` to allow loopback and private addresses. That includes link-local metadata addresses |
| `MCP_RATE_LIMIT` | `60` |
| `LOG_LEVEL` | `info` |

`audit_url` takes `timeout_ms` from 100 to 15000. The default is 8000 for the whole call, redirects included.

## Limits

Private, loopback, link-local, CGNAT, multicast, reserved, and documentation addresses are blocked, and so are `localhost` and the common cloud metadata hostnames. The block runs in the lookup `node:http` performs. It is not a claim that every SSRF path is closed. TLS is verified. There is no flag to skip certificate errors. Bodies are UTF-8 and capped at 1_500_000 bytes. `og:description` is not read. See the root README.

## License

MIT
