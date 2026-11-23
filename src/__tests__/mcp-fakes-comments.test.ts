/**
 * Comment drift in the MCP fakes source: a comment that cites a section of
 * the design spec must cite one that exists, and a comment that states a
 * number (an error code, a cap, a limit, a depth, an SDK version) must state
 * the value of the constant it describes.
 *
 * Comments are read with the TypeScript parser (leading and trailing trivia of
 * every node), never with a regex lexer. The files in scope are
 * `src/mcp-fakes.ts`, `src/mcp-types.ts`, `src/echo-text.ts` and
 * `src/constants.ts` in full, and the MCP fakes parts
 * of `src/helpers.ts`, `src/types.ts` and `src/fixture-loader.ts` (the
 * top-level statements named in `MCP_STATEMENT`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { cutText } from "../echo-text.js";
import { FixtureLoadError } from "../fixture-loader.js";
import {
  MCP_FAKES_DEFAULT_MAX_TEST_IDS,
  MCP_FAKES_ECHO_LIMIT,
  MCP_FAKES_MAX_DEPTH,
  echo,
  echoText,
  firstDifference,
} from "../mcp-fakes.js";
import { MCP_FAKE_ERROR_CODES } from "../types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The numbered sections of the design spec (its `##` to `####` headings). The
 * spec is not in this repository, so the list is kept here; set
 * `AIMOCK_MCP_FAKES_SPEC` to the spec's path to check the list against it.
 */
// prettier-ignore
const SPEC_SECTIONS: readonly string[] = [
  "1", "1.1", "1.2", "1.3",
  "2", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6",
  "3",
  "4",
  "5", "5.1", "5.1.1", "5.2", "5.3", "5.4", "5.5", "5.6",
  "6", "6.1", "6.2", "6.3", "6.4", "6.5",
  "7", "7.1", "7.2", "7.3",
  "8",
  "9", "9.1", "9.2", "9.3", "9.4",
  "10",
  "11", "11.1", "11.2", "11.3",
  "12",
  "13", "13.1", "13.2", "13.3", "13.4", "13.5",
  "14", "14.1", "14.2", "14.3", "14.4", "14.5",
  "15",
  "16",
];

/**
 * Top-level statements of the shared files that belong to MCP fakes but have
 * no `mcp` in their name, by exact name. Each one must name a statement that
 * exists (see "every name in MCP_NAMED is a statement"), so a rename cannot
 * silently drop a statement's comments from the scan.
 */
const MCP_NAMED: readonly string[] = [
  "FixtureLoadError",
  "FixtureLoadErrorInit",
  "FixtureLoadErrorJSON",
  "FixtureLoadRule",
  "FixtureLoadRuleRegistry",
  "capPart",
  "oneLine",
  "namePart",
  "headerValues",
  "queryPairs",
  "echoIdentityValue",
];

/** Top-level statements of the shared files that belong to MCP fakes. */
const MCP_STATEMENT = new RegExp(`mcp|^(?:${MCP_NAMED.join("|")})$`, "i");

interface ScopedFile {
  path: string;
  /** `null`: every comment of the file; otherwise only those inside matching statements. */
  statements: RegExp | null;
}

const FILES: readonly ScopedFile[] = [
  { path: "src/mcp-fakes.ts", statements: null },
  { path: "src/mcp-types.ts", statements: null },
  { path: "src/echo-text.ts", statements: null },
  { path: "src/constants.ts", statements: null },
  { path: "src/helpers.ts", statements: MCP_STATEMENT },
  { path: "src/types.ts", statements: MCP_STATEMENT },
  { path: "src/fixture-loader.ts", statements: MCP_STATEMENT },
];

interface Comment {
  file: string;
  line: number;
  /** The comment text without `//`, `/*`, `*` markers, lines joined by spaces. */
  text: string;
  /** Name of the top-level const the comment is attached to, if any. */
  constName: string | null;
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function statementNames(stmt: ts.Statement): string[] {
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.map((d) => d.name.getText());
  }
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)) &&
    stmt.name
  ) {
    return [stmt.name.text];
  }
  return [];
}

function clean(raw: string): string {
  return raw
    .replace(/^\/\*\*?|\*\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/+|\*)?\s?/, "").trim())
    .filter((line) => line !== "")
    .join(" ");
}

/** Every comment of `sf` that is in scope. */
function commentsOf(sf: ts.SourceFile, statements: RegExp | null): Comment[] {
  const text = sf.getFullText();
  const ranges = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node): void => {
    for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      ranges.set(r.pos, r);
    }
    for (const r of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) ranges.set(r.pos, r);
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);

  const spans = sf.statements.map((stmt) => ({
    start: stmt.getFullStart(),
    end: stmt.getEnd(),
    names: statementNames(stmt),
    constName:
      ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1
        ? stmt.declarationList.declarations[0].name.getText()
        : null,
  }));
  // A comment on the same line after a statement's end belongs to that
  // statement, not to the next one (whose full start is the same position).
  const trailingOwner = new Map<number, (typeof spans)[number]>();
  sf.statements.forEach((stmt, i) => {
    for (const r of ts.getTrailingCommentRanges(text, stmt.getEnd()) ?? []) {
      trailingOwner.set(r.pos, spans[i]);
    }
  });
  const out: Comment[] = [];
  for (const r of [...ranges.values()].sort((a, b) => a.pos - b.pos)) {
    const owner = trailingOwner.get(r.pos) ?? spans.find((s) => r.pos >= s.start && r.pos < s.end);
    if (statements !== null && !owner?.names.some((n) => statements.test(n))) continue;
    out.push({
      file: sf.fileName,
      line: sf.getLineAndCharacterOfPosition(r.pos).line + 1,
      text: clean(text.slice(r.pos, r.end)),
      constName: owner?.constName ?? null,
    });
  }
  return out;
}

/** Top-level `const NAME = <number>` values of `sf` (`1_000`, `-5`, `10 * 2` included). */
function numericConsts(sf: ts.SourceFile): Map<string, number> {
  const evaluate = (e: ts.Expression): number | null => {
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (ts.isParenthesizedExpression(e)) return evaluate(e.expression);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
      const v = evaluate(e.operand);
      return v === null ? null : -v;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
      const a = evaluate(e.left);
      const b = evaluate(e.right);
      return a === null || b === null ? null : a * b;
    }
    return null;
  };
  const out = new Map<string, number>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      const v = d.initializer ? evaluate(d.initializer) : null;
      if (v !== null && ts.isIdentifier(d.name)) out.set(d.name.text, v);
    }
  }
  return out;
}

interface Sources {
  comments: Comment[];
  consts: Map<string, number>;
}

function load(overrides: Record<string, string> = {}): Sources {
  const comments: Comment[] = [];
  const consts = new Map<string, number>();
  for (const f of FILES) {
    const text = overrides[f.path] ?? readFileSync(join(ROOT, f.path), "utf8");
    const sf = parse(f.path, text);
    comments.push(...commentsOf(sf, f.statements));
    for (const [k, v] of numericConsts(sf)) consts.set(k, v);
  }
  return { comments, consts };
}

/** The names in `MCP_NAMED` that no top-level statement of a shared file has. */
function missingNamed(overrides: Record<string, string> = {}): string[] {
  const names = new Set<string>();
  for (const f of FILES) {
    if (f.statements === null) continue;
    const sf = parse(f.path, overrides[f.path] ?? readFileSync(join(ROOT, f.path), "utf8"));
    for (const stmt of sf.statements) for (const n of statementNames(stmt)) names.add(n);
  }
  return MCP_NAMED.filter((n) => !names.has(n));
}

/** `createServer`'s default for `fixtureCountsMaxTestIds` (`src/server.ts`). */
function createServerDefaultCap(): number {
  const text = readFileSync(join(ROOT, "src/server.ts"), "utf8");
  const m = /fixtureCountsMaxTestIds:\s*options\?\.fixtureCountsMaxTestIds\s*\?\?\s*(\d+)/.exec(
    text,
  );
  if (!m) throw new Error("createServer's fixtureCountsMaxTestIds default not found");
  return Number(m[1]);
}

/** The `@modelcontextprotocol/sdk` devDependency version. */
function sdkVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  };
  return pkg.devDependencies["@modelcontextprotocol/sdk"].replace(/^[\^~]/, "");
}

// ---------------------------------------------------------------------------
// The claims a comment can make about a number

const SPEC_CITATION =
  /\b(?:spec(?:ification)?(?:\s+section)?|section)\s+§?\s*(\d+(?:\.\d+)*)|§\s*(\d+(?:\.\d+)*)/gi;

/** Spec sections cited by comments that the spec does not have (`file:line: N`). */
function badSpecCitations(comments: readonly Comment[]): string[] {
  const out: string[] = [];
  for (const c of comments) {
    for (const m of c.text.matchAll(SPEC_CITATION)) {
      const section = m[1] ?? m[2];
      if (!SPEC_SECTIONS.includes(section)) out.push(`${c.file}:${c.line}: spec ${section}`);
    }
  }
  return out;
}

interface Claim {
  /** What the number in the comment is, for the failure text. */
  what: string;
  pattern: RegExp;
  /** The accepted values of the captured number. */
  expected: (src: Sources) => readonly string[];
}

const codeValues = (): string[] => Object.values(MCP_FAKE_ERROR_CODES).map(String);

const CLAIMS: readonly Claim[] = [
  {
    what: "MCP_FAKE_ERROR_CODES value",
    pattern: /(?<![\w.])(-3\d{4})\b/g,
    expected: codeValues,
  },
  {
    what: "MCP_FAKES_MAX_DEPTH",
    pattern: /\b(\d+) levels\b/g,
    expected: () => [String(MCP_FAKES_MAX_DEPTH)],
  },
  {
    what: "MCP_FAKES_DEFAULT_MAX_TEST_IDS",
    pattern: /\bDefault (\d+)\b/g,
    expected: () => [String(MCP_FAKES_DEFAULT_MAX_TEST_IDS)],
  },
  {
    what: "createServer's fixtureCountsMaxTestIds default",
    pattern: /\b(\d+) under `createServer`/g,
    expected: () => [String(createServerDefaultCap())],
  },
  {
    what: "DIFF_LIMIT (the whole firstDifference text)",
    pattern: /\bwhole text at (\d[\d_]*)\b/g,
    expected: (src) => [String(src.consts.get("DIFF_LIMIT"))],
  },
  {
    what: "the @modelcontextprotocol/sdk devDependency",
    pattern: /@modelcontextprotocol\/sdk`?\s+v?(\d+\.\d+(?:\.\d+)?)/g,
    expected: () => {
      const v = sdkVersion();
      return [v, v.split(".").slice(0, 2).join(".")];
    },
  },
];

/** Numbers that are not constants: standards, HTTP statuses and example text. */
const NOT_A_CONSTANT = [/\bRFC \d+\b/g, /\bISO 8601\b/g, /\bHTTP [1-5]\d\d\b/g, /`[^`]*`/g];

/** "at most `X` chars", "cut to `X` chars", "cut at `X` chars": a length bound named by a constant. */
const LENGTH_CLAIM = /\b(?:at most|cut (?:to|at)(?: at most)?)\s+`(\w+)`\s+chars\b/g;

const HUGE = "y".repeat(50_000);

/**
 * For each length bound a comment states (`file:name`), the bound's value and
 * the longest text the code it describes produces for a huge input.
 */
const LENGTH_PROBES: Record<string, { bound: number; longest: () => number }> = {
  // echoText / echo: `limit` defaults to MCP_FAKES_ECHO_LIMIT.
  "src/mcp-fakes.ts:limit": {
    bound: MCP_FAKES_ECHO_LIMIT,
    longest: () => Math.max(echoText(HUGE).length, echo(HUGE).length),
  },
  // firstDifference: each side of the difference.
  "src/mcp-fakes.ts:MCP_FAKES_ECHO_LIMIT": {
    bound: MCP_FAKES_ECHO_LIMIT,
    longest: () => {
      const text = firstDifference({ a: HUGE }, { a: `${HUGE}z` });
      const m = /^\$\.a: expected (.*), received (.*)$/.exec(text);
      if (!m) throw new Error(`unexpected firstDifference text: ${text.slice(0, 80)}`);
      return Math.max(m[1].length, m[2].length);
    },
  },
  // cutText: `limit` defaults to MCP_FAKES_ECHO_LIMIT.
  "src/echo-text.ts:limit": {
    bound: MCP_FAKES_ECHO_LIMIT,
    longest: () =>
      Math.max(cutText(HUGE).length, cutText(JSON.stringify(HUGE), undefined, "json").length),
  },
  // FixtureLoadError: the file part of the message prefix.
  "src/fixture-loader.ts:MCP_FAKES_ECHO_LIMIT": {
    bound: MCP_FAKES_ECHO_LIMIT,
    longest: () => {
      const tail = ": [mcp-fakes/bad-block:g] x";
      const err = new FixtureLoadError({ rule: "mcp-fakes/bad-block:g", file: HUGE, detail: "x" });
      if (!err.message.endsWith(tail))
        throw new Error(`unexpected message: ${err.message.slice(-80)}`);
      return err.message.length - tail.length;
    },
  },
};

/** Length bounds in comments that the code does not keep (`file:line: …`). */
function badLengthClaims(src: Sources): string[] {
  const out: string[] = [];
  const probed = new Set<string>();
  for (const c of src.comments) {
    for (const m of c.text.matchAll(LENGTH_CLAIM)) {
      const key = `${c.file}:${m[1]}`;
      const probe = LENGTH_PROBES[key];
      probed.add(key);
      if (!probe) {
        out.push(`${c.file}:${c.line}: no probe for the bound \`${m[1]}\``);
        continue;
      }
      const constValue = src.consts.get(m[1]);
      if (constValue !== undefined && constValue !== probe.bound) {
        out.push(
          `${c.file}:${c.line}: \`${m[1]}\` is ${constValue}, the probe expects ${probe.bound}`,
        );
      }
      const longest = probe.longest();
      if (longest > probe.bound) {
        out.push(
          `${c.file}:${c.line}: says at most \`${m[1]}\` (${probe.bound}) chars, produces ${longest}`,
        );
      }
    }
  }
  for (const key of Object.keys(LENGTH_PROBES)) {
    if (!probed.has(key)) out.push(`${key}: probe for a bound no comment states`);
  }
  return out;
}

/** A comment's numeric claims that disagree with the constant (`file:line: …`). */
function badNumbers(src: Sources): string[] {
  const out: string[] = [];
  for (const c of src.comments) {
    let rest = c.text;
    for (const claim of CLAIMS) {
      const ok = claim.expected(src);
      for (const m of c.text.matchAll(claim.pattern)) {
        const n = m[1].replace(/_/g, "");
        if (!ok.includes(n)) {
          out.push(`${c.file}:${c.line}: ${n} is not ${claim.what} (${ok.join(" / ")})`);
        }
        rest = rest.replace(m[0], " ");
      }
    }
    // "The same limit as `X`" on a constant: the constant equals X.
    for (const m of c.text.matchAll(/\bsame (?:limit|value) as `(\w+)`/g)) {
      const mine = c.constName === null ? undefined : src.consts.get(c.constName);
      const theirs = m[1] === "MCP_FAKES_ECHO_LIMIT" ? MCP_FAKES_ECHO_LIMIT : src.consts.get(m[1]);
      if (mine === undefined || mine !== theirs) {
        out.push(`${c.file}:${c.line}: ${c.constName} = ${mine} is not ${m[1]} = ${theirs}`);
      }
    }
    // Any other number of two or more digits is a statement no claim checks.
    for (const re of NOT_A_CONSTANT) rest = rest.replace(re, " ");
    for (const m of rest.matchAll(/(?<![\w.])-?\d{2,}(?:[._]\d+)*(?![\w.])/g)) {
      out.push(`${c.file}:${c.line}: ${m[0]} is not checked by any claim`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("MCP fakes comments match the spec and the constants", () => {
  const src = load();

  it("reads comments from every file in scope", () => {
    const files = new Set(src.comments.map((c) => c.file));
    expect([...files].sort()).toEqual(FILES.map((f) => f.path).sort());
  });

  it("every name in MCP_NAMED is a statement of a shared file", () => {
    expect(missingNamed()).toEqual([]);
  });

  it("cites only spec sections that exist", () => {
    expect(badSpecCitations(src.comments)).toEqual([]);
  });

  it("states only numbers that equal the constants they describe", () => {
    expect(badNumbers(src)).toEqual([]);
  });

  it("states only length bounds the code keeps", () => {
    expect(badLengthClaims(src)).toEqual([]);
  });

  it.skipIf(!process.env.AIMOCK_MCP_FAKES_SPEC)("SPEC_SECTIONS matches the spec's headings", () => {
    const spec = readFileSync(process.env.AIMOCK_MCP_FAKES_SPEC as string, "utf8");
    const headings = [...spec.matchAll(/^#{2,4} (\d+(?:\.\d+)*)\.? /gm)].map((m) => m[1]);
    expect(headings).toEqual(SPEC_SECTIONS);
  });
});

describe("comments belong to the statement they are written on", () => {
  it("a trailing comment belongs to the statement it follows, not the next one", () => {
    const fixture = [
      "const mcpA = 1; // trailing on mcpA",
      "const other = 2; // trailing on other",
      "/** leading on mcpB */",
      "const mcpB = 3; /* trailing on mcpB */",
      "",
    ].join("\n");
    const found = commentsOf(parse("fixture.ts", fixture), /^mcp/);
    expect(found.map((c) => [c.line, c.text, c.constName])).toEqual([
      [1, "trailing on mcpA", "mcpA"],
      [3, "leading on mcpB", "mcpB"],
      [4, "trailing on mcpB", "mcpB"],
    ]);
  });
});

describe("the comment scans find planted drift", () => {
  const PATH = "src/mcp-fakes.ts";
  const original = readFileSync(join(ROOT, PATH), "utf8");
  const line = original.split("\n").length + 1;
  const plant = (comment: string): Sources =>
    load({ [PATH]: `${original}\n${comment}\nexport const PLANTED = 1;\n` });
  const CONST = "src/constants.ts";
  const constantsText = readFileSync(join(ROOT, CONST), "utf8");
  const withEchoLimit = (n: number): Sources => {
    const at = `const MCP_FAKES_ECHO_LIMIT = ${MCP_FAKES_ECHO_LIMIT};`;
    if (!constantsText.includes(at)) throw new Error(`${CONST}: planting point not found`);
    return load({ [CONST]: constantsText.replace(at, `const MCP_FAKES_ECHO_LIMIT = ${n};`) });
  };
  /** The findings of `scan` on the planted sources that the real sources do not have. */
  const added = <T>(scan: (s: T) => string[], planted: T, real: T): string[] => {
    const before = scan(real);
    return scan(planted).filter((f) => !before.includes(f));
  };
  const real = load();

  it("a name in MCP_NAMED whose statement was renamed", () => {
    const HELPERS = "src/helpers.ts";
    const text = readFileSync(join(ROOT, HELPERS), "utf8");
    const at = "function queryPairs(";
    if (!text.includes(at)) throw new Error(`${HELPERS}: planting point not found`);
    expect(missingNamed({ [HELPERS]: text.replace(at, "function queryPairsRenamed(") })).toEqual([
      "queryPairs",
    ]);
  });

  it("a citation of a missing spec section", () => {
    expect(
      added(
        badSpecCitations,
        plant("/** See spec 9.7 and section 6.2. */").comments,
        real.comments,
      ),
    ).toEqual([`${PATH}:${line}: spec 9.7`]);
  });

  it("a wrong depth, error code, default cap and diff limit", () => {
    const planted = plant(
      "/** Nested 65 levels; code -31012; Default 400; the whole text at 2_000. */",
    );
    expect(added(badNumbers, planted, real)).toEqual([
      `${PATH}:${line}: -31012 is not MCP_FAKE_ERROR_CODES value (-32602 / -32602 / -31010 / -31011)`,
      `${PATH}:${line}: 65 is not MCP_FAKES_MAX_DEPTH (64)`,
      `${PATH}:${line}: 400 is not MCP_FAKES_DEFAULT_MAX_TEST_IDS (500)`,
      `${PATH}:${line}: 2000 is not DIFF_LIMIT (the whole firstDifference text) (1000)`,
    ]);
  });

  it("a number no claim checks in the constants.ts comments", () => {
    const at = "fit in this limit.";
    if (!constantsText.includes(at)) throw new Error(`${CONST}: planting point not found`);
    const planted = load({ [CONST]: constantsText.replace(at, "fit in this limit (250 chars).") });
    expect(added(badNumbers, planted, real)).toEqual([
      expect.stringMatching(/^src\/constants\.ts:\d+: 250 is not checked by any claim$/),
    ]);
  });

  it("a number no claim checks", () => {
    expect(added(badNumbers, plant("/** Keeps 300 chars of each value. */"), real)).toEqual([
      `${PATH}:${line}: 300 is not checked by any claim`,
    ]);
  });

  it("a length bound with no probe, and a constant its probe no longer matches", () => {
    expect(added(badLengthClaims, plant("/** Cut to at most `PLANTED` chars. */"), real)).toEqual([
      `${PATH}:${line}: no probe for the bound \`PLANTED\``,
    ]);
    const drift = added(badLengthClaims, withEchoLimit(300), real);
    expect(drift).toContainEqual(
      expect.stringMatching(
        /^src\/fixture-loader\.ts:\d+: `MCP_FAKES_ECHO_LIMIT` is 300, the probe expects 200$/,
      ),
    );
    expect(
      drift.every((f) => / `MCP_FAKES_ECHO_LIMIT` is 300, the probe expects 200$/.test(f)),
    ).toBe(true);
  });

  it("a constant that is no longer the same as the one it names", () => {
    expect(
      added(badNumbers, plant("/** The same limit as `MCP_FAKES_ECHO_LIMIT`. */"), real),
    ).toEqual([`${PATH}:${line}: PLANTED = 1 is not MCP_FAKES_ECHO_LIMIT = 200`]);
  });
});
