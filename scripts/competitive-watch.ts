#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * competitive-watch.ts
 *
 * The feature watch of the weekly competitor scan (MCP spec D6-D8). For each
 * FEATURE_WATCH source it fetches a page (or an npm version), hashes the
 * watched section, runs its checks, and compares the result with the
 * committed state in scripts/competitive-watch-state.json. It never edits a
 * homepage cell: a person reads the report, re-checks the cited claims in the
 * spec's claims table (14.2), and edits the homepage by hand.
 *
 * update-competitive-matrix.ts runs the watch and writes the state file. Run
 * directly, this script only reports; it writes nothing.
 *
 * Usage:
 *   npx tsx scripts/competitive-watch.ts                  # report against the committed state
 *   npx tsx scripts/competitive-watch.ts --state <path>   # report against another state file
 *   npx tsx scripts/competitive-watch.ts --only <id> [--only <id> ...]  # check only these sources
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeHTML } from "entities";

// ── Types ────────────────────────────────────────────────────────────────────

/** Which part of a page a source watches. */
export type WatchSection =
  /**
   * The one h1-h6 whose text (tags removed, entities decoded, zero-width
   * characters removed, whitespace collapsed) equals `text`, up to the next
   * heading of the same or a higher level.
   */
  | { kind: "heading"; text: string }
  /**
   * The one h1-h6 whose own `id` attribute (not `data-id` or `aria-*-id`) equals
   * `id`, up to the next heading of the same or a higher level. Use it when a
   * heading holds hidden link text.
   */
  | { kind: "heading-id"; id: string }
  /**
   * The first <article> or <main> element (not <article-card> or <main-nav>),
   * up to its matching close tag, so nested elements of the same tag stay inside.
   * An element that is never closed runs to the end of the page.
   */
  | { kind: "element"; tag: "article" | "main" };

export type WatchTarget =
  | { kind: "html"; url: string; section: WatchSection }
  | { kind: "npm"; package: string };

export interface WatchCheck {
  /** Kebab-case, unique within its source. A key in the state file. */
  id: string;
  /** What a true result means. Shown in the report. */
  question: string;
  /** RegExp source, compiled with the "i" flag, run on the section text. */
  pattern: string;
}

export interface WatchSource {
  /** Kebab-case, unique in FEATURE_WATCH. The key in the state file. */
  id: string;
  /** Competitor name, for the report. */
  competitor: string;
  /** Claim ids (MCP spec 14.2) to re-check when this source changes. */
  claims: readonly string[];
  target: WatchTarget;
  /** Checks on the section text. npm sources have none. */
  checks: readonly WatchCheck[];
}

export interface WatchStateEntry {
  url: string;
  /** "sha256:<hex>" of the section text, or of the npm version. */
  hash: string;
  checks: Record<string, boolean>;
  /** npm sources only: the `latest` version. */
  version?: string;
  /** UTC date (YYYY-MM-DD) of the baseline or of the last change. */
  lastChanged: string;
}

export type WatchState = Record<string, WatchStateEntry>;

export type WatchStatus = "baseline" | "no change" | "changed" | "removed";

export interface WatchSourceReport {
  id: string;
  competitor: string;
  claims: readonly string[];
  url: string;
  status: WatchStatus;
  /** What differs from the state ("changed"), or why it was dropped ("removed"). */
  details: string[];
  /** Check id -> matched text for every check that is true now (empty for npm and removed). */
  evidence: Record<string, string>;
}

export interface FeatureWatchResult {
  /** FEATURE_WATCH order, then removed ids sorted. */
  reports: WatchSourceReport[];
  /** The state to commit: one entry per source. */
  state: WatchState;
  /** True when `state` serializes differently from the state that was read. */
  stateChanged: boolean;
}

export type WatchFetch = (
  url: string,
) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;

export interface WatchObservation {
  url: string;
  hash: string;
  checks: Record<string, boolean>;
  /** Check id -> matched text (only for checks that are true). Report-only, never stored. */
  evidence: Record<string, string>;
  version?: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

export const WATCH_STATE_REL_PATH = "scripts/competitive-watch-state.json";

const MASTRA_DOCS = "https://mastra.ai/docs/evals/experiments";
const MOCKSERVER = "https://www.mock-server.com/mock_server/";
/** MockServer "LLM Response Mocking" page (spec 14.2 source LR). Entries on this page share one fetch per run. */
export const MOCKSERVER_LR_URL = `${MOCKSERVER}llm_response_mocking.html`;
const WIREMOCK_AI = "https://wiremock.org/docs/solutions/ai/";

/**
 * Competitor pages behind the MCP-fakes claims (spec D6). Separate from
 * COMPETITORS, so the matrix updater never edits a cell from them. Append new
 * sources; never reuse an id for a different page or section.
 */
export const FEATURE_WATCH: readonly WatchSource[] = [
  {
    id: "mastra-docs-tool-mocks",
    competitor: "Mastra",
    claims: [
      "C-M1",
      "C-M2",
      "C-M3",
      "C-M4",
      "C-M5",
      "C-M6",
      "C-M8",
      "C-M9",
      "C-M10",
      "C-M11",
      "C-M12",
    ],
    target: { kind: "html", url: MASTRA_DOCS, section: { kind: "heading-id", id: "tool-mocks" } },
    checks: [
      {
        id: "mcp",
        question: "Are MCP tools mentioned?",
        pattern: "\\bmcp\\b|model context protocol",
      },
      {
        id: "new-failure-code",
        question:
          "Is there a TOOL_MOCK_ failure code other than NOT_DECLARED, MISMATCH and EXHAUSTED?",
        pattern: "TOOL_MOCK_(?!(?:NOT_DECLARED|MISMATCH|EXHAUSTED)\\b)[A-Z_]+",
      },
      {
        id: "new-match-mode",
        question: "Is there a matchArgs mode other than 'ignore'?",
        pattern: "matchArgs\\s*:\\s*['\"](?!ignore['\"])",
      },
      {
        id: "live-capture",
        question: "Is capturing live tool results into mocks described?",
        pattern: "(captur|record)\\w*[^.]{0,60}\\b(live|real)\\b[^.]{0,60}\\btool",
      },
      {
        id: "mock-from-trace",
        question: "Is creating a mock from a trace mentioned?",
        pattern: "mock from a trace",
      },
      {
        id: "tool-mock-report",
        question: "Is toolMockReport described?",
        pattern: "toolMockReport",
      },
    ],
  },
  {
    id: "mastra-docs-workflow-target",
    competitor: "Mastra",
    claims: ["C-M14"],
    target: {
      kind: "html",
      url: MASTRA_DOCS,
      section: { kind: "heading-id", id: "registered-workflow" },
    },
    checks: [
      {
        id: "tool-mocks",
        question: "Do workflow targets mention tool mocks?",
        pattern: "tool ?mocks?|toolMocks",
      },
    ],
  },
  {
    id: "mastra-blog-tool-mocks",
    competitor: "Mastra",
    claims: ["C-M13", "C-M14", "C-M15"],
    target: {
      kind: "html",
      url: "https://mastra.ai/blog/introducing-experiment-tool-mocks",
      section: { kind: "element", tag: "article" },
    },
    checks: [
      {
        id: "workflow-mocks-planned",
        question: "Does the post still say workflow tool mocks are to follow?",
        pattern: "workflow tool mocks to follow",
      },
      {
        id: "mcp",
        question: "Are MCP tools mentioned?",
        pattern: "\\bmcp\\b|model context protocol",
      },
    ],
  },
  {
    id: "mastra-core-npm",
    competitor: "Mastra",
    claims: ["C-M13"],
    target: { kind: "npm", package: "@mastra/core" },
    checks: [],
  },
  {
    id: "mockserver-ap-mcp",
    competitor: "MockServer",
    claims: ["C-S5", "C-S6", "C-S7", "C-S13"],
    target: {
      kind: "html",
      url: `${MOCKSERVER}ai_protocol_mocking.html`,
      section: { kind: "heading", text: "MCP Server Mocking" },
    },
    checks: [
      {
        id: "ordered-answers",
        question: "Is a call count / Times documented for MCP tools?",
        pattern: "\\btimes\\b",
      },
      {
        id: "argument-matching",
        question: "Is argument matching documented for MCP tools?",
        pattern: "withArguments|arguments?\\s+match|match\\w*\\s+(on\\s+)?arguments?",
      },
      {
        id: "undeclared-policy",
        question: "Is an undeclared-tool policy documented?",
        pattern: "undeclared|unmocked|unknown tool",
      },
    ],
  },
  {
    id: "mockserver-lr-sessions",
    competitor: "MockServer",
    claims: ["C-S4", "C-S13"],
    target: {
      kind: "html",
      url: MOCKSERVER_LR_URL,
      section: { kind: "heading", text: "Session Isolation" },
    },
    checks: [
      {
        id: "mcp-tools-per-session",
        question: "Can MCP tool mocks be tied to a session or scenario?",
        pattern: "mcp tool mock[^.]{0,80}(session|scenario)",
      },
    ],
  },
  {
    id: "mockserver-ao-record",
    competitor: "MockServer",
    claims: ["C-S10"],
    target: {
      kind: "html",
      url: `${MOCKSERVER}ai_overview.html`,
      section: { kind: "element", tag: "article" },
    },
    checks: [
      { id: "replay", question: "Is LLM/MCP record and replay described?", pattern: "\\breplay" },
    ],
  },
  {
    id: "mockserver-dd-cassette",
    competitor: "MockServer",
    claims: ["C-S11"],
    target: {
      kind: "html",
      url: `${MOCKSERVER}drift_detection.html`,
      section: { kind: "heading", text: "Not the same as LLM cassette drift" },
    },
    checks: [
      { id: "cassette", question: "Is LLM cassette drift still named here?", pattern: "cassette" },
    ],
  },
  {
    id: "wiremock-ai-oss",
    competitor: "WireMock",
    claims: ["C-W4", "C-W9"],
    target: {
      kind: "html",
      url: WIREMOCK_AI,
      section: { kind: "heading", text: "Using AI with WireMock OSS" },
    },
    checks: [
      {
        id: "llm-wire",
        question: "Is LLM provider mocking named for OSS?",
        pattern: "\\bllm\\b|openai|anthropic",
      },
      { id: "mcp", question: "Is MCP named for OSS?", pattern: "\\bmcp\\b" },
    ],
  },
  {
    id: "wiremock-cloud-mcp-tools",
    competitor: "WireMock",
    claims: ["C-W5", "C-W10", "C-W11"],
    target: { kind: "html", url: WIREMOCK_AI, section: { kind: "heading", text: "MCP tools" } },
    checks: [
      {
        // Cloud authoring tools do not count as tool mocking (D6).
        id: "tool-mocking",
        question: "Is mocking of MCP tools (not authoring of HTTP stubs) described?",
        pattern: "mock\\w*\\s+(mcp\\s+)?tools?\\b|tool\\s+(call\\s+)?mock",
      },
    ],
  },
  {
    id: "wiremock-rp-recording",
    competitor: "WireMock",
    claims: ["C-W2", "C-W4"],
    target: {
      kind: "html",
      url: "https://wiremock.org/docs/record-playback/",
      section: { kind: "heading", text: "Recording" },
    },
    checks: [
      {
        id: "llm-or-mcp",
        question: "Is LLM or MCP recording named?",
        pattern: "\\bllm\\b|\\bmcp\\b|openai",
      },
    ],
  },
] as const satisfies readonly WatchSource[];

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "aimock-competitive-watch";
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLAIM_RE = /^C-[A-Z]+\d+$/;

// ── Config validation ────────────────────────────────────────────────────────

/** Throws one error listing every problem in the source list. */
export function assertValidWatchConfig(sources: readonly WatchSource[]): void {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of sources) {
    if (!KEBAB_RE.test(s.id)) problems.push(`${s.id}: id must be kebab-case`);
    if (ids.has(s.id)) problems.push(`${s.id}: duplicate id`);
    ids.add(s.id);
    if (s.competitor.trim() === "") problems.push(`${s.id}: competitor is empty`);
    if (s.claims.length === 0) problems.push(`${s.id}: no claims`);
    for (const c of s.claims) if (!CLAIM_RE.test(c)) problems.push(`${s.id}: bad claim id "${c}"`);
    if (s.target.kind === "html" && !s.target.url.startsWith("https://")) {
      problems.push(`${s.id}: url must start with https://`);
    }
    if (s.target.kind === "npm" && s.checks.length > 0)
      problems.push(`${s.id}: npm sources take no checks`);
    const checkIds = new Set<string>();
    for (const c of s.checks) {
      if (!KEBAB_RE.test(c.id)) problems.push(`${s.id}/${c.id}: check id must be kebab-case`);
      if (checkIds.has(c.id)) problems.push(`${s.id}/${c.id}: duplicate check id`);
      checkIds.add(c.id);
      try {
        new RegExp(c.pattern, "i");
      } catch (err) {
        problems.push(`${s.id}/${c.id}: pattern does not compile: ${errorText(err)}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`FEATURE_WATCH is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

// ── Section extraction ───────────────────────────────────────────────────────

// The inside of a tag after its name: any run of characters other than `>`,
// where a quoted attribute value is one unit. A `>` inside a quoted value
// (`onclick="a();"`, `title="a>b"`) ends nothing, so attribute text never
// leaks into the section text and never hides a heading.
const TAG_INNER = String.raw`(?:[^>"']|"[^"]*"|'[^']*')`;
const ANY_TAG_RE = new RegExp(`<${TAG_INNER}+>`, "g");

/**
 * Removes comments, non-content elements and site footers, so a commented-out
 * heading never counts and the last section of a page stops before the footer
 * (its copyright year would change the hash every January).
 */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|footer)(?=[\s/>])[\s\S]*?<\/\1\s*>/gi, " ");
}

/**
 * Tags removed, entities decoded, zero-width and control characters removed,
 * whitespace collapsed. Every C0/C1 control character (`\p{Cc}`, so also
 * `&#1;`-style entities once decoded) is removed, except tab, line feed,
 * vertical tab, form feed and carriage return, which collapse to a space with
 * the rest of the whitespace. So no control byte from a page reaches the
 * report or the Slack digest.
 */
export function htmlToText(html: string): string {
  return decodeHTML(html.replace(ANY_TAG_RE, " "))
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/(?![\t-\r])\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Heading {
  level: number;
  id: string | null;
  text: string;
  start: number;
  end: number;
}

// A tag name ends at whitespace, "/" or ">". A bare `\b` would also accept
// custom elements such as <h2-x>, <main-nav> or <article-card>.
const HEADING_RE = new RegExp(
  String.raw`<h([1-6])(?=[\s/>])(${TAG_INNER}*)>([\s\S]*?)<\/h\1\s*>`,
  "gi",
);
// One attribute: a name, then an optional quoted or unquoted value. Walking the
// attributes in order (instead of searching for `id=`) never reads `data-id`,
// `aria-*-id` or text inside another attribute's quoted value.
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** The value of the first `id` attribute (the one HTML uses), or null. */
function readIdAttr(attrs: string): string | null {
  for (const m of attrs.matchAll(ATTR_RE)) {
    if (m[1].toLowerCase() === "id") return m[2] ?? m[3] ?? m[4] ?? "";
  }
  return null;
}

/**
 * The inner HTML of the first <tag> element, up to its matching close tag
 * (nested elements of the same tag are counted). An unclosed element runs to
 * the end of the page, as a browser closes it there. Null when there is none.
 */
function firstElement(page: string, tag: string): string | null {
  const tagRe = new RegExp(`<(/?)${tag}(?=[\\s/>])${TAG_INNER}*>`, "gi");
  let start = -1;
  let depth = 0;
  for (const m of page.matchAll(tagRe)) {
    const index = m.index ?? 0;
    if (m[1] === "") {
      if (depth === 0) start = index + m[0].length;
      depth++;
    } else if (depth > 0 && --depth === 0) {
      return page.slice(start, index);
    }
  }
  return start === -1 ? null : page.slice(start);
}

function readHeadings(html: string): Heading[] {
  return [...html.matchAll(HEADING_RE)].map((m) => {
    const start = m.index ?? 0;
    return {
      level: Number(m[1]),
      id: readIdAttr(m[2]),
      text: htmlToText(m[3]),
      start,
      end: start + m[0].length,
    };
  });
}

/** The normalized text of the watched section. Throws when it is missing, ambiguous or empty. */
export function extractSection(html: string, section: WatchSection): string {
  const page = stripNonContent(html);
  let raw: string;
  if (section.kind === "element") {
    const inner = firstElement(page, section.tag);
    if (inner === null) throw new Error(`no <${section.tag}> element`);
    raw = inner;
  } else {
    const all = readHeadings(page);
    const what =
      section.kind === "heading" ? `heading "${section.text}"` : `heading id "${section.id}"`;
    const hits = all.filter((h) =>
      section.kind === "heading" ? h.text === section.text : h.id === section.id,
    );
    if (hits.length === 0) throw new Error(`${what} not found`);
    if (hits.length > 1) throw new Error(`${what} is ambiguous (${hits.length} matches)`);
    const h = hits[0];
    const next = all.find((x) => x.start > h.start && x.level <= h.level);
    raw = page.slice(h.end, next ? next.start : page.length);
  }
  const text = htmlToText(raw);
  if (text === "") throw new Error("section is empty");
  return text;
}

// ── Fetch and observe ────────────────────────────────────────────────────────

export function watchUrl(target: WatchTarget): string {
  return target.kind === "html"
    ? target.url
    : `https://registry.npmjs.org/${target.package.replace("/", "%2F")}/latest`;
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

export const fetchWatchText: WatchFetch = async (url) => {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
};

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function observeSource(source: WatchSource, url: string, body: string): WatchObservation {
  if (source.target.kind === "npm") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("registry answer is not JSON");
    }
    const version =
      typeof parsed === "object" && parsed !== null && "version" in parsed
        ? parsed.version
        : undefined;
    if (typeof version !== "string" || version === "")
      throw new Error("registry answer has no version");
    return { url, hash: sha256(version), checks: {}, evidence: {}, version };
  }
  const text = extractSection(body, source.target.section);
  const checks: Record<string, boolean> = {};
  const evidence: Record<string, string> = {};
  for (const c of source.checks) {
    const m = new RegExp(c.pattern, "i").exec(text);
    checks[c.id] = m !== null;
    if (m !== null) {
      const from = Math.max(0, m.index - 60);
      evidence[c.id] = text
        .slice(from, Math.min(text.length, m.index + m[0].length + 60))
        .slice(0, 160);
    }
  }
  return { url, hash: sha256(text), checks, evidence };
}

// ── State ────────────────────────────────────────────────────────────────────

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sorted ids and check ids, fixed field order, 2-space JSON, trailing newline (prettier-stable). */
export function serializeWatchState(state: WatchState): string {
  const out: WatchState = {};
  for (const id of Object.keys(state).sort()) {
    const e = state[id];
    const checks: Record<string, boolean> = {};
    for (const k of Object.keys(e.checks).sort()) checks[k] = e.checks[k];
    out[id] = {
      url: e.url,
      hash: e.hash,
      checks,
      ...(e.version !== undefined ? { version: e.version } : {}),
      lastChanged: e.lastChanged,
    };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Reads and validates the state file. A missing or malformed file fails the run. */
export function readWatchState(path: string): WatchState {
  if (!existsSync(path)) throw new Error(`Feature-watch state file not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Feature-watch state file is not JSON: ${path}: ${errorText(err)}`, {
      cause: err,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Feature-watch state file must hold an object: ${path}`);
  }
  const state: WatchState = {};
  for (const [id, raw] of Object.entries(parsed)) {
    const bad = (what: string) => new Error(`Feature-watch state ${path}: "${id}": ${what}`);
    // A "__proto__" key would set the prototype instead of an own key and be
    // dropped without a word, so it fails the run like any other bad entry.
    if (id === "__proto__") throw bad("is not a valid id");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw bad("entry is not an object");
    const e = raw as Record<string, unknown>;
    if (typeof e.url !== "string") throw bad("url is missing");
    if (typeof e.hash !== "string") throw bad("hash is missing");
    if (typeof e.lastChanged !== "string") throw bad("lastChanged is missing");
    if (e.version !== undefined && typeof e.version !== "string")
      throw bad("version is not a string");
    if (typeof e.checks !== "object" || e.checks === null || Array.isArray(e.checks))
      throw bad("checks is missing");
    const checks: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(e.checks)) {
      if (k === "__proto__") throw bad(`check "${k}" is not a valid id`);
      if (typeof v !== "boolean") throw bad(`check "${k}" is not a boolean`);
      checks[k] = v;
    }
    state[id] = {
      url: e.url,
      hash: e.hash,
      checks,
      ...(typeof e.version === "string" ? { version: e.version } : {}),
      lastChanged: e.lastChanged,
    };
  }
  return state;
}

// ── Compare ──────────────────────────────────────────────────────────────────

function describeDifferences(
  source: WatchSource,
  prev: WatchStateEntry,
  obs: WatchObservation,
): string[] {
  const d: string[] = [];
  // The source URL, not the fetched one: a URL override must never read as a change.
  const url = watchUrl(source.target);
  if (prev.url !== url) d.push(`URL ${prev.url} -> ${url}`);
  if (prev.version !== obs.version)
    d.push(`version ${prev.version ?? "(none)"} -> ${obs.version ?? "(none)"}`);
  else if (prev.hash !== obs.hash) d.push("section text changed");
  for (const c of source.checks) {
    const was = Object.hasOwn(prev.checks, c.id) ? prev.checks[c.id] : undefined;
    const now = obs.checks[c.id];
    if (was === undefined) d.push(`check "${c.id}" added: ${now}`);
    else if (was !== now) {
      const seen = obs.evidence[c.id];
      d.push(`check "${c.id}" (${c.question}) ${was} -> ${now}${seen ? `: "${seen}"` : ""}`);
    }
  }
  for (const id of Object.keys(prev.checks)) {
    if (!source.checks.some((c) => c.id === id)) d.push(`check "${id}" removed`);
  }
  return d;
}

export function compareWithState(
  sources: readonly WatchSource[],
  observations: ReadonlyMap<string, WatchObservation>,
  previous: WatchState,
  today: string,
): FeatureWatchResult {
  const reports: WatchSourceReport[] = [];
  const state: WatchState = {};
  for (const s of sources) {
    const obs = observations.get(s.id);
    if (!obs) throw new Error(`No observation for feature-watch source ${s.id}`);
    const prev = Object.hasOwn(previous, s.id) ? previous[s.id] : undefined;
    const details = prev ? describeDifferences(s, prev, obs) : [];
    const status: WatchStatus = !prev ? "baseline" : details.length > 0 ? "changed" : "no change";
    // The state holds the source URL (D7). The report keeps the fetched URL
    // (obs.url), which differs only when COMPETITIVE_WATCH_URL_OVERRIDES is set.
    state[s.id] = {
      url: watchUrl(s.target),
      hash: obs.hash,
      checks: obs.checks,
      ...(obs.version !== undefined ? { version: obs.version } : {}),
      lastChanged: status === "no change" && prev ? prev.lastChanged : today,
    };
    reports.push({
      id: s.id,
      competitor: s.competitor,
      claims: s.claims,
      url: obs.url,
      status,
      details,
      evidence: obs.evidence,
    });
  }
  for (const id of Object.keys(previous).sort()) {
    if (sources.some((s) => s.id === id)) continue;
    reports.push({
      id,
      competitor: "",
      claims: [],
      url: previous[id].url,
      status: "removed",
      details: ["no longer in FEATURE_WATCH; dropped from the state file"],
      evidence: {},
    });
  }
  return {
    reports,
    state,
    stateChanged: serializeWatchState(state) !== serializeWatchState(previous),
  };
}

// ── Run ──────────────────────────────────────────────────────────────────────

export interface RunFeatureWatchOptions {
  sources: readonly WatchSource[];
  previous: WatchState;
  /** UTC date for lastChanged (YYYY-MM-DD). */
  today: string;
  fetchText?: WatchFetch;
  /** Source URL -> URL to fetch instead (proofs and the fixture harness only; see parseUrlOverrides). */
  urlOverrides?: ReadonlyMap<string, string>;
  log?: (line: string) => void;
}

type Outcome =
  | { source: WatchSource; url: string; obs: WatchObservation }
  | { source: WatchSource; url: string; failure: string };

/**
 * Checks every source. Any source that cannot be checked fails the whole
 * watch (D8): a page we could not read must never read as "no change".
 */
export async function runFeatureWatch(opts: RunFeatureWatchOptions): Promise<FeatureWatchResult> {
  assertValidWatchConfig(opts.sources);
  const fetchText = opts.fetchText ?? fetchWatchText;
  const log = opts.log ?? ((line: string) => console.log(line));
  const bodies = new Map<string, ReturnType<WatchFetch>>();
  const outcomes: Outcome[] = await Promise.all(
    opts.sources.map(async (source): Promise<Outcome> => {
      const sourceUrl = watchUrl(source.target);
      const url = opts.urlOverrides?.get(sourceUrl) ?? sourceUrl;
      let body = bodies.get(url);
      if (!body) {
        body = fetchText(url);
        bodies.set(url, body);
      }
      const res = await body;
      if (!res.ok) return { source, url, failure: res.reason };
      try {
        return { source, url, obs: observeSource(source, url, res.text) };
      } catch (err) {
        return { source, url, failure: errorText(err) };
      }
    }),
  );
  const failures = outcomes.filter(
    (o): o is Extract<Outcome, { failure: string }> => "failure" in o,
  );
  if (failures.length > 0) {
    throw new Error(
      `Feature watch incomplete: ${failures.length} of ${opts.sources.length} source(s) could not be checked:\n` +
        failures.map((f) => `  - ${f.source.id} (${f.url}): ${f.failure}`).join("\n"),
    );
  }
  const observations = new Map<string, WatchObservation>();
  for (const o of outcomes) if ("obs" in o) observations.set(o.source.id, o.obs);
  const result = compareWithState(opts.sources, observations, opts.previous, opts.today);
  for (const r of result.reports) {
    log(`  ${r.id}: ${r.status}${r.details.length > 0 ? ` (${r.details.join("; ")})` : ""}`);
  }
  return result;
}

/**
 * Parses COMPETITIVE_WATCH_URL_OVERRIDES ({"<source URL>": "<replacement URL>"}).
 * Keyed by page, so entries that share a page are redirected together and the
 * page is still fetched once. Used by proofs and the fixture harness only.
 */
export function parseUrlOverrides(
  raw: string | undefined,
  sources: readonly WatchSource[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (raw === undefined || raw.trim() === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("COMPETITIVE_WATCH_URL_OVERRIDES is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("COMPETITIVE_WATCH_URL_OVERRIDES must be a JSON object of source URL -> URL");
  }
  const known = new Set(sources.map((s) => watchUrl(s.target)));
  for (const [from, to] of Object.entries(parsed)) {
    if (!known.has(from)) {
      throw new Error(`COMPETITIVE_WATCH_URL_OVERRIDES names a URL no source watches: ${from}`);
    }
    if (typeof to !== "string" || !/^https?:\/\//.test(to)) {
      throw new Error(`COMPETITIVE_WATCH_URL_OVERRIDES: ${from}: not an http(s) URL`);
    }
    out.set(from, to);
  }
  return out;
}

// ── Report ───────────────────────────────────────────────────────────────────

export function watchNeedsReview(result: FeatureWatchResult): boolean {
  return result.reports.some((r) => r.status !== "no change");
}

/**
 * One competitor- or state-derived value going into a `|`-delimited GFM table
 * cell. It neutralizes this GitHub markup:
 * - a lone UTF-16 surrogate (left by a code-unit cut) is dropped, so the body
 *   never holds U+FFFD;
 * - a line break becomes a space;
 * - `\`, `` ` ``, `*`, `_`, `[`, `]`, `~` and `|` are backslash-escaped in one
 *   pass, so `\` is escaped before `|`: GFM strips one backslash before a pipe
 *   when it splits the row, and `\|` must render as `\|` (same semantics as
 *   `escapeCell` in update-adoption-wall.ts);
 * - `&`, `<` and `>` become entities, so no raw HTML gets through;
 * - U+2060 (word joiner) follows each `@` and `#`, so GitHub makes no
 *   `@user` mention and no `#N` cross-reference;
 * - U+2060 comes before each `$`, so GitHub makes no `$…$` inline math (a
 *   `\$` escape or `&#36;` does not stop it; checked on GitHub's renderer).
 * Not neutralized, and still rendered by GitHub: a bare URL (GFM autolink)
 * and `:shortcode:` emoji. Neither changes the cell or the row. `cell` does not remove control
 * characters: page text has none left (`htmlToText` removes them).
 */
const cell = (s: string): string =>
  s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/\r\n|[\r\n]/g, " ")
    .replace(/[\\`*_[\]~|]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[@#]/g, "$&\u2060")
    .replace(/\$/g, "\u2060$$");

/** The "## Feature watch" summary section (spec D9). */
export function formatWatchSection(result: FeatureWatchResult): string {
  // A link destination: percent-encodes what would end it, split the row or
  // start a code span (`(`, `)`, `|`, `<`, `>`, `\`, `` ` `` and whitespace). A
  // plain http(s) URL has none of them and passes through byte-identical.
  const linkUrl = (url: string): string =>
    url.replace(/[()|<>\\`\s]/g, (c) =>
      Array.from(
        new TextEncoder().encode(c),
        (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
      ).join(""),
    );
  const lines = [
    "## Feature watch",
    "",
    "The scan never changes a homepage cell from these checks. For each source that is not " +
      '"no change", re-check its claims in the MCP spec\'s claims table (14.2), then edit the homepage by hand.',
    "",
    "| Source | Competitor | Claims | Status | Details | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of result.reports) {
    const evidence = Object.entries(r.evidence).map(([id, text]) => `${id}: "${text}"`);
    lines.push(
      `| [${cell(r.id)}](${linkUrl(r.url)}) | ${cell(r.competitor) || "-"} | ` +
        `${cell(r.claims.join(", ")) || "-"} | ` +
        `${r.status} | ${cell(r.details.join("; ")) || "-"} | ${cell(evidence.join("; ")) || "-"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ── Direct run (report only, writes nothing) ─────────────────────────────────

/**
 * Every value given for `flag` in `args`, in order. Throws when an occurrence
 * has no value or is followed by another flag, so `--state --only x` never
 * reads `--only` as a path, and on the `--flag=value` form, which is rejected
 * rather than silently ignored. The one flag-value parser for the competitor
 * scripts (update-competitive-matrix.ts uses it too). The one rule for a
 * repeated single-value flag (`--state`, `--summary`, `--watch-state`): the
 * last one wins, so callers take `.at(-1)`. A list flag (`--only`) keeps all.
 */
export function flagValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(`${flag}=`)) {
      const value = args[i].slice(flag.length + 1);
      throw new Error(`${flag}=${value} is not supported; use ${flag} ${value}`);
    }
    if (args[i] !== flag) continue;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    out.push(v);
  }
  return out;
}

/**
 * Checks a whole command line before the script does any work (and so before
 * any fetch). `valueFlags` each take one value (see flagValues); `switches`
 * take none. Throws on a bad value, on `--flag=value`, on an unknown option,
 * and on a stray positional argument such as the `b` in `--only a b`.
 */
export function checkArgs(
  args: readonly string[],
  valueFlags: readonly string[],
  switches: readonly string[] = [],
): void {
  for (const flag of valueFlags) flagValues(args, flag);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.includes(arg)) {
      i++;
      continue;
    }
    if (switches.includes(arg)) continue;
    if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    const prev = valueFlags.includes(args[i - 2] ?? "") ? args[i - 2] : undefined;
    throw new Error(
      prev === undefined
        ? `unexpected argument ${arg}`
        : `unexpected argument ${arg}: ${prev} takes one value; repeat it (${prev} ${args[i - 1]} ${prev} ${arg})`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  checkArgs(args, ["--state", "--only"]);
  const repoRoot = resolve(import.meta.dirname ?? __dirname, "..");
  const statePath = resolve(
    flagValues(args, "--state").at(-1) ?? resolve(repoRoot, WATCH_STATE_REL_PATH),
  );
  const only = flagValues(args, "--only");
  const unknown = only.filter((id) => !FEATURE_WATCH.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`--only names unknown source(s): ${unknown.join(", ")}`);
  const sources =
    only.length > 0 ? FEATURE_WATCH.filter((s) => only.includes(s.id)) : FEATURE_WATCH;
  const all = readWatchState(statePath);
  const previous: WatchState =
    only.length > 0
      ? Object.fromEntries(Object.entries(all).filter(([id]) => only.includes(id)))
      : all;
  const overrides = parseUrlOverrides(process.env.COMPETITIVE_WATCH_URL_OVERRIDES, FEATURE_WATCH);
  if (overrides.size > 0) {
    console.warn(
      `  ⚠ COMPETITIVE_WATCH_URL_OVERRIDES redirects: ${[...overrides.keys()].join(", ")}`,
    );
  }
  console.log(`=== Feature watch (${sources.length} source(s), state ${statePath}) ===`);
  const result = await runFeatureWatch({
    sources,
    previous,
    today: todayUtc(),
    urlOverrides: overrides,
  });
  console.log("");
  for (const [id, e] of Object.entries(result.state)) {
    console.log(
      `${id} ${e.hash.slice(7, 19)}${e.version ? ` ${e.version}` : ""} ${JSON.stringify(e.checks)}`,
    );
  }
  console.log(`\n${formatWatchSection(result)}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
