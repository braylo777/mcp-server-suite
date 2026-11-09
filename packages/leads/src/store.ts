import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LEAD_STATUSES = ["new", "contacted", "qualified", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface Lead {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  source: string | null;
  status: LeadStatus;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface LeadEvent {
  id: number;
  at: string;
  kind: string;
  body: string;
}

export interface LeadQuery {
  query?: string;
  status?: LeadStatus;
  limit: number;
  offset: number;
}

export class LeadStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE,
        phone TEXT,
        source TEXT,
        status TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS leads_email_unique ON leads(email);
      CREATE INDEX IF NOT EXISTS leads_status ON leads(status);
      CREATE TABLE IF NOT EXISTS lead_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  create(input: {
    name: string;
    email: string;
    phone: string | null;
    source: string | null;
    status: LeadStatus;
    note: string | null;
    now?: Date;
  }): { ok: true; lead: Lead } | { ok: false; reason: "duplicate_email" } {
    const email = input.email.toLowerCase();
    const existing = this.db.prepare("SELECT id FROM leads WHERE email = ?").get(email);
    if (existing) return { ok: false, reason: "duplicate_email" };
    const now = (input.now ?? new Date()).toISOString();
    const id = newId();
    const notes = input.note ?? "";
    this.db.prepare(
      `INSERT INTO leads (id, name, email, phone, source, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.name, email, input.phone, input.source, input.status, notes, now, now);
    this.addEvent(id, now, "created", input.status);
    if (input.note) this.addEvent(id, now, "note", input.note);
    return { ok: true, lead: this.mustGet(id) };
  }

  get(id: string): { lead: Lead; events: LeadEvent[] } | undefined {
    const row = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
    if (!row) return undefined;
    const events = this.db
      .prepare(
        "SELECT id, at, kind, body FROM lead_events WHERE lead_id = ? ORDER BY id DESC LIMIT 20",
      )
      .all(id)
      .map(asEvent);
    return { lead: asLead(row), events };
  }

  update(input: {
    id: string;
    name?: string;
    phone?: string | null;
    source?: string | null;
    status?: LeadStatus;
    note?: string;
    now?: Date;
  }): { ok: true; lead: Lead } | { ok: false; reason: "not_found" } {
    const current = this.get(input.id);
    if (!current) return { ok: false, reason: "not_found" };
    const now = (input.now ?? new Date()).toISOString();
    const name = input.name ?? current.lead.name;
    const phone = input.phone === undefined ? current.lead.phone : input.phone;
    const source = input.source === undefined ? current.lead.source : input.source;
    const status = input.status ?? current.lead.status;
    let notes = current.lead.notes;
    if (input.note) notes = notes.length > 0 ? `${notes}\n${input.note}` : input.note;
    this.db.prepare(
      `UPDATE leads SET name = ?, phone = ?, source = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`,
    ).run(name, phone, source, status, notes, now, input.id);
    const changed: string[] = [];
    if (input.name !== undefined && input.name !== current.lead.name) changed.push("name");
    if (input.phone !== undefined && input.phone !== current.lead.phone) changed.push("phone");
    if (input.source !== undefined && input.source !== current.lead.source) changed.push("source");
    if (changed.length > 0) this.addEvent(input.id, now, "updated", changed.join(","));
    if (input.status && input.status !== current.lead.status) {
      this.addEvent(input.id, now, "status", `${current.lead.status} -> ${input.status}`);
    }
    if (input.note) this.addEvent(input.id, now, "note", input.note);
    return { ok: true, lead: this.mustGet(input.id) };
  }

  search(query: LeadQuery): { leads: Lead[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.status) {
      where.push("status = ?");
      params.push(query.status);
    }
    if (query.query && query.query.length > 0) {
      where.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(query.query)}%`;
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM leads ${clause}`).get(...params);
    const total = Number((totalRow as { n: number } | undefined)?.n ?? 0);
    const rows = this.db
      .prepare(`SELECT * FROM leads ${clause} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset);
    return { leads: rows.map(asLead), total };
  }

  private mustGet(id: string): Lead {
    const row = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
    if (!row) throw new Error(`lead ${id} disappeared after write`);
    return asLead(row);
  }

  private addEvent(leadId: string, at: string, kind: string, body: string): void {
    this.db.prepare("INSERT INTO lead_events (lead_id, at, kind, body) VALUES (?, ?, ?, ?)").run(leadId, at, kind, body);
  }
}

function newId(): string {
  return `lead_${randomBytes(6).toString("hex")}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function asLead(row: unknown): Lead {
  const record = row as Record<string, unknown>;
  const status = record.status;
  if (!isStatus(status) || typeof record.id !== "string" || typeof record.name !== "string" || typeof record.email !== "string") {
    throw new Error("lead row is corrupt");
  }
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    phone: typeof record.phone === "string" ? record.phone : null,
    source: typeof record.source === "string" ? record.source : null,
    status,
    notes: typeof record.notes === "string" ? record.notes : "",
    created_at: String(record.created_at),
    updated_at: String(record.updated_at),
  };
}

function asEvent(row: unknown): LeadEvent {
  const record = row as Record<string, unknown>;
  return {
    id: Number(record.id),
    at: String(record.at),
    kind: String(record.kind),
    body: String(record.body),
  };
}

function isStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}
