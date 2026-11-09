import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { ErrorCode } from "@braylo/mcp-core";

import { isBlockedAddress, isBlockedHostname } from "./net.js";
import { AUDIT_RULES, auditMarkup, type AuditDocument } from "./rules.js";

export interface FetchAuditOptions {
  url: string;
  timeoutMs: number;
  allowPrivate: boolean;
  maxBytes?: number;
}

export type FetchAuditResult =
  | { ok: true; audit: AuditDocument }
  | { ok: false; code: ErrorCode; message: string; details?: Record<string, unknown> };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GET one URL and audit the body.
 * Each hop is classified before connect. DNS answers are checked inside the
 * socket lookup, which is as late as `node:http` allows. There is still a gap
 * if the platform connects to an address we did not see.
 */
export async function auditUrl(options: FetchAuditOptions): Promise<FetchAuditResult> {
  const maxBytes = options.maxBytes ?? AUDIT_RULES.maxBytes;
  const deadline = Date.now() + options.timeoutMs;
  let current: URL;
  try {
    current = new URL(options.url);
  } catch {
    return fail("invalid_input", "url is not a URL.", { field: "url" });
  }
  let redirects = 0;
  while (true) {
    const classified = classify(current, options.allowPrivate);
    if (!classified.ok) return classified;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail("upstream", "Timed out before the response finished.", { timeout_ms: options.timeoutMs });
    let hop: Hop;
    try {
      hop = await requestOnce(current, remaining, options.allowPrivate, maxBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      if (message === "blocked_address") {
        return fail("forbidden", "Refusing to connect to a private, loopback, or reserved address.", {
          reason: "private_or_reserved_address",
          url: current.toString(),
        });
      }
      return fail("upstream", "The fetch failed.", { url: current.toString(), reason: message.slice(0, 300) });
    }
    if (REDIRECTS.has(hop.status)) {
      redirects += 1;
      if (redirects > AUDIT_RULES.maxRedirects) {
        return fail("upstream", `Stopped after ${AUDIT_RULES.maxRedirects} redirects.`, { redirects });
      }
      if (!hop.location) return fail("upstream", "Redirect had no Location header.", { status: hop.status });
      try {
        current = new URL(hop.location, current);
      } catch {
        return fail("upstream", "Redirect Location is not a URL.", { location: hop.location.slice(0, 200) });
      }
      continue;
    }
    const contentType = hop.contentType;
    const looksHtml = contentType === null || /text\/html|application\/xhtml\+xml/i.test(contentType) || hop.body.trimStart().startsWith("<");
    const html = looksHtml ? hop.body : "";
    return {
      ok: true,
      audit: auditMarkup({
        html,
        bytes: hop.bytes,
        truncated: hop.truncated,
        url: options.url,
        finalUrl: current.toString(),
        status: hop.status,
        redirects,
        ttfbMs: hop.ttfbMs,
        totalMs: hop.totalMs,
        contentType,
      }),
    };
  }
}

function classify(url: URL, allowPrivate: boolean): { ok: true } | FetchAuditResult {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("invalid_input", "Only http and https URLs are fetched.", { protocol: url.protocol });
  }
  if (url.username || url.password) {
    return fail("invalid_input", "URLs with a username or password are rejected.", { field: "url" });
  }
  if (isBlockedHostname(url.hostname)) {
    return fail("forbidden", "That hostname is blocked (loopback or metadata).", {
      reason: "blocked_hostname",
      host: url.hostname,
    });
  }
  if (!allowPrivate && isIpLiteral(url.hostname) && isBlockedAddress(stripBrackets(url.hostname))) {
    return fail("forbidden", "Refusing to connect to a private, loopback, or reserved address.", {
      reason: "private_or_reserved_address",
      host: url.hostname,
    });
  }
  return { ok: true };
}

function isIpLiteral(hostname: string): boolean {
  return isIP(stripBrackets(hostname)) !== 0;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

interface Hop {
  status: number;
  location: string | null;
  contentType: string | null;
  body: string;
  bytes: number;
  truncated: boolean;
  ttfbMs: number;
  totalMs: number;
}

function requestOnce(url: URL, timeoutMs: number, allowPrivate: boolean, maxBytes: number): Promise<Hop> {
  const started = performance.now();
  const libRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (hop: Hop): void => {
      if (settled) return;
      settled = true;
      resolve(hop);
    };
    const bad = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = libRequest(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": "braylo-mcp-page-audit/0.1",
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        },
        lookup: allowPrivate ? undefined : guardedLookup,
      },
      (res: IncomingMessage) => {
        const ttfbMs = roundMs(performance.now() - started);
        const status = res.statusCode ?? 0;
        if (REDIRECTS.has(status)) {
          res.resume();
          ok({
            status,
            location: headerString(res.headers.location),
            contentType: headerString(res.headers["content-type"]),
            body: "",
            bytes: 0,
            truncated: false,
            ttfbMs,
            totalMs: roundMs(performance.now() - started),
          });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        const finish = (): void => {
          ok({
            status,
            location: null,
            contentType: headerString(res.headers["content-type"]),
            body: Buffer.concat(chunks).toString("utf8"),
            bytes,
            truncated,
            ttfbMs,
            totalMs: roundMs(performance.now() - started),
          });
        };
        res.on("data", (chunk: Buffer | string) => {
          if (truncated) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const room = maxBytes - bytes;
          const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
          chunks.push(slice);
          bytes += slice.length;
          if (buffer.length > room) {
            truncated = true;
            res.destroy();
            finish();
          }
        });
        res.on("end", finish);
        res.on("error", () => {
          if (truncated) finish();
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => bad(error));
    req.end();
  });
}

function guardedLookup(
  hostname: string,
  _options: unknown,
  callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      callback(Object.assign(new Error("blocked_address"), { code: "ECONNREFUSED" }), "", 0);
      return;
    }
    const first = addresses[0];
    if (!first) {
      callback(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    callback(null, first.address, first.family);
  });
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): FetchAuditResult {
  return { ok: false, code, message, details };
}
