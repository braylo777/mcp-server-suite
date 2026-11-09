# @braylo/mcp-booking

Reads one `.ics` file and answers what is busy and what is open inside the business hours you configure. There is no default calendar: an empty one would look free, so `MCP_BOOKING_ICS` is required.

Not published. Run the built file.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `describe_calendar` | `booking:read` | Timezone, hours, raw event count, and events this server will not expand |
| `list_events` | `booking:read` | Occurrences that overlap `[from, to)` |
| `busy_blocks` | `booking:read` | Those occurrences merged into half-open blocks. Adjacent blocks are joined |
| `find_slots` | `booking:read` | Slots that sit inside one business-hours range and miss the busy blocks |

`from` and `to` are ISO-8601 instants with `Z` or a numeric offset, including seconds. A date with no time is rejected. The window cannot be longer than 366 days.

Default hours, if you do not set any, are Monday–Friday 09:00–17:00 in UTC. `fixtures/calendar/shop.ics` is a Monday 15:00 UTC standing call plus New Year's Day closed.

A Tuesday with no events and the default hours has 16 slots of 30 minutes. That count is a test and a line in `results/bench.json`.

## Recurrence subset

Supported: `DTSTART` / `DTEND` or `DURATION`, all-day `VALUE=DATE`, UTC `Z`, floating times in the configured zone, `TZID` when `Intl` accepts it, `RRULE` of `DAILY`, `WEEKLY` with `BYDAY`, `MONTHLY` with `BYMONTHDAY`, `INTERVAL`, `COUNT` or `UNTIL` (not both), `EXDATE`.

Not supported: `YEARLY`, `BYSETPOS`, `RDATE`, recurring monthly weekdays (`1MO`). If the file contains one of those, `list_events`, `busy_blocks`, and `find_slots` return `unsupported` and do not guess. `describe_calendar` names the event and the reason.

`EXDATE` still counts toward `COUNT`. A start time that falls in a DST spring-forward gap is skipped and does not count. A weekly 09:00 `America/New_York` event stays at 09:00 local in January (14:00 UTC) and July (13:00 UTC). That pair is a test.

## Install

`npm ci && npm test` from the repo root builds `dist/cli.js`.

### Claude Desktop

```json
{
  "mcpServers": {
    "braylo-booking": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-suite/packages/booking/dist/cli.js"],
      "env": {
        "MCP_API_KEY": "replace-me",
        "MCP_BOOKING_ICS": "/absolute/path/to/shop.ics",
        "MCP_BOOKING_TZ": "America/New_York"
      }
    }
  }
}
```

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. Windows: `%APPDATA%\Claude\claude_desktop_config.json`.

### Cursor

`~/.cursor/mcp.json`, same `mcpServers` object.

### Continue

```yaml
mcpServers:
  - name: braylo-booking
    command: node
    args:
      - /absolute/path/to/mcp-server-suite/packages/booking/dist/cli.js
    env:
      MCP_API_KEY: replace-me
      MCP_BOOKING_ICS: /absolute/path/to/shop.ics
      MCP_BOOKING_TZ: America/New_York
```

Other stdio clients use the same command. `npx -y @braylo/mcp-booking` is only valid after a publish. There has not been one.

### HTTP

```bash
MCP_API_KEY=replace-me MCP_BOOKING_ICS=fixtures/calendar/shop.ics \
  node packages/booking/dist/cli.js --http --port 7483
```

`POST http://127.0.0.1:7483/mcp` with `Authorization: Bearer replace-me`.

## Environment

| Variable | Default |
|---|---|
| `MCP_API_KEY` or a key file | required |
| `MCP_BOOKING_ICS` | required path |
| `MCP_BOOKING_TZ` | `UTC`, ignored when the hours JSON sets `timezone` |
| `MCP_BOOKING_HOURS_JSON` | unset. JSON `{"timezone","hours":{"mon":[["09:00","17:00"]]}}`. Missing days are closed |
| `MCP_RATE_LIMIT` | `60` |
| `LOG_LEVEL` | `info` |

The `.ics` file is read on each tool call. It is not watched.

## Limits

The expander walks at most 20,000 days. `find_slots` returns at most 200 slots and sets `truncated`. Slot length is elapsed minutes inside one hours range, so a slot cannot cross a lunch break. The file cap is 2_000_000 bytes and 5_000 events. See the root README for auth and the rate limit.

## License

MIT
