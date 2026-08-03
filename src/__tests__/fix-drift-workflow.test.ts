/**
 * Assertions on .github/workflows/fix-drift.yml.
 *
 * C3 (delete-freewriter-predicate-rewire): this workflow used to invoke an
 * autonomous coding-agent subprocess to freewrite a fix for whatever drift the
 * collector found, then gate the resulting diff behind a 916-line anti-cheat
 * verdict function (`scripts/drift-success-predicate.ts`) before opening a PR.
 * Both have been DELETED entirely. This suite (retargeted from the deleted
 * predicate-era assertions) pins the NEW, load-bearing wiring instead:
 *
 *   - the workflow triggers on workflow_dispatch and a SCHEDULED cron (the
 *     deprecation detector fires independently of drift-test failure — a
 *     vanished model family does not, by itself, red the Drift Tests
 *     workflow), and on AT MOST ONE trigger for a given Drift Tests failure
 *     (see the double-fire section below).
 *   - the "Auto-fix drift" step is replaced by `scripts/drift-sync.ts` (the
 *     deterministic, zero-LLM model-family sync core).
 *   - the "Assert drift truly resolved" step is replaced by
 *     `scripts/drift-sync-check.ts` (the trivial allowlist + pin + re-collect
 *     gate).
 *   - the PR-open path is gated on `reason == 'ok-applied'`, never on a
 *     verdict function.
 *   - the NO-AUTO-MERGE human-approval backstop is preserved verbatim (Phase
 *     0/1 — auto-merge is an explicit, opt-in Phase-4 exception, out of scope
 *     here).
 *   - there is NO remaining reference to the deleted predicate/LLM machinery.
 *   - EVERY failure window of the sync reaches a human (no green-and-silent
 *     conclusion, no contentless alert).
 *
 * ── HOW THESE GUARDS ARE WRITTEN, AND WHY ─────────────────────────────────
 *
 * This suite was rewritten after multiple reviewers proved BY MUTATION that
 * several of its assertions could not fail. Every vacuous guard had the same
 * shape: a regex or a byte-window `indexOf` slice standing in for a question
 * about STRUCTURE. Re-adding the double-fire `workflow_run` trigger in
 * block-sequence YAML kept the double-fire guard green; the "sync job
 * permissions" guard actually read the WORKFLOW-level permissions block; a
 * `toContain("no PR spam")` asserted an English COMMENT and stayed green with
 * every line of dedup logic deleted.
 *
 * So: the workflow is PARSED (mapping/sequence/flow/block-scalar — see the
 * reader below), steps are looked up by `id`/`name` rather than by document
 * order, `if:` conditions are EVALUATED against explicit failure scenarios
 * rather than string-matched, and shell-level claims are made against the
 * specific step's `run:` body rather than the whole file. Where a guard forbids
 * something, it is checked against the CODE surface, so the workflow stays free
 * to document its own rationale in comments.
 *
 * The repo ships no YAML dependency and this suite adds none; actionlint in CI
 * covers structural validity separately.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { SyncCoreReason } from "../../scripts/drift-sync.js";

const WORKFLOW_PATH = resolve(__dirname, "../../.github/workflows/fix-drift.yml");
const wf = readFileSync(WORKFLOW_PATH, "utf-8");

/** Collapse runs of whitespace so multi-line YAML `run:` blocks match linearly. */
const wfFlat = wf.replace(/\s+/g, " ");
// ---------------------------------------------------------------------------
// A minimal, indentation-driven YAML reader for the GitHub-Actions subset.
//
// WHY THIS EXISTS. The guards below used to match the workflow with regexes
// pinned to ONE hand-written YAML spelling. That was proven vacuous by
// mutation: `workflows: [Drift Tests]` (flow sequence, 4-space indent) was
// caught, but the equally-valid block-sequence spelling
//
//     workflow_run:
//       workflows:
//         - Drift Tests
//
// slipped straight through, so re-adding the double-fire trigger kept the
// double-fire guard GREEN. A regex cannot enumerate YAML's spellings; a parser
// does not have to. The repo ships no YAML dependency (and this suite must not
// add one), so this reads the subset the workflow actually uses: block
// mappings, block sequences (both "more-indented" and "same-indent" forms),
// compact `- key: value` sequence entries, flow sequences/mappings, single- and
// double-quoted scalars, and block scalars (`|`, `>`, with `-`/`+` chomping and
// an optional explicit indent indicator).
//
// Deliberately NOT YAML-1.1: the bare key `on` stays the STRING "on" rather
// than being coerced to boolean `true`. That coercion is the classic Actions
// footgun and would silently hide the trigger block from every guard here.
// ---------------------------------------------------------------------------

type YNode = string | number | boolean | null | YNode[] | { [k: string]: YNode };

interface PLine {
  indent: number;
  text: string;
  raw: string;
  blank: boolean;
  comment: boolean;
}

/** Strip an unquoted trailing `# ...` comment (a `#` at line start or after whitespace). */
function stripInlineComment(s: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === '"' && c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'";
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).replace(/\s+$/, "");
  }
  return s;
}

/** Parse a single-line flow collection (`[a, b]`, `{k: v, k2: [x]}`) or flow scalar. */
function parseFlow(src: string): YNode {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const rawScalar = (isKey: boolean): string => {
    ws();
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i++];
      let out = "";
      while (i < src.length && src[i] !== q) {
        if (q === '"' && src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i++];
      }
      i++;
      return q + out + q;
    }
    const start = i;
    const stop = isKey ? /[:,\]}]/ : /[,\]}]/;
    while (i < src.length && !stop.test(src[i])) i++;
    return src.slice(start, i).trim();
  };
  const node = (): YNode => {
    ws();
    if (src[i] === "[") {
      i++;
      const arr: YNode[] = [];
      ws();
      if (src[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(node());
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "]") i++;
        break;
      }
      return arr;
    }
    if (src[i] === "{") {
      i++;
      const obj: Record<string, YNode> = {};
      ws();
      if (src[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        const k = parseScalar(rawScalar(true));
        ws();
        if (src[i] === ":") i++;
        obj[String(k)] = node();
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "}") i++;
        break;
      }
      return obj;
    }
    return parseScalar(rawScalar(false));
  };
  return node();
}

/** Resolve a plain/quoted/flow scalar. `on` is NEVER coerced to a boolean. */
function parseScalar(input: string): YNode {
  const s = input.trim();
  if (s === "") return null;
  if (s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s[0] === "[" || s[0] === "{") return parseFlow(s);
  if (s.length > 1 && s[0] === '"' && s.endsWith('"')) {
    return s
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\(["\\/])/g, "$1");
  }
  if (s.length > 1 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "true" || s === "false") return s === "true";
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

const KEY_RE = /^(?:"([^"]*)"|'([^']*)'|([^\s#'"[{][^:]*?)):(?:\s+(.*))?$/;
const BLOCK_SCALAR_RE = /^[|>](?:[+-]?\d*|\d*[+-]?)$/;

function parseYaml(src: string): YNode {
  const lines: PLine[] = src.split("\n").map((raw) => {
    const lead = /^ */.exec(raw)![0].length;
    const text = raw.slice(lead).replace(/\s+$/, "");
    return { indent: lead, text, raw, blank: text === "", comment: text.startsWith("#") };
  });
  const n = lines.length;
  const skip = (i: number): number => {
    while (i < n && (lines[i].blank || lines[i].comment)) i++;
    return i;
  };
  const isSeq = (l: PLine): boolean => /^-(\s|$)/.test(l.text);

  function matchKey(text: string): { key: string; rest: string } | null {
    const m = KEY_RE.exec(text);
    if (!m) return null;
    return { key: m[1] ?? m[2] ?? m[3], rest: (m[4] ?? "").trim() };
  }

  function parseBlockScalar(header: string, start: number, parentIndent: number): [string, number] {
    const folded = header[0] === ">";
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const explicit = /(\d+)/.exec(header);
    let contentIndent = explicit ? parentIndent + Number(explicit[1]) : -1;
    const buf: string[] = [];
    let i = start;
    while (i < n) {
      const L = lines[i];
      if (L.blank) {
        buf.push("");
        i++;
        continue;
      }
      if (contentIndent === -1) {
        if (L.indent <= parentIndent) break;
        contentIndent = L.indent;
      }
      if (L.indent < contentIndent) break;
      buf.push(L.raw.slice(contentIndent).replace(/\s+$/, ""));
      i++;
    }
    while (buf.length && buf[buf.length - 1] === "") buf.pop();
    let text: string;
    if (!folded) {
      text = buf.join("\n");
    } else {
      let out = "";
      let atBreak = true;
      for (const l of buf) {
        if (l === "") {
          out += "\n";
          atBreak = true;
          continue;
        }
        // A MORE-INDENTED line in a folded scalar is not folded (YAML 1.2
        // §8.1.3): its preceding line break is preserved literally.
        if (/^\s/.test(l)) {
          out += (atBreak ? "" : "\n") + l;
          atBreak = false;
          continue;
        }
        out += atBreak ? l : " " + l;
        atBreak = false;
      }
      text = out;
    }
    if (chomp !== "strip" && text !== "") text += "\n";
    return [text, i];
  }

  function parseValue(i: number, indent: number): [YNode, number] {
    const L = lines[i];
    if (isSeq(L)) return parseSequence(i, indent);
    if (matchKey(L.text)) return parseMapping(i, indent);
    if (L.text[0] === "[" || L.text[0] === "{") return [parseFlow(L.text), i + 1];
    return [parseScalar(stripInlineComment(L.text)), i + 1];
  }

  function parseSequence(startIdx: number, indent: number): [YNode[], number] {
    const arr: YNode[] = [];
    let i = startIdx;
    for (;;) {
      i = skip(i);
      if (i >= n) break;
      const L = lines[i];
      if (L.indent !== indent || !isSeq(L)) break;
      const after = L.text.slice(1);
      const rest = after.trimStart();
      if (rest === "" || rest.startsWith("#")) {
        const j = skip(i + 1);
        if (j < n && lines[j].indent > indent) {
          const [v, ni] = parseValue(j, lines[j].indent);
          arr.push(v);
          i = ni;
        } else {
          arr.push(null);
          i = i + 1;
        }
        continue;
      }
      const contentIndent = indent + 1 + (after.length - rest.length);
      lines[i] = { ...L, indent: contentIndent, text: rest };
      const [v, ni] = parseValue(i, contentIndent);
      arr.push(v);
      i = ni;
    }
    return [arr, i];
  }

  function parseMapping(startIdx: number, indent: number): [Record<string, YNode>, number] {
    const map: Record<string, YNode> = {};
    let i = startIdx;
    for (;;) {
      i = skip(i);
      if (i >= n) break;
      const L = lines[i];
      if (L.indent !== indent) break;
      const kv = matchKey(L.text);
      if (!kv) break;
      const { key, rest } = kv;
      if (rest === "" || rest.startsWith("#")) {
        const j = skip(i + 1);
        if (j < n && lines[j].indent > indent) {
          const [v, ni] = parseValue(j, lines[j].indent);
          map[key] = v;
          i = ni;
        } else if (j < n && lines[j].indent === indent && isSeq(lines[j])) {
          // Same-indent block sequence under a key — valid YAML, and the exact
          // spelling the old regex-based trigger guard was blind to.
          const [v, ni] = parseSequence(j, indent);
          map[key] = v;
          i = ni;
        } else {
          map[key] = null;
          i = i + 1;
        }
        continue;
      }
      if (BLOCK_SCALAR_RE.test(rest)) {
        const [v, ni] = parseBlockScalar(rest, i + 1, indent);
        map[key] = v;
        i = ni;
        continue;
      }
      map[key] = parseScalar(stripInlineComment(rest));
      i = i + 1;
    }
    return [map, i];
  }

  const first = skip(0);
  if (first >= n) throw new Error("empty YAML document");
  const [doc] = parseValue(first, lines[first].indent);
  return doc;
}

// ---------------------------------------------------------------------------
// Typed accessors over the parsed workflow.
//
// Every lookup below is by STRUCTURE (job -> steps -> step `id`), never by
// document ORDER. The old suite sliced the workflow text with `indexOf` and a
// fixed byte window, so several guards passed only because the block they meant
// to inspect happened to come first in the file: the "sync job permissions"
// guard actually read the WORKFLOW-level `permissions:` (line ~29, not the
// job's ~52), and `syncJobIf()` matched the 4-space substring of an
// 8-space-indented STEP-level `if: >-`.
// ---------------------------------------------------------------------------

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, YNode>;
}

/**
 * Parse once, but NEVER at collection time. A throw here used to abort module
 * evaluation, which made the "guard is not vacuous" canary itself vacuous: the
 * canary can only fail if the parse failure is a VALUE it can assert on.
 */
function readWorkflow(src: string): { doc: Record<string, YNode> | null; error: string | null } {
  try {
    const doc = parseYaml(src);
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      return { doc: null, error: "top-level node is not a mapping" };
    }
    return { doc: doc as Record<string, YNode>, error: null };
  } catch (e) {
    return { doc: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const parsed = readWorkflow(wf);

function docOf(src: string): Record<string, YNode> {
  const p = src === wf ? parsed : readWorkflow(src);
  if (!p.doc) throw new Error(`fix-drift.yml did not parse: ${p.error}`);
  return p.doc;
}

function syncJob(src: string = wf): Record<string, YNode> {
  const jobs = docOf(src).jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    throw new Error("fix-drift.yml: no `jobs:` mapping");
  }
  const job = (jobs as Record<string, YNode>).sync;
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("fix-drift.yml: no `sync` job");
  }
  return job as Record<string, YNode>;
}

function steps(src: string = wf): Step[] {
  const s = syncJob(src).steps;
  if (!Array.isArray(s)) throw new Error("fix-drift.yml: the `sync` job has no `steps:` sequence");
  return s as unknown as Step[];
}

/** A step by its `id:` — the only stable, order-independent handle it has. */
function stepById(id: string, src: string = wf): Step {
  const hits = steps(src).filter((s) => s.id === id);
  if (hits.length !== 1) {
    throw new Error(
      `fix-drift.yml: expected exactly ONE step with id: ${id}, found ${hits.length}`,
    );
  }
  return hits[0];
}

/** A step by its exact `name:`. Steps without an id (the alerts) need this. */
function stepByName(name: string, src: string = wf): Step {
  const hits = steps(src).filter((s) => s.name === name);
  if (hits.length !== 1) {
    throw new Error(
      `fix-drift.yml: expected exactly ONE step named ${JSON.stringify(name)}, found ${hits.length}`,
    );
  }
  return hits[0];
}

const runOf = (s: Step): string => s.run ?? "";

// ---------------------------------------------------------------------------
// TRIGGERS — read from the parsed `on:` node, in whatever spelling it uses.
// ---------------------------------------------------------------------------
function triggersOf(src: string): { names: string[]; workflowRunWorkflows: string[] } {
  // NOT `doc.on` via YAML-1.1 coercion — see the parser note; the key is "on".
  const on = docOf(src)["on"];
  if (on === null || on === undefined) throw new Error("fix-drift.yml: no top-level `on:` node");

  let names: string[];
  if (typeof on === "string") names = [on];
  else if (Array.isArray(on)) names = on.map(String);
  else if (typeof on === "object") names = Object.keys(on);
  else throw new Error(`fix-drift.yml: unreadable \`on:\` node (${typeof on})`);

  const workflowRunWorkflows: string[] = [];
  if (!Array.isArray(on) && typeof on === "object" && on !== null) {
    const wr = (on as Record<string, YNode>).workflow_run;
    if (wr && typeof wr === "object" && !Array.isArray(wr)) {
      const list = (wr as Record<string, YNode>).workflows;
      if (typeof list === "string") workflowRunWorkflows.push(list);
      else if (Array.isArray(list)) workflowRunWorkflows.push(...list.map(String));
    }
  }
  return { names, workflowRunWorkflows };
}

/**
 * The triggers that ALL fire on the day/run in which "Drift Tests" concludes
 * failure. More than one means duplicate Fix Drift runs and duplicate Slack
 * alerts (see the DOUBLE-FIRE GUARD block below). `workflow_dispatch` is manual
 * and never self-fires, so it is not counted.
 */
function firesOnDriftFailure(src: string): string[] {
  const { names, workflowRunWorkflows } = triggersOf(src);
  return [
    names.includes("schedule") ? "schedule" : null,
    workflowRunWorkflows.includes("Drift Tests") ? 'workflow_run(["Drift Tests"])' : null,
  ].filter((t): t is string => t !== null);
}

// ---------------------------------------------------------------------------
// The CODE surface: every scalar the runner actually evaluates or executes,
// with YAML comments excluded by construction (the parser drops them) and shell
// comment lines stripped out of `run:` bodies.
//
// The old `expect(wf).not.toMatch(/\bstatuses\b/)` was a whole-FILE prose ban:
// it forbade even DOCUMENTING why the dead `statuses: read` permission was
// removed. The question it meant to ask — "does any step actually consume
// commit statuses?" — is a question about code, not about prose.
// ---------------------------------------------------------------------------
function codeSurface(src: string): string {
  const out: string[] = [];
  const walk = (node: YNode, key?: string): void => {
    if (node === null) return;
    if (Array.isArray(node)) {
      node.forEach((v) => walk(v));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        out.push(k);
        walk(v, k);
      }
      return;
    }
    const s = String(node);
    out.push(
      key === "run"
        ? s
            .split("\n")
            .filter((l) => !/^\s*#/.test(l))
            .join("\n")
        : s,
    );
  };
  walk(docOf(src));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub-Actions `if:` EXPRESSION EVALUATOR.
//
// Several claims in this suite are about REACHABILITY — "on this failure the
// job cannot end green with no alert". That is a question about how the runner
// SELECTS steps, and no substring match can answer it. This evaluates the
// subset of the expression language the workflow uses (status functions,
// `github.*` / `steps.*` contexts, `==`/`!=`, `&&`/`||`/`!`, parentheses) so
// the guards can OBSERVE which steps a given scenario selects.
// ---------------------------------------------------------------------------
interface StepState {
  outcome: "success" | "failure" | "skipped" | "";
  outputs: Record<string, string>;
}
interface EvalCtx {
  event_name: string;
  /** Has any earlier step failed? Drives failure()/success(). */
  jobFailed: boolean;
  steps: Record<string, StepState>;
}

type Tok = { t: "op" | "str" | "num" | "id" | "lparen" | "rparen"; v: string };

function lexExpr(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v = "";
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          v += "'";
          j += 2;
          continue;
        }
        if (src[j] === "'") break;
        v += src[j++];
      }
      out.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    if (["==", "!=", "&&", "||"].includes(src.slice(i, i + 2))) {
      out.push({ t: "op", v: src.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (c === "(") {
      out.push({ t: "lparen", v: c });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: "rparen", v: c });
      i++;
      continue;
    }
    if (c === "!") {
      out.push({ t: "op", v: "!" });
      i++;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.\-*]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const num = /^-?\d+/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    throw new Error(`if-expression: cannot lex ${JSON.stringify(src.slice(i, i + 20))}`);
  }
  return out;
}

const STATUS_FN = /\b(success|failure|cancelled|always)\s*\(\s*\)/;

function evaluateIf(exprIn: string, ctx: EvalCtx): boolean {
  let src = exprIn.trim();
  if (src.startsWith("${{") && src.endsWith("}}")) src = src.slice(3, -2).trim();
  // A step `if:` with NO status-check function carries an implicit `success()`:
  // the runner skips it once an earlier step has failed. Modelling that is
  // load-bearing — the `assert` step relies on exactly this.
  if (!STATUS_FN.test(src)) src = `success() && (${src})`;

  const toks = lexExpr(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];

  const truthy = (v: string | boolean): boolean => (typeof v === "boolean" ? v : v !== "");

  const resolve = (path: string): string => {
    if (path === "github.event_name") return ctx.event_name;
    const st = /^steps\.([A-Za-z0-9_-]+)\.(.+)$/.exec(path);
    if (st) {
      const state = ctx.steps[st[1]] ?? { outcome: "" as const, outputs: {} };
      if (st[2] === "outcome" || st[2] === "conclusion") return state.outcome;
      const out = /^outputs\.(.+)$/.exec(st[2]);
      if (out) return state.outputs[out[1]] ?? "";
      return "";
    }
    // Any other context (notably `github.event.workflow_run.*`, populated ONLY
    // under the workflow_run trigger) resolves to the empty string, exactly as
    // an absent context does on the runner.
    return "";
  };

  function primary(): string | boolean {
    const t = peek();
    if (!t) throw new Error(`if-expression: unexpected end of input in ${JSON.stringify(src)}`);
    if (t.t === "lparen") {
      p++;
      const v = or();
      if (peek()?.t !== "rparen") throw new Error("if-expression: missing `)`");
      p++;
      return v;
    }
    if (t.t === "str" || t.t === "num") {
      p++;
      return t.v;
    }
    if (t.t === "id") {
      p++;
      if (peek()?.t === "lparen") {
        p++;
        if (peek()?.t !== "rparen") throw new Error(`if-expression: ${t.v}() takes no arguments`);
        p++;
        switch (t.v) {
          case "always":
            return true;
          case "success":
            return !ctx.jobFailed;
          case "failure":
            return ctx.jobFailed;
          case "cancelled":
            return false;
          default:
            throw new Error(`if-expression: unmodelled function ${t.v}()`);
        }
      }
      if (t.v === "true" || t.v === "false") return t.v === "true";
      return resolve(t.v);
    }
    throw new Error(`if-expression: unexpected token ${t.v}`);
  }

  function unary(): string | boolean {
    if (peek()?.t === "op" && peek()!.v === "!") {
      p++;
      return !truthy(unary());
    }
    return primary();
  }

  function cmp(): string | boolean {
    const a = unary();
    const t = peek();
    if (t?.t === "op" && (t.v === "==" || t.v === "!=")) {
      p++;
      const b = unary();
      const eq = String(a) === String(b);
      return t.v === "==" ? eq : !eq;
    }
    return a;
  }

  function and(): boolean {
    let v = truthy(cmp());
    while (peek()?.t === "op" && peek()!.v === "&&") {
      p++;
      v = truthy(cmp()) && v;
    }
    return v;
  }

  function or(): boolean {
    let v = and();
    while (peek()?.t === "op" && peek()!.v === "||") {
      p++;
      v = and() || v;
    }
    return v;
  }

  const result = truthy(or());
  if (p !== toks.length)
    throw new Error(`if-expression: trailing tokens in ${JSON.stringify(src)}`);
  return result;
}

/** Which steps the runner would SELECT under `ctx` (ignoring what they then do). */
function selectedSteps(ctx: EvalCtx, src: string = wf): Step[] {
  return steps(src).filter((s) => (s.if === undefined ? !ctx.jobFailed : evaluateIf(s.if, ctx)));
}

/** Steps that exist to tell a human something (Slack + `::error::`). */
const isAlertStep = (s: Step): boolean => /^(Alert|Notify)\b/.test(s.name ?? "");

/**
 * ASSEMBLE every Slack message a step can build, the way bash will, and return
 * them.
 *
 * The raw YAML text cannot answer "does this message contain a newline": the
 * literal two characters `\n` (which bash does NOT expand inside double quotes)
 * and a `${NL}` holding a real newline look equally plausible in source. So each
 * `MSG=` assignment is EVALUATED — preceded by every side-effect-free literal
 * assignment above it, so `NL=$'\n'` and the `WHERE=`/`HEADLINE=` branches are
 * in scope — and the resulting string is printed.
 *
 * Assignments are evaluated one at a time rather than by running the body up to
 * the last one: a step may legitimately build DIFFERENT messages in different
 * branches (the success alert distinguishes "PR just opened" from "PR still
 * open"), and truncating mid-`if` produced a bash syntax error rather than a
 * finding. Branch structure is irrelevant here — what is under test is how each
 * string is BUILT, so every one of them gets checked.
 */
function assembleSlackMessages(step: Step): string[] {
  const lines = runOf(step).split("\n");
  const isMsg = (l: string) => /^\s*MSG=/.test(l);
  const isLiteralAssignment = (l: string) =>
    /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(l) && !l.includes("$(") && !l.includes("`");
  const msgLines = lines.flatMap((l, i) => (isMsg(l) ? [i] : []));
  if (msgLines.length === 0) throw new Error(`${step.name}: no MSG= assignment to assemble`);

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(step.env ?? {})) env[key] = `<${key}>`;

  const dir = mkdtempSync(join(tmpdir(), "fix-drift-msg-"));
  try {
    return msgLines.map((idx) => {
      const outFile = join(dir, `msg-${idx}.txt`);
      const script = join(dir, `msg-${idx}.sh`);
      writeFileSync(
        script,
        [
          ...lines.slice(0, idx).filter((l) => isLiteralAssignment(l) && !isMsg(l)),
          lines[idx],
          `printf '%s' "$MSG" > ${JSON.stringify(outFile)}`,
        ].join("\n"),
      );
      const res = spawnSync("/bin/bash", [script], { cwd: dir, encoding: "utf-8", env });
      if (res.status !== 0) {
        throw new Error(
          `${step.name}: assembling the MSG on line ${idx + 1} failed (${res.status}): ${res.stderr}`,
        );
      }
      return readFileSync(outFile, "utf-8");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shell-level helpers over `run:` bodies.
// ---------------------------------------------------------------------------

/**
 * Every invocation of `cmd` in `run`, as the WHOLE command (backslash line
 * continuations joined), regardless of flag ORDER.
 *
 * The old `--limit` guard used `/gh pr list[^|]*?--json [a-zA-Z,]+/`, which only
 * ever saw an invocation whose `--json` came before any `|` — so a `gh pr list`
 * with its flags reordered, or with no `--json` at all, was never examined and
 * silently kept its default limit of 30.
 *
 * Distinguishing a COMMAND from a message ABOUT a command needs more than a
 * substring search, and more than naive quote tracking: `X="$(gh pr list …)"`
 * is an invocation even though it sits inside double quotes, while
 * `echo "::error::gh pr list failed …"` is not one at all. So the body is
 * scanned with a stack of command-substitution frames — `$( … )` opens a FRESH
 * command context, quoting and all — and only unquoted occurrences count.
 */
function shellInvocations(run: string, cmd: string): string[] {
  // Shell COMMENT lines are dropped first: the workflow documents `--limit 200`
  // in prose right above the call it applies to, and a comment is not an
  // invocation — counting it as one made this guard fail on its own rationale.
  const joined = run
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .replace(/\\\n\s*/g, " ");

  const starts: number[] = [];
  const frames: Array<{ quote: '"' | "'" | null }> = [{ quote: null }];
  for (let i = 0; i < joined.length; i++) {
    const f = frames[frames.length - 1];
    const c = joined[i];
    if (f.quote === "'") {
      if (c === "'") f.quote = null;
      continue;
    }
    if (f.quote === '"') {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') {
        f.quote = null;
        continue;
      }
      // Command substitution inside double quotes is still a command context.
      if (c === "$" && joined[i + 1] === "(") {
        frames.push({ quote: null });
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      f.quote = c;
      continue;
    }
    if (c === "$" && joined[i + 1] === "(") {
      frames.push({ quote: null });
      i++;
      continue;
    }
    if (c === ")" && frames.length > 1) {
      frames.pop();
      continue;
    }
    if (joined.startsWith(cmd, i)) starts.push(i);
  }

  return starts.map((at) => {
    let end = joined.length;
    let quote: '"' | "'" | null = null;
    for (let i = at; i < joined.length; i++) {
      const c = joined[i];
      if (quote) {
        if (c === quote) quote = null;
        else if (quote === '"' && c === "\\") i++;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === "\n" || c === ";" || c === "|" || c === ")" || c === "&") {
        end = i;
        break;
      }
    }
    return joined.slice(at, end).trim();
  });
}

/**
 * The enclosing guard body for the statement at `lines[idx]`: everything from
 * the nearest enclosing `if`/`elif`/`for`/`while` header down to that
 * statement.
 *
 * Replaces a FIXED 3-line lookback, which silently missed any early return
 * whose guard body was longer than three lines (a compound guard, an
 * intervening comment, or a `printf` split across lines).
 */
function enclosingGuardBody(lines: string[], idx: number): string {
  let start = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (/^\s*(if|elif|for|while)\b/.test(lines[i])) {
      start = i;
      break;
    }
    if (/^\s*fi\b|^\s*done\b/.test(lines[i])) {
      // A closed sibling block — keep walking outward past it.
      continue;
    }
  }
  return lines.slice(start, idx).join("\n");
}

// ---------------------------------------------------------------------------
// JOB SIMULATION. `evaluateIf` answers "would THIS step run"; several claims
// here are about the job as a whole ("this failure reaches a human", "exactly
// one alert fires"), and those depend on step ORDER: a step's `outcome` is
// `skipped` once the runner has evaluated it, and empty before that. So walk the
// steps in order, carrying the accumulated state forward.
// ---------------------------------------------------------------------------
interface Scenario {
  event_name?: string;
  /** Step ids or names that FAIL when the runner selects them. */
  failing?: string[];
  /** Step outputs, by step id, published when that step is selected. */
  outputs?: Record<string, Record<string, string>>;
}

function simulateJob(
  sc: Scenario,
  src: string = wf,
): { selected: Step[]; alerts: string[]; jobFailed: boolean } {
  const ctx: EvalCtx = { event_name: sc.event_name ?? "schedule", jobFailed: false, steps: {} };
  const failing = new Set(sc.failing ?? []);
  const selected: Step[] = [];
  for (const s of steps(src)) {
    const runs = s.if === undefined ? !ctx.jobFailed : evaluateIf(s.if, ctx);
    const fails =
      runs &&
      ((s.id !== undefined && failing.has(s.id)) || (s.name !== undefined && failing.has(s.name)));
    if (s.id) {
      ctx.steps[s.id] = {
        outcome: runs ? (fails ? "failure" : "success") : "skipped",
        // Outputs are published by a step that RAN, even if it then failed
        // (the sync step writes $GITHUB_OUTPUT before exiting non-zero).
        outputs: runs ? (sc.outputs?.[s.id] ?? {}) : {},
      };
    }
    if (runs) selected.push(s);
    if (fails) ctx.jobFailed = true;
  }
  return {
    selected,
    alerts: selected.filter(isAlertStep).map((s) => s.name!),
    jobFailed: ctx.jobFailed,
  };
}

/**
 * EXECUTE the sync step's own `run:` body against a drift-sync that CRASHES
 * before printing any `reason=` line, and report what the runner would see.
 *
 * This is an OBSERVATION, not an assertion about the body's text: the step is
 * run under bash with `npx` replaced by a stub standing in for drift-sync.ts's
 * fatal handler (`drift-sync fatal error: …` on stderr, exit 1 — it fires before
 * the first `console.log`, because runDriftSyncCli awaits every provider's churn
 * input up front). Whatever the step then does with that exit code — swallow it
 * or propagate it — is measured, not guessed.
 */
function observeSyncStepUnderCrash(src: string = wf): {
  stepExit: number;
  outputs: Record<string, string>;
  stdio: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "fix-drift-crash-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npx"),
      "#!/bin/sh\necho 'drift-sync fatal error: fetch failed' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const outFile = join(dir, "github_output");
    writeFileSync(outFile, "");
    const script = join(dir, "step.sh");
    writeFileSync(script, runOf(stepById("sync", src)));
    const res = spawnSync("/bin/bash", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SYNC_LOG: join(dir, "drift-sync.log"),
        GITHUB_OUTPUT: outFile,
        RUNNER_TEMP: dir,
      },
    });
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(outFile, "utf-8").split("\n")) {
      const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
      if (m) outputs[m[1]] = m[2];
    }
    return {
      stepExit: res.status ?? -1,
      outputs,
      stdio: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("fix-drift.yml — the workflow parses (every guard below depends on it)", () => {
  it("parses as YAML and exposes the sync job's steps", () => {
    expect(parsed.error, `fix-drift.yml did not parse: ${parsed.error}`).toBeNull();
    expect(steps().length).toBeGreaterThan(10);
    // Order-independent handles the guards below rely on.
    for (const id of ["app-token", "gitcfg", "sync", "assert", "pr", "needs_human_pr"]) {
      expect(() => stepById(id), `no unique step with id: ${id}`).not.toThrow();
    }
  });
});

describe("fix-drift.yml — the LLM freewriter + anti-cheat predicate are GONE", () => {
  it("never references the deleted invokeClaudeCode / Claude Code CLI spawn", () => {
    expect(wf).not.toMatch(/invokeClaudeCode/i);
    expect(wf).not.toMatch(/@anthropic-ai\/claude-code/);
    expect(wf).not.toContain("Claude Code");
  });

  it("never references the deleted drift-success-predicate.ts", () => {
    expect(wf).not.toContain("drift-success-predicate");
  });

  it("never invokes the deleted scripts/fix-drift.ts", () => {
    expect(wf).not.toMatch(/scripts\/fix-drift\.ts/);
  });

  it("has no step named 'Auto-fix drift' or 'Assert drift truly resolved' (the old predicate-era step names)", () => {
    const names = steps().map((s) => s.name);
    expect(names).not.toContain("Auto-fix drift");
    expect(names).not.toContain("Assert drift truly resolved");
  });

  it("carries no now-unused agent/predicate-only secrets or env beyond the legitimate provider keys", () => {
    // ANTHROPIC_API_KEY legitimately remains — drift-sync.ts uses it to list
    // live Anthropic models, and the collector's Anthropic drift leg uses it
    // too. Neither is the deleted agent invocation.
    const env = Object.keys(stepById("sync").env ?? {});
    expect(env).toContain("ANTHROPIC_API_KEY");
    expect(wf).not.toMatch(/claude-code-output/);
  });
});

// ---------------------------------------------------------------------------
// FF2 (dead-permission trim): the `sync` job's `permissions:` block (and the
// app-token mint step) granted `checks: read` / `statuses: read`
// (`permission-checks` / `permission-statuses`) with a comment claiming they
// let "the merge gate assert the PR is truly green before merging". No step
// in this workflow ever queries check-runs or commit statuses (there is no
// `gh api .../check-runs`, no `gh pr checks`, no status lookup anywhere —
// the workflow explicitly does NO auto-merge; see the NO-AUTO-MERGE block
// below), so both the permissions and the stale comment are dead and must be
// removed.
//
// Read from the JOB's own `permissions:` node. The old guard sliced from the
// first `indexOf("permissions:")`, which is the WORKFLOW-level block (`contents:
// read`, ~line 29) — never the sync job's (~line 52). It passed by coincidence.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — FF2: dead checks/statuses permissions are removed", () => {
  const jobPermissions = (): Record<string, YNode> => {
    const perms = syncJob().permissions;
    expect(perms && typeof perms === "object" && !Array.isArray(perms)).toBe(true);
    return perms as Record<string, YNode>;
  };

  it("the sync JOB's own permissions grant NO scope beyond contents + pull-requests", () => {
    // An allowlist, not an exact pin. Least privilege must be free to get
    // TIGHTER — the job may drop a write, or drop a scope entirely, since every
    // write here goes through the minted app token rather than GITHUB_TOKEN —
    // but it must never get WIDER. An exact pin blocks the correct direction:
    // it reds on `contents: read`, which is strictly safer than what it pinned.
    const perms = jobPermissions();
    const allowed = ["contents", "pull-requests"];
    for (const [scope, level] of Object.entries(perms)) {
      expect(
        allowed,
        `the sync job grants an unexpected scope \`${scope}: ${String(level)}\``,
      ).toContain(scope);
      expect(["read", "write"]).toContain(String(level));
    }
    expect(Object.keys(perms).length).toBeGreaterThan(0);
  });

  it("nothing in the job relies on GITHUB_TOKEN — the premise the allowlist rests on", () => {
    // The allowlist above deliberately admits `contents: write` again, so that a
    // tightening is never blocked. That leaves the PREMISE unguarded: the reason
    // the job can run on `contents: read` at all is that it never uses
    // GITHUB_TOKEN. Checked here directly, so a step that quietly starts
    // depending on the ambient token reds rather than silently re-earning the
    // write grant.
    expect(codeSurface(wf)).not.toMatch(/GITHUB_TOKEN|github\.token/);
    // `shellInvocations`, not a bare /\bgh\b/ scan: the gate-failure alert's
    // FAILING_STEP strings NAME the commands that could have failed ("push
    // rejected, gh pr create error, …"), and prose about `gh` is not a call to it.
    let ghSteps = 0;
    for (const step of steps()) {
      if (shellInvocations(runOf(step), "gh ").length === 0) continue;
      ghSteps++;
      expect(step.env?.GH_TOKEN, `step "${step.name}" runs \`gh\` without an app GH_TOKEN`).toBe(
        "${{ steps.app-token.outputs.token }}",
      );
    }
    expect(ghSteps, "no step invokes `gh` at all — this guard would pass vacuously").toBe(2);
    // The push authenticates through the app token too, not the checkout's
    // ambient credential (which `persist-credentials: false` withholds anyway).
    expect(stepByName("Configure git for push").env?.TOKEN).toBe(
      "${{ steps.app-token.outputs.token }}",
    );
    expect(stepById("app-token").with?.["permission-contents"]).toBe("write");
  });

  it("the sync job's permissions block does not grant checks: read", () => {
    expect(Object.keys(jobPermissions())).not.toContain("checks");
  });

  it("the sync job's permissions block does not grant statuses: read", () => {
    expect(Object.keys(jobPermissions())).not.toContain("statuses");
  });

  it("the app-token mint step does not request permission-checks or permission-statuses", () => {
    const withBlock = Object.keys(stepById("app-token").with ?? {});
    expect(withBlock).not.toContain("permission-checks");
    expect(withBlock).not.toContain("permission-statuses");
    expect(withBlock).toContain("permission-contents");
  });

  it("no step actually consumes check-runs or commit statuses (confirms the perms were dead, not just unlabeled)", () => {
    // Scoped to the CODE surface, so the workflow may still DOCUMENT why these
    // permissions were dead — the old whole-file `/\bstatuses\b/` ban forbade
    // even writing down the rationale.
    const code = codeSurface(wf);
    expect(code).not.toMatch(/check-runs/);
    expect(code).not.toMatch(/gh pr checks/);
    expect(code).not.toMatch(/\bstatuses\b/);
  });
});

describe("fix-drift.yml — triggers on workflow_dispatch and a SCHEDULED cron", () => {
  it("triggers on workflow_dispatch", () => {
    expect(triggersOf(wf).names).toContain("workflow_dispatch");
  });

  it("has a schedule/cron trigger, independent of the drift-failure gate", () => {
    const on = docOf(wf)["on"] as Record<string, YNode>;
    const schedule = on.schedule;
    expect(Array.isArray(schedule)).toBe(true);
    expect((schedule as YNode[]).length).toBeGreaterThan(0);
    for (const entry of schedule as YNode[]) {
      expect(entry && typeof entry === "object" && "cron" in entry).toBe(true);
    }
  });

  it("the job runs on workflow_dispatch OR the schedule", () => {
    const gate = String(syncJob().if);
    for (const ev of ["workflow_dispatch", "schedule"]) {
      expect(
        evaluateIf(gate, { event_name: ev, jobFailed: false, steps: {} }),
        `the sync job's \`if:\` does not admit github.event_name == '${ev}'`,
      ).toBe(true);
    }
    // ...and NOT on some unrelated event that happens to be declared later.
    expect(evaluateIf(gate, { event_name: "push", jobFailed: false, steps: {} })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DOUBLE-FIRE GUARD. This workflow declared BOTH a `schedule` cron AND
// `workflow_run: ["Drift Tests"]`, and admitted the latter whenever the
// upstream run concluded `failure`. While Drift Tests was green the
// workflow_run leg resolved `skipped`, so the duplication was invisible; the
// moment Drift Tests went red (2026-07-29) EVERY day produced TWO Fix Drift
// runs — one `workflow_run` and one `schedule` — each doing the identical
// work and each firing its own Slack alert. `concurrency: drift-fix`
// serialises the two runs but does NOT dedupe them.
//
// The workflow_run leg bought nothing: test-drift.yml's only main-branch
// trigger is its own 6:00 cron and Fix Drift's cron is 6:10, so the leg's
// entire contribution was ~9 minutes of latency on a daily unattended job.
//
// The guard below reads the PARSED `on:` node, so re-adding a `workflow_run`
// leg on "Drift Tests" fails this suite in ANY spelling. Its predecessor
// matched only `^ {4}workflows:\s*\[(.*)\]$` — flow style, at exactly 4-space
// indent — and stayed GREEN when the leg came back as a block sequence, which
// is how a human would most plausibly hand-write it. The FALSIFIABILITY table
// below is the canary for that: it re-adds the leg in every spelling and
// asserts the guard notices each one.
// ---------------------------------------------------------------------------
const TRIGGER_FIXTURE_TAIL = `
concurrency:
  group: drift-fix

jobs:
  sync:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

/** `on:` blocks that ALL re-introduce the double-fire workflow_run leg. */
const DOUBLE_FIRE_SPELLINGS: Array<{ label: string; on: string }> = [
  {
    label: "flow sequence, unquoted",
    on: `on:\n  workflow_dispatch:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    workflows: [Drift Tests]\n    types: [completed]\n`,
  },
  {
    label: "flow sequence, double-quoted",
    on: `on:\n  workflow_dispatch:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    workflows: ["Drift Tests"]\n    types: [completed]\n`,
  },
  {
    label: "flow sequence, single-quoted",
    on: `on:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    workflows: ['Drift Tests']\n    types: [completed]\n`,
  },
  {
    label: "block sequence, more-indented",
    on: `on:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    workflows:\n      - Drift Tests\n    types:\n      - completed\n`,
  },
  {
    label: "block sequence, SAME indent as its key",
    on: `on:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    workflows:\n    - Drift Tests\n    types:\n    - completed\n`,
  },
  {
    label: "block sequence, quoted entry + interleaved comment",
    on: `on:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    # re-added by hand\n    workflows:\n      - "Drift Tests"\n    types: [completed]\n`,
  },
  {
    label: "flow mapping for the whole workflow_run node",
    on: `on:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run: { workflows: [Drift Tests], types: [completed] }\n`,
  },
  {
    label: "types declared BEFORE workflows",
    on: `on:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    types: [completed]\n    workflows: [Drift Tests]\n`,
  },
  {
    label: "several upstream workflows, Drift Tests among them",
    on: `on:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    workflows: [Some Other, Drift Tests]\n    types: [completed]\n`,
  },
  {
    label: "4-space indentation throughout",
    on: `on:\n    schedule:\n        - cron: "10 6 * * *"\n    workflow_run:\n        workflows:\n            - Drift Tests\n        types:\n            - completed\n`,
  },
  {
    label: "scalar (non-list) workflows value",
    on: `on:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    workflows: Drift Tests\n    types: [completed]\n`,
  },
  {
    label: "quoted `on` key (the YAML-1.1 boolean-coercion idiom)",
    on: `"on":\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    workflows: [Drift Tests]\n    types: [completed]\n`,
  },
];

/** `on:` blocks that must NOT be flagged — the negative controls. */
const SINGLE_FIRE_SPELLINGS: Array<{ label: string; on: string }> = [
  {
    label: "dispatch + cron only (what the workflow ships)",
    on: `on:\n  workflow_dispatch:\n  schedule:\n    - cron: "10 6 * * *"\n`,
  },
  {
    label: "workflow_run on a DIFFERENT upstream workflow",
    on: `on:\n  schedule:\n    - cron: "10 6 * * *"\n  workflow_run:\n    workflows:\n      - Some Other Workflow\n    types: [completed]\n`,
  },
  {
    label: "workflow_run on Drift Tests with NO cron (one trigger, no duplication)",
    on: `on:\n  workflow_dispatch:\n  workflow_run:\n    workflows:\n      - Drift Tests\n    types: [completed]\n`,
  },
];

describe("fix-drift.yml — at most ONE trigger can fire per Drift Tests failure", () => {
  it("AT MOST ONE declared trigger fires when 'Drift Tests' concludes failure", () => {
    // Triggers that fire on the day/run in which "Drift Tests" goes red:
    //   - schedule                     — the 6:10 cron fires that morning anyway.
    //   - workflow_run(["Drift Tests"]) — fires on that very run's completion.
    // workflow_dispatch is manual and never self-fires, so it does not count.
    expect(
      firesOnDriftFailure(wf),
      "two triggers both fire on a Drift Tests failure — that is two identical " +
        "Fix Drift runs and two Slack alerts every red day",
    ).toHaveLength(1);
  });

  // THE CANARY. Its predecessor asserted only that the trigger block "parses",
  // and it could not fail: the parse ran at COLLECTION time, so a broken parse
  // aborted the module instead of failing the canary — and a parse that
  // SUCCEEDED while being blind to a whole YAML spelling was indistinguishable
  // from a correct one. This asserts the property that actually matters: the
  // guard above must notice the double-fire leg however it is written.
  describe("the double-fire guard is FALSIFIABLE (it notices a re-added workflow_run leg in every spelling)", () => {
    for (const { label, on } of DOUBLE_FIRE_SPELLINGS) {
      it(`flags a re-added workflow_run leg written as: ${label}`, () => {
        const fixture = on + TRIGGER_FIXTURE_TAIL;
        expect(triggersOf(fixture).workflowRunWorkflows).toContain("Drift Tests");
        expect(
          firesOnDriftFailure(fixture),
          `the double-fire guard is BLIND to this spelling — re-adding the ` +
            `workflow_run leg as "${label}" would keep the guard GREEN`,
        ).toHaveLength(2);
      });
    }

    for (const { label, on } of SINGLE_FIRE_SPELLINGS) {
      it(`does NOT flag: ${label}`, () => {
        expect(firesOnDriftFailure(on + TRIGGER_FIXTURE_TAIL)).toHaveLength(1);
      });
    }
  });

  it("the job `if:` has no dead leg gated on an undeclared event", () => {
    const gate = String(syncJob().if);
    const names = triggersOf(wf).names;

    // Every `github.event_name == 'X'` leg must name a DECLARED trigger,
    // otherwise it is unreachable.
    const compared = [...gate.matchAll(/github\.event_name == '([a-z_]+)'/g)].map((m) => m[1]);
    expect(compared.length).toBeGreaterThan(0);
    for (const ev of compared) expect(names).toContain(ev);

    // `github.event.workflow_run.*` is populated ONLY under the workflow_run
    // trigger; referencing it without that trigger leaves a leg that can
    // never be satisfied (and reads as if the drift-failure gate still exists).
    if (!names.includes("workflow_run")) {
      const usesWorkflowRunContext = [gate, ...steps().map((s) => s.if ?? "")].filter((e) =>
        e.includes("github.event.workflow_run"),
      );
      expect(usesWorkflowRunContext).toEqual([]);
    }
  });
});

describe("fix-drift.yml — deterministic sync + sync-check replace the fixer + predicate", () => {
  it("runs scripts/drift-sync.ts as the remediation step", () => {
    expect(runOf(stepById("sync"))).toContain("npx tsx scripts/drift-sync.ts");
  });

  it("the SYNC step publishes drift-sync's reason= as its own step output", () => {
    // Scoped to the `sync` step. The old assertion matched
    // `echo "reason=${REASON}" >> "$GITHUB_OUTPUT"` anywhere in the file, which
    // the ASSERT step also contains verbatim — so deleting the sync step's
    // entire `$GITHUB_OUTPUT` block left the guard green while every
    // `steps.sync.outputs.reason` condition downstream silently went empty.
    const run = runOf(stepById("sync"));
    expect(run).toMatch(/grep '\^reason=' "\$\{SYNC_LOG\}"/);
    // The reason (and the changeset key) must actually reach $GITHUB_OUTPUT
    // from THIS step, whether written line-by-line or as a redirected block.
    for (const key of ["reason", "changeset_key", "exit_code"]) {
      const emits = shellInvocations(run, `echo "${key}=`);
      expect(emits.length, `the sync step never echoes ${key}=`).toBeGreaterThan(0);
    }
    expect(run).toContain('>> "$GITHUB_OUTPUT"');
    // Every reason= consumer downstream names this step, so the id is pinned.
    expect(stepById("sync").id).toBe("sync");
  });

  it("runs scripts/drift-sync-check.ts as a defense-in-depth re-assertion, gated on reason == 'ok-applied'", () => {
    const assert = stepById("assert");
    expect(assert.name).toBe("Assert drift-sync-check (defense-in-depth)");
    expect(runOf(assert)).toContain("npx tsx scripts/drift-sync-check.ts");
    // Evaluated, not string-matched: it must run for ok-applied and for nothing else.
    for (const reason of Object.values(SyncCoreReason)) {
      const runs = evaluateIf(assert.if!, {
        event_name: "schedule",
        jobFailed: false,
        steps: { sync: { outcome: "success", outputs: { reason } } },
      });
      expect(runs, `assert step selection is wrong for reason=${reason}`).toBe(
        reason === SyncCoreReason.OK_APPLIED,
      );
    }
  });

  it("the PR-open step is gated on reason == 'ok-applied' AND overall success, not on a verdict function", () => {
    const pr = stepById("pr");
    expect(pr.name).toBe("Push branch + create PR");
    expect(runOf(pr)).toContain("gh pr create");
    const select = (reason: string, jobFailed: boolean) =>
      evaluateIf(pr.if!, {
        event_name: "schedule",
        jobFailed,
        steps: { sync: { outcome: jobFailed ? "failure" : "success", outputs: { reason } } },
      });
    expect(select(SyncCoreReason.OK_APPLIED, false)).toBe(true);
    // An earlier failure (e.g. the assert step refusing) must NOT open a PR.
    expect(select(SyncCoreReason.OK_APPLIED, true)).toBe(false);
    for (const reason of [SyncCoreReason.NEEDS_HUMAN, SyncCoreReason.GATE_FAILED, ""]) {
      expect(select(reason, false), `PR opened for reason=${reason}`).toBe(false);
    }
  });
});

describe("fix-drift.yml — needs-human vs gate-failure are DISTINCT alerts", () => {
  const NEEDS_HUMAN_ALERT = "Alert on needs-human decision";
  const GATE_ALERT = "Alert on drift-sync-check gate failure";

  it("alerts distinctly when the sync routes to a human decision (new family / still-referenced deprecation)", () => {
    const alert = stepByName(NEEDS_HUMAN_ALERT);
    expect(
      evaluateIf(alert.if!, {
        event_name: "schedule",
        jobFailed: false,
        steps: {
          sync: { outcome: "success", outputs: { reason: SyncCoreReason.NEEDS_HUMAN } },
          needs_human_pr: { outcome: "success", outputs: { url: "u", number: "1" } },
        },
      }),
    ).toBe(true);
  });

  it("alerts distinctly (and separately) when drift-sync-check refuses the gate — a tooling fault, not a product decision", () => {
    const alert = stepByName(GATE_ALERT);
    expect(
      evaluateIf(alert.if!, {
        event_name: "schedule",
        jobFailed: true,
        steps: { sync: { outcome: "success", outputs: { reason: SyncCoreReason.GATE_FAILED } } },
      }),
    ).toBe(true);
  });

  it("the two alerts never DOUBLE-fire on the same run", () => {
    // A needs-human run whose persist step failed is a tooling fault: the gate
    // alert owns it and the needs-human alert must stand down.
    const ctx: EvalCtx = {
      event_name: "schedule",
      jobFailed: true,
      steps: {
        sync: { outcome: "success", outputs: { reason: SyncCoreReason.NEEDS_HUMAN } },
        needs_human_pr: { outcome: "failure", outputs: {} },
      },
    };
    expect(evaluateIf(stepByName(GATE_ALERT).if!, ctx)).toBe(true);
    expect(evaluateIf(stepByName(NEEDS_HUMAN_ALERT).if!, ctx)).toBe(false);
  });

  it("both needs-human and gate-failure alerts fail the job (non-green), so a human sees it in CI status too", () => {
    for (const name of [NEEDS_HUMAN_ALERT, GATE_ALERT]) {
      expect(runOf(stepByName(name)), `${name} does not exit non-zero`).toMatch(/\n\s*exit 1\b/);
    }
  });

  it("re-fires never spam a duplicate PR for an already-proposed family: BOTH PR-open paths skip before pushing", () => {
    // Behaviour, not prose. The old assertion was `toContain("no PR spam")` — an
    // English phrase in a YAML comment. It stayed green with every line of dedup
    // logic deleted. What must actually hold is that each PR-open step consults
    // the open PRs and can return WITHOUT pushing.
    for (const id of ["pr", "needs_human_pr"]) {
      const run = runOf(stepById(id));
      const lookups = shellInvocations(run, "gh pr list");
      expect(lookups.length, `step ${id} never lists open PRs`).toBeGreaterThan(0);
      const lines = run.split("\n");
      const firstLookup = lines.findIndex((l) => l.includes("gh pr list"));
      const firstPush = lines.findIndex((l) => /\bgit push\b/.test(l));
      const skipExit = lines.findIndex((l, idx) => /^\s*exit 0\s*$/.test(l) && idx > firstLookup);
      expect(firstPush, `step ${id} never pushes`).toBeGreaterThan(-1);
      expect(firstLookup, `step ${id} looks up open PRs only AFTER pushing`).toBeLessThan(
        firstPush,
      );
      expect(skipExit, `step ${id} has no dedup early-return before its push`).toBeGreaterThan(-1);
      expect(skipExit, `step ${id}'s dedup early-return is AFTER its push`).toBeLessThan(firstPush);
      // ...and the skip is keyed on something found in the open-PR list.
      expect(run).toContain("not opening a duplicate");
    }
  });
});

// ---------------------------------------------------------------------------
// Human-approval backstop — preserved verbatim from the pre-C3 workflow.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — human-approval backstop: no unattended auto-merge", () => {
  it("has NO auto-merge step and never runs `gh pr merge`", () => {
    expect(steps().map((s) => s.name)).not.toContain("Auto-merge PR");
    expect(codeSurface(wf)).not.toMatch(/gh pr merge/);
  });

  it("documents WHY the drift-sync path is human-gated (drift-sync-check is a filter, not a merge gate)", () => {
    expect(wf).toContain("NO AUTO-MERGE");
    expect(wfFlat).toMatch(/AUTO-FILTER, NOT a provable merge (# )?gate/i);
  });

  it("the success Slack message says the PR needs human review + merge, NOT merged to main", () => {
    // EVERY message the step can build, not just the first: a step may
    // legitimately distinguish "PR just opened" from "PR still open and
    // unmerged", and each variant has to keep the promise.
    const msgs = assembleSlackMessages(stepByName("Notify Slack on sync success"));
    expect(msgs.length).toBeGreaterThan(0);
    for (const msg of msgs) {
      expect(msg, "a success message claims the change reached main").not.toContain(
        "merged to main",
      );
      expect(msg, "a success message does not say a human must still merge").toContain(
        "needs human review + merge",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Early-infra catch-all — preserved (adapted to the new step id `sync`).
// ---------------------------------------------------------------------------
describe("fix-drift.yml — early-infra catch-all failure alert", () => {
  const CATCH_ALL = "Alert on early-infra failure (catch-all)";

  it("has an end-of-job catch-all alert step", () => {
    expect(() => stepByName(CATCH_ALL)).not.toThrow();
  });

  it("the catch-all covers the early-infra window and stays quiet on a green run", () => {
    // Simulated over the whole step list in order, because the catch-all's
    // condition depends on what the runner already decided about the steps
    // before it. A setup step failing is the window it exists for.
    expect(
      simulateJob({ failing: ["Clone ag-ui repo"] }).alerts,
      "an infra/setup failure before the sync step does not reach the catch-all",
    ).toContain(CATCH_ALL);
    // A fully green run must not alert at all.
    expect(
      simulateJob({ outputs: { sync: { reason: SyncCoreReason.OK_NO_CHURN, exit_code: "0" } } })
        .alerts,
    ).not.toContain(CATCH_ALL);
    // ...and it never double-fires alongside a specific alert — see the
    // "every outcome reaches a human EXACTLY once" table below.
  });

  it("distinguishes an INFRA/SETUP failure from a sync-gate failure in its message", () => {
    const run = runOf(stepByName(CATCH_ALL));
    expect(run).toMatch(/INFRA\/SETUP failure/);
    expect(run).toContain("SLACK_WEBHOOK is not set");
    expect(run).toMatch(/::error::/);
  });
});

// ---------------------------------------------------------------------------
// F#1 (mandatory): the "Push branch + create PR" step can itself fail (branch
// push rejected, `gh pr create` error, or the head-SHA PR-match polling loop
// exhausting its attempts) AFTER the defense-in-depth Assert step already
// SUCCEEDED. In that window: reason stays 'ok-applied', steps.assert.outcome
// stays 'success', and reason is non-empty — so none of needs-human,
// gate-failure (assert.outcome-only check), or the early-infra catch-all
// (reason=='') fire. The job goes red with ZERO Slack signal on an unattended
// daily cron. The gate-failure alert must widen to also catch this window.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — gate-failure alert also covers a later step failing after an ok-applied sync + successful assert", () => {
  const GATE_ALERT = "Alert on drift-sync-check gate failure";

  it("a Push/PR-create failure AFTER a successful assert still raises an alert", () => {
    // The exact F#1 window, evaluated rather than pattern-matched: reason is
    // 'ok-applied' (so the catch-all stands down) and assert SUCCEEDED (so an
    // `assert.outcome == 'failure'` check stands down too).
    const ctx: EvalCtx = {
      event_name: "schedule",
      jobFailed: true,
      steps: {
        sync: { outcome: "success", outputs: { reason: SyncCoreReason.OK_APPLIED } },
        assert: { outcome: "success", outputs: {} },
        pr: { outcome: "failure", outputs: {} },
      },
    };
    const fired = selectedSteps(ctx).filter(isAlertStep);
    expect(
      fired.map((s) => s.name),
      "an ok-applied run whose Push/PR step fails after a SUCCESSFUL assert " +
        "produces no alert at all — a silent failure on an unattended daily cron",
    ).toContain(GATE_ALERT);
  });

  it("the gate-failure alert message names which step actually failed", () => {
    const step = stepByName(GATE_ALERT);
    // Every outcome the message branches on must be wired in as env, and the
    // body must actually branch on it — otherwise the alert is generic.
    const env = step.env ?? {};
    const run = runOf(step);
    for (const [envKey, stepId] of [
      ["ASSERT_OUTCOME", "assert"],
      ["PR_OUTCOME", "pr"],
      ["NEEDS_HUMAN_PR_OUTCOME", "needs_human_pr"],
    ] as const) {
      expect(env[envKey], `${GATE_ALERT} does not wire in ${envKey}`).toBe(
        `\${{ steps.${stepId}.outcome }}`,
      );
      expect(run, `${GATE_ALERT} never branches on ${envKey}`).toContain(`"\${${envKey}}"`);
    }
    expect(run).toContain("FAILING_STEP=");
    expect(run).toContain("failing step: ${FAILING_STEP}");
  });
});

// ---------------------------------------------------------------------------
// G#2 (mandatory): a needs-human run WRITES a `drift-proposals/` note (the
// Bucket-B human touchpoint) into CI's working tree, but the workflow only ever
// pushed a branch + opened a PR on reason == 'ok-applied'. On a needs-human run
// the registry is unchanged, so NOTHING was pushed — the note was discarded
// with the runner. The self-service human-decision path (human sets
// `Decision: include`, the NEXT run reads the approved note and applies it) was
// therefore unreachable: the note never landed in the repo. The workflow must
// persist the note on needs-human by pushing a branch + opening a (distinct,
// never auto-merged) PR.
//
// Every guard below addresses the persist step BY ITS ID. The old suite found it
// with `stepBlocks().find(b => b.includes("...reason == 'needs-human'") &&
// b.includes("gh pr create"))` — a predicate that matches THREE blocks in this
// file (the persist step, and both alert steps quote that condition in their
// prose), so it resolved to the right one only because the persist step happens
// to come FIRST in the document. Re-ordering the steps silently re-pointed every
// one of these assertions at an alert step.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — needs-human notes are PERSISTED (pushed + PR'd), not discarded", () => {
  const persist = () => stepById("needs_human_pr");

  it("a needs-human run pushes a branch AND opens a PR (so the note reaches the repo)", () => {
    const step = persist();
    expect(step.name).toBe("Persist needs-human note + open PR");
    expect(runOf(step)).toMatch(/git push\b/);
    expect(runOf(step)).toContain("gh pr create");
    // ...and it is selected on exactly the needs-human outcome.
    for (const reason of Object.values(SyncCoreReason)) {
      expect(
        evaluateIf(step.if!, {
          event_name: "schedule",
          jobFailed: false,
          steps: { sync: { outcome: "success", outputs: { reason } } },
        }),
        `persist step selection is wrong for reason=${reason}`,
      ).toBe(reason === SyncCoreReason.NEEDS_HUMAN);
    }
  });

  it("the needs-human persist step uses a DISTINCT branch (not colliding with the ok-applied fix/drift-* branch)", () => {
    // A dedicated needs-human branch prefix keeps the two PR classes separate.
    expect(runOf(persist())).toMatch(/BRANCH="drift-needs-human\//);
    expect(runOf(stepById("gitcfg"))).toMatch(/git checkout -B "fix\/drift-/);
  });

  it("the needs-human persist step de-dups: it skips opening a second PR when one is already open for the same note", () => {
    expect(runOf(persist())).toContain("gh pr list");
  });

  it("the needs-human persist step's PR body tells a human to set Decision: include and merge (closing the two-run loop), never auto-merged", () => {
    const run = runOf(persist());
    expect(run).toContain("Decision: include");
    // No `gh pr merge` anywhere (asserted globally too) — human merges.
    expect(run).not.toMatch(/gh pr merge/);
  });

  it("the needs-human persist step's OWN failure is alerted (gate-failure alert references its outcome)", () => {
    const gateAlert = stepByName("Alert on drift-sync-check gate failure");
    expect(gateAlert.env?.NEEDS_HUMAN_PR_OUTCOME).toBe("${{ steps.needs_human_pr.outcome }}");
    expect(
      evaluateIf(gateAlert.if!, {
        event_name: "schedule",
        jobFailed: true,
        steps: {
          sync: { outcome: "success", outputs: { reason: SyncCoreReason.NEEDS_HUMAN } },
          needs_human_pr: { outcome: "failure", outputs: {} },
        },
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G#3 (mandatory): the needs-human persist step's de-dup was keyed SOLELY on
// the committed `drift-proposals/*` note paths. In the D-M1 "mixed run" (a
// mechanical registry edit committed the SAME run a *different* family is
// deferred to a human, whose note already sits on main), the committed diff is
// ONLY the registry edit and NO new note file — so the note-path list is
// EMPTY, the per-note dedup for-loop runs zero times, and the step falls
// straight through to an unconditional `git push` + `gh pr create`. Because the
// edit is never auto-merged and the unrelated deprecation is re-detected every
// daily cron run, this opens a brand-new near-identical PR every single day
// (unbounded PR-spam). Both PR-open paths must instead de-dup on a STABLE,
// date-independent changeset key that exists for EVERY committed changeset.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — G#3: PR-open paths de-dup on a STABLE changeset key (idempotent in EVERY run shape, incl. the mixed run with NO new note file)", () => {
  it("the sync step emits a stable changeset_key step output (grepped from drift-sync.ts's changeset-key= line)", () => {
    const run = runOf(stepById("sync"));
    expect(run).toMatch(/grep '\^changeset-key=' "\$\{SYNC_LOG\}"/);
    expect(run).toContain('echo "changeset_key=${CHANGESET_KEY}"');
    expect(run).toContain('>> "$GITHUB_OUTPUT"');
    // drift-sync.ts must actually print the line the grep above depends on.
    const syncSrc = readFileSync(resolve(__dirname, "../../scripts/drift-sync.ts"), "utf-8");
    expect(syncSrc).toContain("changeset-key=");
  });

  it("the needs-human persist step's PRIMARY de-dup is keyed on the changeset key and runs BEFORE the note-file scan (so it fires even when the committed diff carries NO drift-proposals/* note)", () => {
    const step = stepById("needs_human_pr");
    expect(step.env?.CHANGESET_KEY).toBe("${{ steps.sync.outputs.changeset_key }}");
    const run = runOf(step);
    expect(run).toContain("drift-changeset: ${CHANGESET_KEY}");
    // CRITICAL: the changeset-key dedup guard must appear BEFORE the
    // `mapfile ... NOTES` scan. Pre-fix, the ONLY dedup lived inside the
    // per-note for-loop, reachable only when a note file was in the diff —
    // exactly what the empty-NOTES mixed run bypasses.
    const guardIdx = run.indexOf("drift-changeset: ${CHANGESET_KEY}");
    const mapfileIdx = run.indexOf("mapfile -t COMMITTED");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(mapfileIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mapfileIdx);
  });

  it("the ok-applied Push+PR step ALSO de-dups on the changeset key (a never-auto-merged applied edit deserves exactly ONE open PR, re-findable across daily re-fires)", () => {
    const step = stepById("pr");
    expect(step.env?.CHANGESET_KEY).toBe("${{ steps.sync.outputs.changeset_key }}");
    const run = runOf(step);
    expect(run).toContain("drift-changeset: ${CHANGESET_KEY}");
    expect(run).toContain("gh pr list");
    // The dedup skip must precede the push (skip a duplicate BEFORE pushing).
    const guardIdx = run.indexOf("not opening a duplicate");
    const pushIdx = run.indexOf("git push -u origin");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(pushIdx);
  });

  it("the needs-human persist step RETAINS the per-note body marker as a secondary guard (note-path de-dup not regressed)", () => {
    expect(runOf(stepById("needs_human_pr"))).toContain("drift-proposal-note: ${note}");
  });

  it("BOTH PR bodies embed the stable drift-changeset marker the dedup guards match on", () => {
    for (const id of ["pr", "needs_human_pr"]) {
      expect(
        runOf(stepById(id)),
        `step ${id}'s PR body omits the drift-changeset dedup marker`,
      ).toContain("<!-- drift-changeset: ${CHANGESET_KEY} -->");
    }
  });
});

// ---------------------------------------------------------------------------
// F#2 / G#2 (should-fix): DRIFT.md (and the workflow's own PR-body fallback
// text) claim a `drift-sync-check-log` artifact exists, but historically the
// workflow only uploaded `drift-sync-log`. Assert the claim matches reality.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — drift-sync-check-log artifact matches DRIFT.md's claim", () => {
  /** The upload-artifact steps, keyed by the artifact `name:` they publish. */
  const uploads = (): Record<string, Record<string, YNode>> => {
    const out: Record<string, Record<string, YNode>> = {};
    for (const s of steps()) {
      if (!s.uses?.startsWith("actions/upload-artifact")) continue;
      const w = (s.with ?? {}) as Record<string, YNode>;
      out[String(w.name)] = w;
    }
    return out;
  };

  it("DRIFT.md claims a drift-sync-check-log artifact exists", () => {
    const driftMd = readFileSync(resolve(__dirname, "../../DRIFT.md"), "utf-8");
    expect(driftMd).toContain("drift-sync-check-log");
  });

  it("the workflow actually uploads a drift-sync-check-log artifact (matching the drift-sync-log sibling's retention)", () => {
    const byName = uploads();
    expect(Object.keys(byName).sort()).toEqual(["drift-sync-check-log", "drift-sync-log"]);
    // Scoped per artifact. The old guard asserted a bare `retention-days: 30`
    // ANYWHERE in the file, which the drift-sync-log sibling already satisfied —
    // so the drift-sync-check-log upload could carry any retention (or none)
    // and the guard stayed green.
    expect(byName["drift-sync-check-log"].path).toBe("${{ runner.temp }}/drift-sync-check.log");
    expect(byName["drift-sync-check-log"]["retention-days"]).toBe(30);
    expect(byName["drift-sync-log"]["retention-days"]).toBe(30);
    // The paths must be the logs the two steps actually write.
    expect(stepById("sync").env?.SYNC_LOG).toBe("${{ runner.temp }}/drift-sync.log");
    expect(stepById("assert").env?.ASSERT_LOG).toBe("${{ runner.temp }}/drift-sync-check.log");
  });

  it("both logs upload on `always()`, so a failing run still leaves evidence", () => {
    for (const s of steps()) {
      if (!s.uses?.startsWith("actions/upload-artifact")) continue;
      expect(s.if, `${s.name} does not upload unconditionally`).toBe("always()");
    }
  });
});

// ---------------------------------------------------------------------------
// ALERT CONTENT: every exit path of the needs-human persist step must carry a
// PR reference into the Slack alert.
//
// `PR_URL` for the "Alert on needs-human decision" step comes from
// `steps.needs_human_pr.outputs.url`, which used to be written ONLY at the very
// end of the persist step, after `gh pr create`. That step has THREE early
// `exit 0` returns (no new commit; changeset-key dedup hit; per-note dedup hit)
// and none of them wrote `url=` — so the alert fell through to its contentless
// variant. The dedup path even HAD the PR number in `$DUP` and discarded it.
//
// That is why six consecutive days of "needs a human decision" alerts named no
// PR: run 30429968759 opened #343 and its alert carried the link, and every run
// after it took a dedup path and went contentless.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — the needs-human alert always names a PR", () => {
  const persistRun = () => runOf(stepById("needs_human_pr"));

  it("EVERY early return in the persist step emits the PR immediately before exiting", () => {
    const lines = persistRun().split("\n");
    const exits = lines.flatMap((l, i) => (/^\s*exit 0\s*$/.test(l) ? [i] : []));
    expect(exits.length, "expected the documented early-return paths").toBeGreaterThanOrEqual(3);

    for (const i of exits) {
      // The whole ENCLOSING GUARD BODY, not a fixed 3-line lookback: a compound
      // guard, an interleaved comment, or a multi-line message would push
      // `emit_pr` out of a 3-line window and the guard would pass anyway.
      const body = enclosingGuardBody(lines, i);
      expect(
        body,
        `\`exit 0\` at line ${i + 1} of the persist step returns without emit_pr — ` +
          "the Slack alert is then left with no PR to name",
      ).toMatch(/emit_pr "/);
    }
  });

  it("the PR lookup is hoisted ABOVE the no-new-commit guard, so that path can name a PR too", () => {
    const run = persistRun();
    const lookupIdx = run.indexOf("gh pr list");
    const noNewCommitIdx = run.indexOf('if [ "$HEAD_SHA" = "$BASE_SHA" ]');
    expect(lookupIdx).toBeGreaterThan(-1);
    expect(noNewCommitIdx).toBeGreaterThan(-1);
    expect(lookupIdx).toBeLessThan(noNewCommitIdx);
  });

  it("the persist step exports a PR number alongside the url so the alert can say #N", () => {
    const run = persistRun();
    expect(run).toMatch(/echo "number=/);
    expect(run).toMatch(/echo "url=/);
    expect(run).toContain('>> "$GITHUB_OUTPUT"');
  });

  it("the alert step renders the PR number and url when it has them", () => {
    const alert = stepByName("Alert on needs-human decision");
    expect(alert.env?.PR_NUMBER).toBe("${{ steps.needs_human_pr.outputs.number }}");
    expect(alert.env?.PR_URL).toBe("${{ steps.needs_human_pr.outputs.url }}");
    const run = runOf(alert);
    expect(run).toMatch(/#\$\{PR_NUMBER/);
    expect(run).toContain("${PR_URL}");
  });

  it("the alert's no-PR fallback no longer claims the note is 'already proposed in an open PR'", () => {
    // With the lookup hoisted, an already-proposed note ALWAYS yields a url —
    // so reaching the fallback means the opposite of what it used to claim.
    expect(runOf(stepByName("Alert on needs-human decision"))).not.toContain(
      "already proposed in an open PR",
    );
  });

  it("every `gh pr list` in the workflow passes an explicit --limit", () => {
    // `gh pr list` defaults to 30. Once 30 newer PRs exist, an older
    // already-proposed PR falls out of the window, the dedup guards miss it,
    // and the workflow opens a duplicate.
    //
    // Flag-ORDER independent, and independent of `--json`: the old guard used
    // /gh pr list[^|]*?--json [a-zA-Z,]+/, which examined only invocations whose
    // `--json` preceded any `|` — so reordering the flags, or dropping `--json`
    // entirely, exempted the call from the limit requirement altogether.
    const calls = steps().flatMap((s) => shellInvocations(runOf(s), "gh pr list"));
    expect(calls.length, "no `gh pr list` invocations found at all").toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call, `\`gh pr list\` without an explicit --limit: ${call}`).toMatch(/--limit \d+/);
    }
  });
});

// ---------------------------------------------------------------------------
// ALERT REACHABILITY. The single invariant this workflow exists to uphold: on an
// unattended daily cron, EVERY outcome the sync can reach tells a human exactly
// once — no silent conclusion, and no two alerts for one event.
//
// Evaluated over the whole step list in ORDER, because that is what the runner
// does and because the conditions depend on it (`skipped` vs not-yet-evaluated).
// ---------------------------------------------------------------------------
describe("fix-drift.yml — every outcome reaches a human EXACTLY once", () => {
  const OK = { url: "https://example.test/pr/1", number: "1" };

  const SCENARIOS: Array<{ label: string; scenario: Scenario; expect: string[] }> = [
    {
      label: "infra/setup failure before the sync step ever runs",
      scenario: { failing: ["Clone ag-ui repo"] },
      expect: ["Alert on early-infra failure (catch-all)"],
    },
    {
      label: "drift-sync's own internal gate reverted the edit (gate-failed)",
      scenario: { outputs: { sync: { reason: SyncCoreReason.GATE_FAILED, exit_code: "1" } } },
      expect: ["Alert on drift-sync-check gate failure"],
    },
    {
      label: "ok-applied, then the defense-in-depth assert REFUSES",
      scenario: {
        failing: ["assert"],
        outputs: { sync: { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" } },
      },
      expect: ["Alert on drift-sync-check gate failure"],
    },
    {
      // F#1: the window that used to be silent — assert SUCCEEDED, a later step
      // failed, reason is non-empty so the catch-all stands down.
      label: "ok-applied, assert PASSES, then Push/PR-create fails (F#1)",
      scenario: {
        failing: ["pr"],
        outputs: { sync: { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" } },
      },
      expect: ["Alert on drift-sync-check gate failure"],
    },
    {
      label: "needs-human, note persisted fine",
      scenario: {
        outputs: {
          sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" },
          needs_human_pr: OK,
        },
      },
      expect: ["Alert on needs-human decision"],
    },
    {
      // G#2: a persist failure is a TOOLING fault, so the gate alert owns it and
      // the needs-human alert must stand down — otherwise both fire at once.
      label: "needs-human, but the persist step itself FAILS",
      scenario: {
        failing: ["needs_human_pr"],
        outputs: { sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" } },
      },
      expect: ["Alert on drift-sync-check gate failure"],
    },
    {
      // The window a `reason == ''` catch-all leaves open. Nothing drifted, so
      // no reason-keyed alert exists — but the job can still fail (an artifact
      // upload, a runner hiccup) with a NON-empty reason, and then a catch-all
      // keyed on an empty reason stands down and nobody is told anything.
      label: "ok-no-churn, then a later step fails (non-empty reason, no reason-keyed alert)",
      scenario: {
        failing: ["Upload drift-sync-check log"],
        outputs: { sync: { reason: SyncCoreReason.OK_NO_CHURN, exit_code: "0" } },
      },
      expect: ["Alert on early-infra failure (catch-all)"],
    },
    {
      label: "ok-applied all the way through — the success notification, not an alert",
      scenario: {
        outputs: { sync: { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" }, pr: OK },
      },
      expect: ["Notify Slack on sync success"],
    },
  ];

  for (const { label, scenario, expect: wanted } of SCENARIOS) {
    it(`${label} -> exactly: ${wanted.join(", ")}`, () => {
      expect(simulateJob(scenario).alerts).toEqual(wanted);
    });
  }

  it("no churn at all is silent (nothing happened; nothing to report)", () => {
    const sim = simulateJob({
      outputs: { sync: { reason: SyncCoreReason.OK_NO_CHURN, exit_code: "0" } },
    });
    expect(sim.jobFailed).toBe(false);
    expect(sim.alerts).toEqual([]);
  });

  it("the ok-applied dedup path (an open PR already carries the changeset) is silent, not falsely successful", () => {
    // The `pr` step exits 0 without emitting `url=`, so the success notification
    // must NOT claim a PR was opened.
    expect(
      simulateJob({ outputs: { sync: { reason: SyncCoreReason.OK_APPLIED } } }).alerts,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M1 (crash window). drift-sync.ts's fatal handler prints
// `drift-sync fatal error: …` to stderr and exits 1 BEFORE its first
// `console.log`, so a crash emits NO `reason=` line at all. The sync step wraps
// the invocation in `set +e` and captures the code into an output rather than
// re-raising it, so:
//
//   step exit 0 -> step outcome success -> job GREEN
//   reason ''   -> every reason-keyed alert `if:` false
//   failure()   -> false, so the end-of-job catch-all stays silent too
//
// Net effect on an unattended daily cron: the sync crashes and NOTHING is
// reported. Not hypothetical — an invalid GOOGLE_API_KEY makes Gemini answer
// 400, and isInfraSkip() only absorbs 401/402/403/429/5xx, so a 400 throws
// straight out through that fatal handler.
//
// The guard below does not pattern-match a fix. It EXECUTES the step's own run
// body against a crashing drift-sync (`observeSyncStepUnderCrash`), takes the
// step's real exit status and real `$GITHUB_OUTPUT` as the scenario, and then
// asks the runner's own step-selection rules whether anything would tell a
// human. Any fix that makes the crash audible satisfies it; no fix-SHAPED
// change that leaves the crash silent can.
//
// Anchored on a recorded observation of the UNFIXED workflow (F1 RED artifact,
// 2026-08-03): step exit 0, outcome success, job green, exit_code='1',
// reason='', zero alert steps selected.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — M1: a drift-sync CRASH cannot end green and silent", () => {
  it("the crash is observable in the step's captured outputs at all", () => {
    const obs = observeSyncStepUnderCrash();
    expect(obs.stdio).toContain("drift-sync fatal error");
    // drift-sync's real exit code is captured even though the step may swallow it.
    expect(obs.outputs.exit_code).toBe("1");
  });

  it("a crashing drift-sync selects at least one alert step", () => {
    const obs = observeSyncStepUnderCrash();
    const sim = simulateJob({
      failing: obs.stepExit === 0 ? [] : ["sync"],
      outputs: { sync: obs.outputs },
    });
    expect(
      sim.alerts,
      `drift-sync crashed (exit_code=${obs.outputs.exit_code}) but the sync STEP exited ` +
        `${obs.stepExit} and published reason=${JSON.stringify(obs.outputs.reason ?? "")}, so the ` +
        `job concludes ${sim.jobFailed ? "RED" : "GREEN"} with ${sim.alerts.length} alerts. ` +
        "A crash of the daily unattended sync must reach a human — either the step " +
        "propagates the non-zero exit (so the end-of-job catch-all fires) or it " +
        "publishes a reason an alert is keyed on.",
    ).not.toEqual([]);
  });

  it("the reasons that signal a PROBLEM always alert", () => {
    for (const reason of [SyncCoreReason.GATE_FAILED, SyncCoreReason.NEEDS_HUMAN]) {
      expect(
        simulateJob({ outputs: { sync: { reason, exit_code: "1" } } }).alerts,
        `reason=${reason} raises no alert`,
      ).not.toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// M2 (Slack message newlines). Each alert builds its payload as
// `MSG="…\nRun: …"` and hands it to `jq -n --arg text "$MSG"`. Inside bash
// double quotes `\n` is a LITERAL backslash followed by `n`; jq then escapes the
// backslash, so Slack receives `\\n` and renders the two characters `\n` in the
// middle of the message instead of a line break. The run link is the part that
// gets mangled, in every alert.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — Slack message bodies use REAL newlines, not a literal backslash-n", () => {
  /** Every step that POSTs a Slack payload built from a `MSG=` assignment. */
  const slackSteps = () =>
    steps().filter((s) => runOf(s).includes("SLACK_WEBHOOK") && /\bMSG=/.test(runOf(s)));

  it("all four Slack-posting steps are found (needs-human, gate-failure, success, catch-all)", () => {
    expect(slackSteps().map((s) => s.name)).toEqual([
      "Alert on needs-human decision",
      "Alert on drift-sync-check gate failure",
      "Notify Slack on sync success",
      "Alert on early-infra failure (catch-all)",
    ]);
  });

  it("each alert's ASSEMBLED message carries a real newline and no literal backslash-n", () => {
    for (const step of slackSteps()) {
      for (const msg of assembleSlackMessages(step)) {
        expect(
          msg,
          `${step.name}: the assembled message contains the two characters "\\n". Bash does ` +
            "NOT expand a backslash-n inside double quotes, and jq then escapes the " +
            "backslash, so Slack renders it literally in the middle of the alert " +
            "instead of breaking the line before the run link.",
        ).not.toMatch(/\\n/);
        expect(
          msg,
          `${step.name}: the assembled message has no newline at all — the run link is ` +
            "jammed onto the end of the prose.",
        ).toMatch(/\n/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// M3 (exhaustiveness). `steps.sync.outputs.reason` is a string on the wire, so
// nothing in TypeScript connects `SyncCoreReason` to the workflow's conditions.
// Adding a fifth member to the enum, or renaming one, silently leaves the
// workflow with a reason no step is keyed on — which is the crash window again,
// reached from the other direction.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — SyncCoreReason is pinned and fully routed", () => {
  it("the enum has exactly the four wire values the workflow knows about", () => {
    expect(Object.values(SyncCoreReason).sort()).toEqual([
      "gate-failed",
      "needs-human",
      "ok-applied",
      "ok-no-churn",
    ]);
  });

  it("every reason is ROUTED: it either drives a step or is the one silent no-op", () => {
    const conditions = [...steps().map((s) => s.if ?? "")].join("\n");
    for (const reason of Object.values(SyncCoreReason)) {
      const named = conditions.includes(`'${reason}'`);
      expect(
        named,
        `reason '${reason}' appears in no step condition — a run that reports it ` +
          "falls through every gate and every alert",
      ).toBe(reason !== SyncCoreReason.OK_NO_CHURN);
    }
  });

  it("no step is gated on a reason the enum cannot produce", () => {
    const known = new Set<string>([...Object.values(SyncCoreReason), ""]);
    const quoted = new Set<string>();
    for (const s of steps()) {
      for (const m of (s.if ?? "").matchAll(/steps\.sync\.outputs\.reason\s*[=!]=\s*'([^']*)'/g)) {
        quoted.add(m[1]);
      }
    }
    expect(quoted.size).toBeGreaterThan(0);
    // A workflow-synthesised reason (e.g. one standing in for "drift-sync
    // crashed without classifying itself") is legitimate, but it must be
    // DECLARED in the sync step's own body rather than appearing only in a
    // condition — otherwise the condition is unreachable.
    const syncRun = runOf(stepById("sync"));
    for (const reason of quoted) {
      if (known.has(reason)) continue;
      expect(
        syncRun,
        `a step is gated on reason '${reason}', which SyncCoreReason cannot produce ` +
          "and the sync step never assigns — that condition can never be satisfied",
      ).toContain(reason);
    }
  });
});
