import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";

export const AUDIT_RULES = {
  titleMin: 15,
  titleMax: 60,
  descriptionMin: 50,
  descriptionMax: 160,
  thinWords: 50,
  largeHtmlBytes: 1_000_000,
  slowTtfbMs: 800,
  slowTotalMs: 3000,
  maxRedirects: 5,
  maxBytes: 1_500_000,
  missingAltSample: 5,
} as const;

export type Severity = "error" | "warn" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
}

export interface AuditDocument {
  url: string | null;
  final_url: string | null;
  status: number | null;
  redirects: number;
  ttfb_ms: number | null;
  total_ms: number | null;
  bytes: number;
  truncated: boolean;
  content_type: string | null;
  title: string | null;
  meta_description: string | null;
  h1: string[];
  canonical: string | null;
  lang: string | null;
  images: {
    total: number;
    missing_alt: number;
    empty_alt: number;
    missing_alt_sample: string[];
  };
  words: number;
  findings: Finding[];
  counts: { error: number; warn: number; info: number };
}

export interface MarkupInput {
  html: string;
  bytes: number;
  truncated: boolean;
  url?: string | null;
  finalUrl?: string | null;
  status?: number | null;
  redirects?: number;
  ttfbMs?: number | null;
  totalMs?: number | null;
  contentType?: string | null;
}

/**
 * Deterministic markup checks. Thresholds are the constants in AUDIT_RULES.
 * This does not score a page and does not call a search engine.
 */
export function auditMarkup(input: MarkupInput): AuditDocument {
  const root = parse(input.html);
  const title = textOf(root.querySelector("title"));
  const description = metaContent(root, "description");
  const h1 = root.querySelectorAll("h1").map((node) => textOf(node)).filter((value) => value.length > 0);
  const canonical = canonicalHref(root);
  const lang = root.querySelector("html")?.getAttribute("lang")?.trim() || null;
  const robots = metaContent(root, "robots");
  const viewport = metaContent(root, "viewport");
  const images = inspectImages(root);
  const words = wordCount(visibleText(root));
  const findings: Finding[] = [];

  if (input.status !== undefined && input.status !== null && input.status >= 400) {
    findings.push({ id: "non_success_status", severity: "error", message: `HTTP status is ${input.status}.` });
  }
  if (!title) {
    findings.push({ id: "missing_title", severity: "error", message: "No non-empty <title>." });
  } else if (title.length < AUDIT_RULES.titleMin || title.length > AUDIT_RULES.titleMax) {
    findings.push({
      id: "title_length",
      severity: "warn",
      message: `Title is ${title.length} characters. This check wants ${AUDIT_RULES.titleMin}–${AUDIT_RULES.titleMax}.`,
    });
  }
  if (!description) {
    findings.push({ id: "missing_meta_description", severity: "error", message: "No <meta name=\"description\">." });
  } else if (description.length < AUDIT_RULES.descriptionMin || description.length > AUDIT_RULES.descriptionMax) {
    findings.push({
      id: "meta_description_length",
      severity: "warn",
      message: `Meta description is ${description.length} characters. This check wants ${AUDIT_RULES.descriptionMin}–${AUDIT_RULES.descriptionMax}.`,
    });
  }
  if (h1.length === 0) findings.push({ id: "missing_h1", severity: "error", message: "No non-empty <h1>." });
  else if (h1.length > 1) findings.push({ id: "multiple_h1", severity: "warn", message: `Found ${h1.length} <h1> elements.` });
  if (!canonical) findings.push({ id: "missing_canonical", severity: "warn", message: "No <link rel=\"canonical\">." });
  if (!lang) findings.push({ id: "missing_lang", severity: "warn", message: "No lang attribute on <html>." });
  if (!viewport) findings.push({ id: "missing_viewport", severity: "warn", message: "No <meta name=\"viewport\">." });
  if (robots && /\bnoindex\b/i.test(robots)) {
    findings.push({ id: "robots_noindex", severity: "info", message: "robots meta contains noindex." });
  }
  if (images.missing_alt > 0) {
    findings.push({
      id: "images_missing_alt",
      severity: "warn",
      message: `${images.missing_alt} of ${images.total} images have no alt attribute.`,
    });
  }
  if (words < AUDIT_RULES.thinWords) {
    findings.push({
      id: "thin_content",
      severity: "warn",
      message: `Visible text is ${words} words. This check wants at least ${AUDIT_RULES.thinWords}.`,
    });
  }
  if (input.bytes > AUDIT_RULES.largeHtmlBytes) {
    findings.push({ id: "large_html", severity: "warn", message: `HTML is ${input.bytes} bytes, over ${AUDIT_RULES.largeHtmlBytes}.` });
  }
  if (input.truncated) {
    findings.push({ id: "response_truncated", severity: "warn", message: `Body was cut at ${AUDIT_RULES.maxBytes} bytes.` });
  }
  if (input.ttfbMs !== undefined && input.ttfbMs !== null && input.ttfbMs > AUDIT_RULES.slowTtfbMs) {
    findings.push({
      id: "slow_ttfb",
      severity: "warn",
      message: `Time to response headers was ${input.ttfbMs} ms from this process. Threshold is ${AUDIT_RULES.slowTtfbMs} ms. One sample.`,
    });
  }
  if (input.totalMs !== undefined && input.totalMs !== null && input.totalMs > AUDIT_RULES.slowTotalMs) {
    findings.push({
      id: "slow_response",
      severity: "warn",
      message: `Read finished in ${input.totalMs} ms from this process. Threshold is ${AUDIT_RULES.slowTotalMs} ms. One sample.`,
    });
  }
  if (input.contentType && !/text\/html|application\/xhtml\+xml/i.test(input.contentType)) {
    findings.push({ id: "not_html", severity: "info", message: `Content-Type is ${input.contentType}. Markup checks still ran.` });
  }

  return {
    url: input.url ?? null,
    final_url: input.finalUrl ?? input.url ?? null,
    status: input.status ?? null,
    redirects: input.redirects ?? 0,
    ttfb_ms: input.ttfbMs ?? null,
    total_ms: input.totalMs ?? null,
    bytes: input.bytes,
    truncated: input.truncated,
    content_type: input.contentType ?? null,
    title: title || null,
    meta_description: description,
    h1,
    canonical,
    lang,
    images,
    words,
    findings,
    counts: countFindings(findings),
  };
}

function countFindings(findings: Finding[]): { error: number; warn: number; info: number } {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function metaContent(root: HTMLElement, name: string): string | null {
  for (const node of root.querySelectorAll("meta")) {
    const metaName = node.getAttribute("name");
    if (metaName && metaName.toLowerCase() === name) {
      const content = node.getAttribute("content")?.trim();
      return content && content.length > 0 ? content : null;
    }
  }
  return null;
}

function canonicalHref(root: HTMLElement): string | null {
  for (const node of root.querySelectorAll("link")) {
    const rel = node.getAttribute("rel");
    if (!rel) continue;
    const parts = rel.toLowerCase().split(/\s+/);
    if (parts.includes("canonical")) {
      const href = node.getAttribute("href")?.trim();
      return href && href.length > 0 ? href : null;
    }
  }
  return null;
}

function inspectImages(root: HTMLElement): AuditDocument["images"] {
  const images = root.querySelectorAll("img");
  let missing = 0;
  let empty = 0;
  const sample: string[] = [];
  for (const image of images) {
    const alt = image.getAttribute("alt");
    if (alt === undefined) {
      missing += 1;
      if (sample.length < AUDIT_RULES.missingAltSample) {
        const src = image.getAttribute("src")?.trim();
        sample.push(src && src.length > 0 ? src.slice(0, 200) : "(no src)");
      }
    } else if (alt.trim().length === 0) {
      empty += 1;
    }
  }
  return { total: images.length, missing_alt: missing, empty_alt: empty, missing_alt_sample: sample };
}

function visibleText(root: HTMLElement): string {
  const parts: string[] = [];
  walk(root.querySelector("body") ?? root, parts);
  return parts.join(" ");
}

function walk(node: Node, parts: string[]): void {
  if (node.nodeType === NodeType.ELEMENT_NODE) {
    const tag = (node as HTMLElement).tagName?.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;
  }
  for (const child of node.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      const text = child.rawText.replace(/\s+/g, " ").trim();
      if (text) parts.push(text);
    } else if (child.nodeType === NodeType.ELEMENT_NODE) {
      walk(child, parts);
    }
  }
}

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  return text.trim().length === 0 ? 0 : words.length;
}

function textOf(node: HTMLElement | null | undefined): string {
  if (!node) return "";
  return node.text.replace(/\s+/g, " ").trim();
}
