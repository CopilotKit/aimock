import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Integration guard: "every handler path awaits the configured chaos latency
// before it rolls the dice, on the response it is about to write to, and
// re-checks that the response is still writable afterwards."
//
// Rolling the dice means calling `applyChaos()`, `applyChaosDeprecated()`,
// `evaluateChaos()` or `applyChaosAction()` — the sync rollers. None of them
// awaits `--chaos-latency`; only `awaitChaosLatency()` and `applyChaosAsync()`
// do. So a handler that rolls without one of those two first silently drops
// the configured delay. That is the composition bug this gate exists to catch:
// each PR that adds a route is correct in isolation, every branch is green, and
// nothing asserts the invariant across modules.
//
// THE SATISFACTION RULE (one sentence)
//   A roll is satisfied only by an `await <latency>(…)` that is UNCONDITIONAL
//   — every step from the await up to its owning statement sits in an
//   always-evaluated position, and that statement is a direct child of a
//   `Block` (never a `SourceFile`, module block or `case` clause) — which
//   receives the same response identifier the roll writes to, is followed
//   inside that same block by a `responseUnwritable(<that response>)` re-check
//   before the roll, and whose block contains the roll textually after it with
//   no hoisted `function` declaration in between.
//
// Why each clause is there — every one of them is a hole an earlier revision of
// this gate had, i.e. a shape that rolled chaos for real while this file was
// green:
//   * UNCONDITIONAL: `if (flag) await awaitChaosLatency(…);` owns its await via
//     the `IfStatement`, which sits in the block and so "dominated" every later
//     roll — though it may never have run. Same for a ternary, a `&&` right
//     arm, a loop body or a `try` block.
//   * NEVER A SOURCEFILE: one module-level `await awaitChaosLatency()` used to
//     satisfy every roll in the entire file.
//   * NO HOISTED `function` IN BETWEEN: a `function` declaration written after
//     the await can be called before it, so positional order proves nothing
//     about its body. Arrow/function EXPRESSIONS are fine — they cannot exist
//     before the statement that creates them, which is why a
//     `beforeWriteResponse` hook created after the await is covered.
//   * SAME RESPONSE IDENTIFIER (C10): the latency timer is cancelled off the
//     response's `close`. An await handed a different `res` — or none — leaves
//     a disconnected client waiting out the full delay.
//   * `responseUnwritable` RE-CHECK (C13): the await resolves EARLY when the
//     client hangs up mid-delay. `applyChaosAsync` re-checks writability at
//     exactly that point; a SPLIT gate (`awaitChaosLatency` + `evaluateChaos` +
//     `applyChaosAction`) has to do it itself, or it serves and JOURNALS a full
//     response into a dead socket.
//   Dominance is still approximated structurally, not by a real CFG:
//   `break`/`continue`/`throw` between the await and the roll are not modelled.
//   The approximation only ever ACCEPTS unconditional straight-line dominance,
//   so it stays conservative.
//
// WHAT IS CHECKED
//   * Every source file in the repository (`.ts`, `.mts`, `.cts`, `.tsx`;
//     `.d.*`, `node_modules`, build output, dot-directories and `__tests__`
//     excluded) — not just `src/` — except `src/chaos.ts` itself, which defines
//     the primitives.
//   * `applyChaosAsync(...)` rolls the dice too: a call to it that is not
//     directly awaited is an offender, because the roll happens either way
//     while the latency does not.
//   * Bindings are resolved from the *import declaration* of `./chaos.js`, not
//     from identifier text, so `import { applyChaos as x }`,
//     `import * as chaos from "./chaos.js"` and a default import are all
//     caught. Type-only imports bind no value and are skipped.
//   * The roll / latency / writability / neutral name sets must EQUAL the real
//     value exports of src/chaos.ts — not merely be a subset, and not merely
//     cover the ones whose name happens to contain "Chaos". A new export fails
//     this gate until somebody classifies it. `export { … }` lists and
//     `export * from` are handled; the latter fails loudly rather than
//     silently under-reporting the export set.
//   * Any *escaping* reference — a roll or `applyChaosAsync` binding that is
//     referenced without being called, re-exported with `export { … }`, or a
//     chaos NAMESPACE binding that is aliased or indexed dynamically — is an
//     offender: the gate cannot follow it to its call site. Type positions
//     (`typeof applyChaos`, `Parameters<typeof applyChaos>`) are erased at
//     runtime and are therefore NOT references.
//   * Parse failures are a test FAILURE naming the file — a file the parser
//     chokes on must never contribute zero findings silently.
//   * The positive control runs THROUGH `sourceFiles()` AND `resolveBindings()`
//     and asserts a minimum file count plus a minimum number of files whose
//     chaos bindings actually resolved, so an empty traversal or a broken
//     resolver fails loudly instead of passing vacuously.
//
// WHAT IS NOT CHECKED
//   * Interprocedural flow. The await and the roll must share a block; a roll
//     in a helper called by an awaiting handler is flagged.
//   * `require()` / dynamic `import()` of the chaos module — the codebase is
//     ESM-only and static.
//   * Re-exports with a module specifier (`export { applyChaosDeprecated as
//     applyChaos } from "./chaos.js"` in index.ts) bind nothing locally and are
//     correctly not flagged. A *local* `export { applyChaos }` after an import
//     DOES escape and is flagged.
//   * A local declaration that shadows a roll name is treated conservatively
//     (it can only ever produce an extra finding, never hide one).
//   * Runtime reachability: this is a source-structure gate, not an execution
//     trace. A new route is covered the moment it is written.
//
// Files are read with `fs` + the TypeScript parser, not a shell `grep`: a
// mention of `applyChaos(` in a comment or string is not a call site, and
// src/fixture-loader.ts contains a literal NUL byte on which grep reports a
// binary file and silently contributes no matches. Every file is parsed ONCE
// and the result shared by all the assertions below.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHAOS_SOURCE = path.join(REPO_ROOT, "src", "chaos.ts");

/** The one module allowed to roll without an await: it defines the primitives. */
const ALLOWED = path.join("src", "chaos.ts");

/**
 * Calls that roll the chaos dice synchronously. None of them awaits the
 * configured latency. `applyChaosDeprecated` is the exported sync wrapper
 * re-exported by index.ts as `applyChaos`; importing it under any alias must
 * not evade the gate.
 */
const ROLL_NAMES = new Set([
  "applyChaos",
  "applyChaosDeprecated",
  "evaluateChaos",
  "applyChaosAction",
]);

/** Rolls the dice AND awaits the latency — but only if it is itself awaited. */
const ASYNC_ROLL_NAMES = new Set(["applyChaosAsync"]);

/** Calls that await the configured latency. One must dominate any roll. */
const LATENCY_NAMES = new Set(["awaitChaosLatency", "applyChaosAsync"]);

/**
 * The post-await writability re-check a split gate owes (C13). All four are
 * the SAME check at different resolutions — `responseGone*` is "nothing can be
 * delivered at all", `responseUnwritable*` is that plus `headers-sent` — and a
 * split gate satisfies its obligation with whichever one it reads, so all four
 * have to count or the gate fails a call site that is in fact correct.
 */
const WRITABILITY_NAMES = new Set([
  "responseGone",
  "responseGoneReason",
  "responseUnwritable",
  "responseUnwritableReason",
]);

/**
 * Chaos exports that neither roll, await nor re-check: parsing, config
 * resolution and diagnostics. Listed so the reconciliation below can tell
 * "classified as harmless" apart from "nobody has looked at this export yet".
 */
const NEUTRAL_CHAOS_EXPORTS = new Set([
  "CHAOS_FIELDS",
  "CHAOS_FIELD_NAMES",
  "describeUnwritableReason",
  "isChaosScope",
  "parseChaosField",
  "parseChaosNumber",
  "resetChaosWarnings",
  "resolveChaosConfig",
  "resolveChaosLatencyMs",
]);

/** `./chaos.js`, `../chaos.js`, … — the module the bindings must come from. */
const CHAOS_MODULE_RE = /(^|\/)chaos\.js$/;

const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx"];
const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "__tests__"]);

/**
 * Floors for the positive control. Deliberately far below the real counts so
 * ordinary churn never trips them, but high enough that a traversal returning
 * nothing — or a binding resolver that stops matching the import specifier —
 * fails. Intentionally NOT the exact counts: a stale exact number is a second
 * thing to maintain and has gone stale twice already.
 */
const MIN_SOURCE_FILES = 40;
const MIN_CHAOS_BINDERS = 10;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    if (DECLARATION_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    if (path.relative(REPO_ROOT, full) === ALLOWED) continue;
    out.push(full);
  }
  return out;
}

/** Which set of chaos exports a reference is being tested against. */
type BindingKind = "roll" | "asyncRoll" | "latency" | "writability";

interface ChaosBindings {
  /** local identifier -> canonical exported name, for the sync rollers. */
  roll: Map<string, string>;
  /** locals bound to `applyChaosAsync`. */
  asyncRoll: Set<string>;
  /** locals bound to `awaitChaosLatency` / `applyChaosAsync`. */
  latency: Set<string>;
  /** locals bound to `responseUnwritable`. */
  writability: Set<string>;
  /** locals bound to a classified-but-harmless chaos export. */
  neutral: Set<string>;
  /** locals bound via `import * as ns` / a default import of the chaos module. */
  namespaces: Set<string>;
}

function namesFor(kind: BindingKind): Set<string> {
  if (kind === "roll") return ROLL_NAMES;
  if (kind === "asyncRoll") return ASYNC_ROLL_NAMES;
  if (kind === "latency") return LATENCY_NAMES;
  return WRITABILITY_NAMES;
}

interface Analysis {
  offenders: string[];
  parseErrors: string[];
  /** true when the file imports the chaos module at all. */
  importsChaos: boolean;
  /** true when `resolveBindings` bound ANY chaos export from that import. */
  bindsChaos: boolean;
}

/** TS attaches parse diagnostics to the SourceFile, but does not type them. */
interface SourceFileWithDiagnostics extends ts.SourceFile {
  parseDiagnostics?: readonly ts.Diagnostic[];
}

function scriptKindFor(file: string): ts.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parse(fileName: string, text: string): SourceFileWithDiagnostics {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ES2022,
    true,
    scriptKindFor(fileName),
  ) as SourceFileWithDiagnostics;
}

function resolveBindings(sourceFile: ts.SourceFile): ChaosBindings {
  const bindings: ChaosBindings = {
    roll: new Map(),
    asyncRoll: new Set(),
    latency: new Set(),
    writability: new Set(),
    neutral: new Set(),
    namespaces: new Set(),
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!CHAOS_MODULE_RE.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    // `import type { … }` binds a type, never a callable value.
    if (!clause || clause.isTypeOnly) continue;
    // A DEFAULT import of the chaos module binds whatever the module object
    // exposes under interop. Treated as a namespace: conservative, and it
    // closes `import chaosNs from "./chaos.js"; chaosNs.applyChaos()`.
    if (clause.name) bindings.namespaces.add(clause.name.text);
    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      bindings.namespaces.add(named.name.text);
      continue;
    }
    for (const specifier of named.elements) {
      if (specifier.isTypeOnly) continue;
      const imported = (specifier.propertyName ?? specifier.name).text;
      const local = specifier.name.text;
      if (ROLL_NAMES.has(imported)) bindings.roll.set(local, imported);
      if (ASYNC_ROLL_NAMES.has(imported)) bindings.asyncRoll.add(local);
      if (LATENCY_NAMES.has(imported)) bindings.latency.add(local);
      if (WRITABILITY_NAMES.has(imported)) bindings.writability.add(local);
      if (NEUTRAL_CHAOS_EXPORTS.has(imported)) bindings.neutral.add(local);
    }
  }

  return bindings;
}

/** Is `node` a reference to a chaos export of kind `kind`? */
function referencedName(node: ts.Node, bindings: ChaosBindings, kind: BindingKind): boolean {
  if (ts.isIdentifier(node)) {
    if (kind === "roll") return bindings.roll.has(node.text);
    if (kind === "asyncRoll") return bindings.asyncRoll.has(node.text);
    if (kind === "latency") return bindings.latency.has(node.text);
    return bindings.writability.has(node.text);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return (
      ts.isIdentifier(node.expression) &&
      bindings.namespaces.has(node.expression.text) &&
      namesFor(kind).has(node.name.text)
    );
  }
  return false;
}

/**
 * `export { applyChaos }` (no module specifier) re-exports the LOCAL binding —
 * the value really does escape. `export { x } from "./chaos.js"` binds nothing
 * locally, and the `as` target of an alias is a new exported name, not a use.
 */
function isLocalValueReExport(node: ts.Identifier, specifier: ts.ExportSpecifier): boolean {
  if (specifier.isTypeOnly) return false;
  if (specifier.propertyName && specifier.name === node) return false;
  const declaration = specifier.parent.parent;
  if (!ts.isExportDeclaration(declaration)) return false;
  if (declaration.isTypeOnly) return false;
  return declaration.moduleSpecifier === undefined;
}

/** Declaration/import/export/type positions that mention a name but do not use it. */
function isNonReferencePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportSpecifier(parent)) return true;
  if (ts.isExportSpecifier(parent)) return !isLocalValueReExport(node, parent);
  if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  // Type positions are erased before anything runs: `typeof applyChaos`,
  // `Parameters<typeof applyChaos>`, `import("./chaos.js").applyChaos`.
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isTypeQueryNode(current) || ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current)) break;
  }
  return false;
}

/**
 * Is `child` in a position of `parent` that is evaluated WHENEVER `parent` is?
 * Anything not listed is rejected, so a shape nobody thought about is treated
 * as conditional rather than silently accepted.
 */
function isUnconditionalChild(child: ts.Node, parent: ts.Node): boolean {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAwaitExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    ts.isExpressionStatement(parent) ||
    ts.isPrefixUnaryExpression(parent)
  ) {
    return true;
  }
  if (ts.isVariableDeclaration(parent)) return parent.initializer === child;
  if (ts.isVariableDeclarationList(parent)) return true;
  if (ts.isVariableStatement(parent)) return parent.declarationList === child;
  if (ts.isReturnStatement(parent) || ts.isThrowStatement(parent)) return true;
  // A condition is evaluated unconditionally; the branches are not.
  if (ts.isIfStatement(parent) || ts.isSwitchStatement(parent)) {
    return parent.expression === child;
  }
  if (ts.isCallExpression(parent)) {
    // `a?.(await x())` may never evaluate its arguments.
    if (parent.questionDotToken) return false;
    return parent.expression === child || parent.arguments.some((argument) => argument === child);
  }
  if (ts.isNewExpression(parent)) {
    return (
      parent.expression === child || (parent.arguments ?? []).some((argument) => argument === child)
    );
  }
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
    return !parent.questionDotToken && parent.expression === child;
  }
  if (ts.isBinaryExpression(parent)) {
    if (parent.left === child) return true;
    const operator = parent.operatorToken.kind;
    return (
      operator !== ts.SyntaxKind.AmpersandAmpersandToken &&
      operator !== ts.SyntaxKind.BarBarToken &&
      operator !== ts.SyntaxKind.QuestionQuestionToken
    );
  }
  return false;
}

/**
 * The statement that owns `node` when — and only when — every step from `node`
 * up to it is unconditional AND that statement is a direct child of a `Block`.
 * A `SourceFile`, module block or `case` clause owner is rejected outright.
 */
function unconditionalOwner(node: ts.Node): { statement: ts.Node; block: ts.Block } | undefined {
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isBlock(parent)) {
      return ts.isStatement(current) ? { statement: current, block: parent } : undefined;
    }
    if (!isUnconditionalChild(current, parent)) return undefined;
  }
  return undefined;
}

/** A hoisted `function` declaration can run before the await that precedes it. */
function crossesHoistedFunction(node: ts.Node, block: ts.Block): boolean {
  for (
    let current: ts.Node | undefined = node;
    current && current !== block;
    current = current.parent
  ) {
    if (ts.isFunctionDeclaration(current)) return true;
  }
  return false;
}

/** `applyChaosAction(action, res, …)` — the response the roll writes to. */
function responseArgument(call: ts.CallExpression): ts.Identifier | undefined {
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText();
  if (name !== "applyChaosAction") return undefined;
  const second = call.arguments[1];
  return second && ts.isIdentifier(second) ? second : undefined;
}

interface LatencyAwait {
  statement: ts.Node;
  block: ts.Block;
  /** identifier arguments handed to the latency call, e.g. `res`. */
  argumentNames: Set<string>;
}

/**
 * Analyse one file against the invariant. `fileName` is used only for the
 * reported location, so a synthetic fixture can be analysed the same way a
 * real file is.
 */
function analyze(fileName: string, text: string): Analysis {
  const sourceFile = parse(fileName, text);

  const label = (node: ts.Node, suffix: string): string => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${fileName}:${line + 1} — ${suffix}`;
  };

  const parseErrors = (sourceFile.parseDiagnostics ?? []).map((diagnostic) => {
    const at =
      diagnostic.start === undefined
        ? ""
        : `:${sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
    return `${fileName}${at} — ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });

  const bindings = resolveBindings(sourceFile);
  const importsChaos = sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      CHAOS_MODULE_RE.test(statement.moduleSpecifier.text),
  );

  // `bindsChaos` is the positive-control signal: did `resolveBindings` match
  // this file's chaos import at all, neutral names included? A file that only
  // imports `parseChaosNumber` binds something but can never offend.
  const bindsChaos =
    bindings.roll.size > 0 ||
    bindings.latency.size > 0 ||
    bindings.writability.size > 0 ||
    bindings.neutral.size > 0 ||
    bindings.namespaces.size > 0;
  const canOffend =
    bindings.roll.size > 0 || bindings.latency.size > 0 || bindings.namespaces.size > 0;
  if (!canOffend) return { offenders: [], parseErrors, importsChaos, bindsChaos };

  const latencyAwaits: LatencyAwait[] = [];
  const writabilityChecks: Array<{ start: number; end: number; response: string }> = [];
  const rollCalls: ts.CallExpression[] = [];
  const unawaitedAsyncRolls: ts.CallExpression[] = [];
  const escapedRefs: ts.Node[] = [];

  const isDirectlyAwaited = (call: ts.CallExpression): boolean => {
    let current: ts.Node = call;
    while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
    return current.parent !== undefined && ts.isAwaitExpression(current.parent);
  };

  const collect = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) {
      const operand = ts.isParenthesizedExpression(node.expression)
        ? node.expression.expression
        : node.expression;
      if (ts.isCallExpression(operand) && referencedName(operand.expression, bindings, "latency")) {
        const owner = unconditionalOwner(node);
        if (owner) {
          const argumentNames = new Set(
            operand.arguments.filter(ts.isIdentifier).map((argument) => argument.text),
          );
          latencyAwaits.push({ statement: owner.statement, block: owner.block, argumentNames });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      if (referencedName(node.expression, bindings, "asyncRoll") && !isDirectlyAwaited(node)) {
        unawaitedAsyncRolls.push(node);
      }
      if (referencedName(node.expression, bindings, "writability")) {
        const response = node.arguments[0];
        if (response && ts.isIdentifier(response)) {
          writabilityChecks.push({
            start: node.getStart(sourceFile),
            end: node.end,
            response: response.text,
          });
        }
      }
    }

    if (ts.isIdentifier(node) && !isNonReferencePosition(node)) {
      const parent = node.parent;
      const called = parent && ts.isCallExpression(parent) && parent.expression === node;
      if (bindings.roll.has(node.text)) {
        if (called) rollCalls.push(parent);
        else escapedRefs.push(node);
      } else if (bindings.asyncRoll.has(node.text)) {
        if (!called) escapedRefs.push(node);
      } else if (bindings.namespaces.has(node.text)) {
        // `chaosNs.applyChaos` is resolved below; anything else — aliasing the
        // namespace, indexing it dynamically — escapes.
        const resolvable =
          parent !== undefined &&
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node;
        if (!resolvable) escapedRefs.push(node);
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const parent = node.parent;
      const called = parent && ts.isCallExpression(parent) && parent.expression === node;
      if (referencedName(node, bindings, "roll")) {
        if (called) rollCalls.push(parent);
        else escapedRefs.push(node);
      } else if (referencedName(node, bindings, "asyncRoll") && !called) {
        escapedRefs.push(node);
      }
    }

    ts.forEachChild(node, collect);
  };
  ts.forEachChild(sourceFile, collect);

  /** Why this roll is not covered — `undefined` when it is. */
  const diagnose = (call: ts.CallExpression): string | undefined => {
    const start = call.getStart(sourceFile);
    const response = responseArgument(call);

    const positional = latencyAwaits.filter(
      (gate) =>
        start >= gate.statement.end &&
        call.end <= gate.block.end &&
        !crossesHoistedFunction(call, gate.block),
    );
    if (positional.length === 0) {
      return "rolls chaos with no UNCONDITIONAL awaited latency dominating it in the same block";
    }
    if (!response) return undefined;

    const threaded = positional.filter((gate) => gate.argumentNames.has(response.text));
    if (threaded.length === 0) {
      return (
        `rolls chaos into \`${response.text}\`, but no dominating latency await is handed ` +
        `\`${response.text}\` — the delay cannot be cancelled when that client hangs up (C10)`
      );
    }

    const rechecked = threaded.some((gate) =>
      writabilityChecks.some(
        (check) =>
          check.response === response.text &&
          check.start >= gate.statement.end &&
          check.end <= start,
      ),
    );
    if (!rechecked) {
      return (
        `rolls chaos into \`${response.text}\` after a latency await with no ` +
        `\`responseUnwritable(${response.text})\` re-check in between — a client that hung up ` +
        `mid-delay still gets served and JOURNALLED into a dead socket (C13)`
      );
    }
    return undefined;
  };

  const offenders = [
    ...rollCalls.flatMap((call) => {
      const reason = diagnose(call);
      return reason ? [label(call, `${call.expression.getText(sourceFile)}() ${reason}`)] : [];
    }),
    ...unawaitedAsyncRolls.map((call) =>
      label(
        call,
        `${call.expression.getText(sourceFile)}() rolls chaos but is not awaited — the roll ` +
          `happens while the configured latency does not`,
      ),
    ),
    ...escapedRefs.map((ref) =>
      label(
        ref,
        `${ref.getText(sourceFile)} is referenced without being called — the guard ` +
          `cannot prove the latency is awaited before it rolls`,
      ),
    ),
  ];

  return { offenders, parseErrors, importsChaos, bindsChaos };
}

interface ScannedFile {
  relative: string;
  analysis: Analysis;
}

/** Parse + analyse the whole tree ONCE; every assertion below reuses this. */
let scanned: ScannedFile[] | undefined;
function scan(): ScannedFile[] {
  if (!scanned) {
    scanned = sourceFiles(REPO_ROOT).map((file) => {
      const relative = path.relative(REPO_ROOT, file);
      return { relative, analysis: analyze(relative, readFileSync(file, "utf8")) };
    });
  }
  return scanned;
}

/**
 * Names exported as VALUES from src/chaos.ts (types are erased, so excluded).
 * `export { … }` lists count; `export * from` cannot be enumerated here and
 * throws rather than silently under-reporting the export set.
 */
function chaosValueExports(): Set<string> {
  const sourceFile = parse(ALLOWED, readFileSync(CHAOS_SOURCE, "utf8"));
  const names = new Set<string>();
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (exported(statement) && statement.name) names.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause) {
        throw new Error(
          `${ALLOWED} uses \`export * from\`, which this gate cannot enumerate. Classify the ` +
            `re-exported chaos values explicitly, or teach chaosValueExports() to follow it.`,
        );
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const specifier of statement.exportClause.elements) {
        if (specifier.isTypeOnly) continue;
        names.add(specifier.name.text);
      }
    }
  }
  return names;
}

describe("chaos call sites", () => {
  it("every chaos roll outside src/chaos.ts is dominated by an awaited latency", () => {
    const offenders = scan()
      .flatMap((file) => file.analysis.offenders)
      .sort();

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Chaos is rolled without the configured latency being awaited first — ` +
            `\`--chaos-latency\` silently does not apply on these paths. Await ` +
            `\`awaitChaosLatency(..., res, ...)\` UNCONDITIONALLY in the SAME block, re-check ` +
            `\`responseUnwritable(res)\`, then roll (or use \`await applyChaosAsync(...)\`); ` +
            `see src/chaos.ts:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every scanned source file parses", () => {
    const failures = scan().flatMap((file) => file.analysis.parseErrors);

    expect(
      failures,
      failures.length === 0
        ? ""
        : `Source files failed to parse — they contribute ZERO findings to the ` +
            `guard above, so the invariant is unchecked for them:\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });

  it("scans a real, non-empty set of files and resolves their chaos imports", () => {
    // Positive control, through the same traversal AND the same binding
    // resolver the guard uses: an empty or filtered-to-nothing `sourceFiles()`
    // would make the guard pass vacuously, and a `resolveBindings` that stopped
    // matching the import specifier would make it blind. Both fail here.
    const files = scan();
    expect(files.length).toBeGreaterThanOrEqual(MIN_SOURCE_FILES);
    expect(files.map((file) => file.relative)).toContain(path.join("src", "server.ts"));

    const binders = files.filter((file) => file.analysis.bindsChaos);
    expect(binders.length).toBeGreaterThanOrEqual(MIN_CHAOS_BINDERS);

    // Every file that imports the chaos module must also BIND something from
    // it — a resolver that silently stops resolving shows up here rather than
    // as a quietly emptied guard. (index.ts only re-exports, so it binds
    // nothing locally and is excluded.)
    const importedButUnbound = files
      .filter((file) => file.analysis.importsChaos && !file.analysis.bindsChaos)
      .map((file) => file.relative)
      .filter((relative) => relative !== path.join("src", "index.ts"))
      .sort();
    expect(
      importedButUnbound,
      importedButUnbound.length === 0
        ? ""
        : `These files import src/chaos.ts but resolveBindings() bound nothing from them — ` +
            `the guard is blind to their call sites:\n  ${importedButUnbound.join("\n  ")}`,
    ).toEqual([]);
  });

  it("classifies every chaos export, so a rename cannot silently empty the gate", () => {
    // The classification must EQUAL the real export set, in both directions:
    // a name this gate watches that chaos.ts no longer exports means the gate
    // is watching nothing, and an export nobody classified could be a brand new
    // roller. Matching on the substring "Chaos" used to let a roller named
    // anything else (`responseUnwritable`, say) through unclassified.
    const exports = chaosValueExports();
    expect(exports.size).toBeGreaterThan(0);

    const classified = new Set([
      ...ROLL_NAMES,
      ...ASYNC_ROLL_NAMES,
      ...LATENCY_NAMES,
      ...WRITABILITY_NAMES,
      ...NEUTRAL_CHAOS_EXPORTS,
    ]);

    const missing = [...classified].filter((name) => !exports.has(name)).sort();
    expect(
      missing,
      missing.length === 0
        ? ""
        : `These names are checked by this gate but src/chaos.ts no longer exports ` +
            `them — the gate is watching nothing. Update ROLL_NAMES / ASYNC_ROLL_NAMES / ` +
            `LATENCY_NAMES / WRITABILITY_NAMES / NEUTRAL_CHAOS_EXPORTS:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);

    const unclassified = [...exports].filter((name) => !classified.has(name)).sort();
    expect(
      unclassified,
      unclassified.length === 0
        ? ""
        : `src/chaos.ts exports these values and this gate does not know what they do. ` +
            `Add each to ROLL_NAMES (it rolls the dice), ASYNC_ROLL_NAMES + LATENCY_NAMES ` +
            `(it rolls and awaits the configured latency), LATENCY_NAMES (it awaits it), ` +
            `WRITABILITY_NAMES (it re-checks the response) or NEUTRAL_CHAOS_EXPORTS (it does ` +
            `none of those):\n  ${unclassified.join("\n  ")}`,
    ).toEqual([]);
  });

  it("flags the shapes it exists to flag, and clears the shapes that are correct", () => {
    // Analyser control: the fixtures below are the exact evasions that made the
    // previous versions of this gate green on a real violation.
    const aliasedSyncCall = analyze(
      "fixture/aliased.ts",
      `import { applyChaos as roll } from "./chaos.js";
       export function handler() { roll(); }`,
    );
    expect(aliasedSyncCall.offenders.length).toBe(1);

    const deprecatedAliasedAsApplyChaos = analyze(
      "fixture/deprecated-alias.ts",
      `import { applyChaosDeprecated as applyChaos } from "./chaos.js";
       export function handler() { applyChaos(); }`,
    );
    expect(deprecatedAliasedAsApplyChaos.offenders.length).toBe(1);

    const rolledWithoutAwait = analyze(
      "fixture/split-roll.ts",
      `import { evaluateChaos, applyChaosAction } from "./chaos.js";
       export function handler() {
         const action = evaluateChaos();
         if (action) applyChaosAction(action);
       }`,
    );
    expect(rolledWithoutAwait.offenders.length).toBe(2);

    const namespaceRoll = analyze(
      "fixture/namespace.ts",
      `import * as chaos from "./chaos.js";
       export function handler() { chaos.applyChaosAction("drop"); }`,
    );
    expect(namespaceRoll.offenders.length).toBe(1);

    const escapingReference = analyze(
      "fixture/escaping.ts",
      `import { applyChaos } from "./chaos.js";
       export const deferred = applyChaos;`,
    );
    expect(escapingReference.offenders.length).toBe(1);

    const correctSplitGate = analyze(
      "fixture/correct.ts",
      `import { awaitChaosLatency, responseUnwritable, evaluateChaos, applyChaosAction } from "./chaos.js";
       export async function handler(res: unknown) {
         await awaitChaosLatency(res);
         if (responseUnwritable(res)) return;
         const action = evaluateChaos();
         if (action) applyChaosAction(action, res);
       }`,
    );
    expect(correctSplitGate.offenders).toEqual([]);

    const awaitedInEnclosingHandler = analyze(
      "fixture/nested-callback.ts",
      `import { awaitChaosLatency, responseUnwritable, applyChaosAction } from "./chaos.js";
       export async function handler(res: unknown) {
         await awaitChaosLatency(res);
         if (responseUnwritable(res)) return;
         return { beforeWriteResponse: () => { applyChaosAction("malformed", res); } };
       }`,
    );
    expect(awaitedInEnclosingHandler.offenders).toEqual([]);

    const awaitedAfterTheRoll = analyze(
      "fixture/too-late.ts",
      `import { awaitChaosLatency, evaluateChaos } from "./chaos.js";
       export async function handler() {
         const action = evaluateChaos();
         await awaitChaosLatency();
         return action;
       }`,
    );
    expect(awaitedAfterTheRoll.offenders.length).toBe(1);

    // The hole that made an older rule check only the FIRST gate per function:
    // a second, independent gate whose own await was deleted.
    const secondGateInSameFunction = analyze(
      "fixture/second-gate.ts",
      `import { awaitChaosLatency, evaluateChaos } from "./chaos.js";
       export async function handler(a: boolean, b: boolean) {
         if (a) {
           await awaitChaosLatency();
           const first = evaluateChaos();
           if (first) return first;
         }
         if (b) {
           const second = evaluateChaos();
           if (second) return second;
         }
         return null;
       }`,
    );
    expect(secondGateInSameFunction.offenders.length).toBe(1);

    const awaitInUninvokedClosure = analyze(
      "fixture/closure-await.ts",
      `import { awaitChaosLatency, evaluateChaos } from "./chaos.js";
       export async function handler() {
         const neverCalled = async () => { await awaitChaosLatency(); };
         void neverCalled;
         return evaluateChaos();
       }`,
    );
    expect(awaitInUninvokedClosure.offenders.length).toBe(1);

    const awaitInExclusiveBranch = analyze(
      "fixture/exclusive-branch.ts",
      `import { awaitChaosLatency, evaluateChaos } from "./chaos.js";
       export async function handler(flag: boolean) {
         if (flag) {
           await awaitChaosLatency();
           return null;
         }
         return evaluateChaos();
       }`,
    );
    expect(awaitInExclusiveBranch.offenders.length).toBe(1);

    // --- the shapes the previous, positional rule still admitted -----------

    // An UNBRACED `if` owns its await via the IfStatement, which sits in the
    // block — so it used to dominate every later roll in that block.
    const unbracedConditionalAwait = analyze(
      "fixture/unbraced-if.ts",
      `import { awaitChaosLatency, evaluateChaos } from "./chaos.js";
       export async function handler(flag: boolean) {
         if (flag) await awaitChaosLatency();
         return evaluateChaos();
       }`,
    );
    expect(unbracedConditionalAwait.offenders.length).toBe(1);

    // Same hole in its other dress: a short-circuited await.
    const shortCircuitAwait = analyze(
      "fixture/short-circuit.ts",
      `import { awaitChaosLatency, evaluateChaos } from "./chaos.js";
       export async function handler(flag: boolean) {
         flag && (await awaitChaosLatency());
         return evaluateChaos();
       }`,
    );
    expect(shortCircuitAwait.offenders.length).toBe(1);

    // And inside a loop body, which may execute zero times.
    const loopBodyAwait = analyze(
      "fixture/loop-await.ts",
      `import { awaitChaosLatency, evaluateChaos } from "./chaos.js";
       export async function handler(items: number[]) {
         for (const item of items) { void item; await awaitChaosLatency(); }
         return evaluateChaos();
       }`,
    );
    expect(loopBodyAwait.offenders.length).toBe(1);

    // ONE module-level await used to satisfy every roll in the file.
    const moduleLevelAwait = analyze(
      "fixture/top-level-await.ts",
      `import { awaitChaosLatency, evaluateChaos } from "./chaos.js";
       await awaitChaosLatency();
       export function handler() { return evaluateChaos(); }
       export function other() { return evaluateChaos(); }`,
    );
    expect(moduleLevelAwait.offenders.length).toBe(2);

    // A hoisted `function` declaration can be called BEFORE the await that
    // textually precedes it.
    const hoistedFunctionRoll = analyze(
      "fixture/hoisted.ts",
      `import { awaitChaosLatency, responseUnwritable, evaluateChaos } from "./chaos.js";
       export async function handler(res: unknown) {
         const early = rollNow();
         await awaitChaosLatency(res);
         if (responseUnwritable(res)) return null;
         function rollNow() { return evaluateChaos(); }
         return early;
       }`,
    );
    expect(hoistedFunctionRoll.offenders.length).toBe(1);

    // `applyChaosAsync` rolls the dice even when nobody awaits it.
    const unawaitedAsyncRoll = analyze(
      "fixture/unawaited-async.ts",
      `import { applyChaosAsync } from "./chaos.js";
       export function handler(res: unknown) { void applyChaosAsync(res); }`,
    );
    expect(unawaitedAsyncRoll.offenders.length).toBe(1);

    const awaitedAsyncRoll = analyze(
      "fixture/awaited-async.ts",
      `import { applyChaosAsync } from "./chaos.js";
       export async function handler(res: unknown) { await applyChaosAsync(res); }`,
    );
    expect(awaitedAsyncRoll.offenders).toEqual([]);

    // Binding / export escapes.
    const localReExport = analyze(
      "fixture/local-reexport.ts",
      `import { applyChaosAction } from "./chaos.js";
       export { applyChaosAction };`,
    );
    expect(localReExport.offenders.length).toBe(1);

    const forwardingReExport = analyze(
      "fixture/forwarding-reexport.ts",
      `export { applyChaosAction } from "./chaos.js";`,
    );
    expect(forwardingReExport.offenders).toEqual([]);

    const namespaceAliasEscape = analyze(
      "fixture/namespace-alias.ts",
      `import * as chaos from "./chaos.js";
       export const c = chaos;`,
    );
    expect(namespaceAliasEscape.offenders.length).toBe(1);

    const namespaceIndexEscape = analyze(
      "fixture/namespace-index.ts",
      `import * as chaos from "./chaos.js";
       export function handler(name: string) { return chaos[name]; }`,
    );
    expect(namespaceIndexEscape.offenders.length).toBe(1);

    const defaultImportRoll = analyze(
      "fixture/default-import.ts",
      `import chaosNs from "./chaos.js";
       export function handler() { return chaosNs.evaluateChaos(); }`,
    );
    expect(defaultImportRoll.offenders.length).toBe(1);

    const asyncRollEscape = analyze(
      "fixture/async-escape.ts",
      `import { applyChaosAsync } from "./chaos.js";
       export const deferred = applyChaosAsync;`,
    );
    expect(asyncRollEscape.offenders.length).toBe(1);

    // C10: the dominating await must be handed the SAME response the roll
    // writes to, or the delay is not cancellable on that client's hangup.
    const wrongResponseThreaded = analyze(
      "fixture/wrong-res.ts",
      `import { awaitChaosLatency, responseUnwritable, applyChaosAction } from "./chaos.js";
       export async function handler(res: unknown, other: unknown) {
         await awaitChaosLatency(other);
         if (responseUnwritable(res)) return;
         applyChaosAction("drop", res);
       }`,
    );
    expect(wrongResponseThreaded.offenders.length).toBe(1);

    // C13: a split gate must re-check writability after the await.
    const missingWritabilityRecheck = analyze(
      "fixture/no-recheck.ts",
      `import { awaitChaosLatency, applyChaosAction } from "./chaos.js";
       export async function handler(res: unknown) {
         await awaitChaosLatency(res);
         applyChaosAction("drop", res);
       }`,
    );
    expect(missingWritabilityRecheck.offenders.length).toBe(1);

    // The re-check has to come AFTER the await, not before it.
    const recheckBeforeTheAwait = analyze(
      "fixture/recheck-too-early.ts",
      `import { awaitChaosLatency, responseUnwritable, applyChaosAction } from "./chaos.js";
       export async function handler(res: unknown) {
         if (responseUnwritable(res)) return;
         await awaitChaosLatency(res);
         applyChaosAction("drop", res);
       }`,
    );
    expect(recheckBeforeTheAwait.offenders.length).toBe(1);

    // Types are erased: a type query cannot roll anything.
    const typeQueryOnly = analyze(
      "fixture/type-query.ts",
      `import { applyChaos } from "./chaos.js";
       export type RollFn = typeof applyChaos;
       export type RollArgs = Parameters<typeof applyChaos>;`,
    );
    expect(typeQueryOnly.offenders).toEqual([]);

    const typeOnlyImport = analyze(
      "fixture/type-only-import.ts",
      `import type { applyChaos } from "./chaos.js";
       export type RollFn = typeof applyChaos;`,
    );
    expect(typeOnlyImport.offenders).toEqual([]);

    const unparseable = analyze("fixture/broken.ts", `export function (((`);
    expect(unparseable.parseErrors.length).toBeGreaterThan(0);
  });
});
