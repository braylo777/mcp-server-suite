import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, arch, release, tmpdir } from "node:os";
import { join } from "node:path";

import { expandEvent, findOpenSlots } from "../packages/booking/src/availability.ts";
import { DEFAULT_HOURS } from "../packages/booking/src/hours.ts";
import { parseCalendar } from "../packages/booking/src/ics.ts";
import { RateLimiter } from "../packages/core/src/rate-limit.ts";
import { LeadStore } from "../packages/leads/src/store.ts";
import { auditMarkup } from "../packages/page-audit/src/rules.ts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const expectedFindings = ["images_missing_alt", "missing_canonical", "missing_meta_description", "thin_content"];

let clock = 0;
const exact = new RateLimiter({ limit: 60, windowMs: 60_000, now: () => clock });
let allowed = 0;
let deniedOn = 0;
for (let call = 1; call <= 61; call += 1) {
  const decision = exact.take("bench");
  if (decision.allowed) allowed += 1;
  else deniedOn = call;
}
if (allowed !== 60 || deniedOn !== 61) fail(`rate cutoff allowed=${allowed} deniedOn=${deniedOn}`);

const hot = new RateLimiter({ limit: 1_000_000, windowMs: 60_000 });
const checks = 200_000;
const hotStarted = performance.now();
for (let i = 0; i < checks; i += 1) hot.take("hot");
const hotMs = performance.now() - hotStarted;
const nsPerCheck = (hotMs * 1_000_000) / checks;

const dir = mkdtempSync(join(tmpdir(), "mcp-bench-"));
const store = new LeadStore(join(dir, "leads.sqlite"));
const insertStarted = performance.now();
for (let i = 0; i < 1000; i += 1) {
  const created = store.create({
    name: `Lead ${i}`,
    email: `lead${i}@example.com`,
    phone: null,
    source: i % 2 === 0 ? "counter" : "web",
    status: "new",
    note: null,
  });
  if (!created.ok) fail(`insert ${i} failed`);
}
const insertMs = performance.now() - insertStarted;
const searchStarted = performance.now();
const found = store.search({ query: "lead500", limit: 20, offset: 0 });
const searchMs = performance.now() - searchStarted;
store.close();
if (found.total !== 1) fail(`search total ${found.total}`);

const html = readFileSync(new URL("../fixtures/page/north-wharf.html", import.meta.url), "utf8");
const auditStarted = performance.now();
const audit = auditMarkup({ html, bytes: Buffer.byteLength(html), truncated: false });
const auditMs = performance.now() - auditStarted;
const findingIds = audit.findings.map((finding) => finding.id).sort();
if (findingIds.join(",") !== expectedFindings.join(",")) fail(`findings ${findingIds.join(",")}`);

const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:weekly
SUMMARY:Standing
DTSTART:20260105T150000Z
DTEND:20260105T160000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
END:VCALENDAR
`;
const parsed = parseCalendar(ics, "UTC");
if (parsed.issues.length !== 0 || !parsed.events[0]) fail(`calendar issues ${JSON.stringify(parsed.issues)}`);
const expandStarted = performance.now();
const expanded = expandEvent(parsed.events[0], new Date("2026-01-01T00:00:00.000Z"), new Date("2027-01-01T00:00:00.000Z"));
const expandMs = performance.now() - expandStarted;
if (!expanded.ok) fail(expanded.reason);
if (expanded.occurrences.length !== 52) fail(`occurrences ${expanded.occurrences.length}`);

const slots = findOpenSlots({
  hours: DEFAULT_HOURS,
  from: new Date("2026-01-06T00:00:00.000Z"),
  to: new Date("2026-01-07T00:00:00.000Z"),
  durationMinutes: 30,
  stepMinutes: 30,
  busy: [],
});
if (slots.slots.length !== 16 || slots.truncated) fail(`slots ${slots.slots.length}`);

const round = (value: number): number => Math.round(value * 1000) / 1000;

const result = {
  measured_at: new Date().toISOString(),
  node: process.version,
  platform: `${platform()} ${release()} ${arch()}`,
  cpu: cpus()[0]?.model ?? "unknown",
  note: "One run on this machine. Counts are exact and this script exits 1 if they change. Timings are not a lab benchmark.",
  rate_limit: {
    limit: 60,
    allowed,
    denied_on_call: deniedOn,
    checks,
    ns_per_check: round(nsPerCheck),
  },
  leads: {
    inserted: 1000,
    insert_ms: round(insertMs),
    search_query: "lead500",
    search_hits: found.total,
    search_ms: round(searchMs),
  },
  audit: {
    fixture: "fixtures/page/north-wharf.html",
    bytes: Buffer.byteLength(html),
    parse_ms: round(auditMs),
    findings: findingIds,
  },
  booking: {
    weekly_mondays_in_2026: expanded.occurrences.length,
    expand_ms: round(expandMs),
    free_tuesday_30min_slots: slots.slots.length,
  },
};

const out = new URL("../results/bench.json", import.meta.url);
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
