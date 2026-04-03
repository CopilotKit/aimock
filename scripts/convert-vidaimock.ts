#!/usr/bin/env tsx

/**
 * VidaiMock -> aimock Fixture Converter
 *
 * Reads VidaiMock Tera template files (single file or directory) and produces
 * aimock-compatible fixture JSON.
 *
 * Usage:
 *   npx tsx scripts/convert-vidaimock.ts <input-path> [output-path]
 *
 * - If <input-path> is a directory, every .tera / .json / .txt file inside it
 *   is treated as a VidaiMock response template.
 * - If <input-path> is a single file, only that file is converted.
 * - [output-path] defaults to stdout when omitted; pass a path to write JSON
 *   to a file instead.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename, extname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AimockFixture {
  match: { userMessage: string };
  response: { content: string };
}

export interface AimockFixtureFile {
  fixtures: AimockFixture[];
}

// ---------------------------------------------------------------------------
// Tera template stripping
// ---------------------------------------------------------------------------

/**
 * Strip Tera template syntax and extract a usable response content string.
 *
 * Strategy:
 * 1. If the template looks like JSON, try to pull out the nested
 *    `choices[].message.content` value (the most common VidaiMock pattern).
 * 2. Otherwise fall back to stripping all Tera delimiters and returning the
 *    remaining text with placeholder variable names.
 */
export function stripTeraTemplate(raw: string): string {
  const trimmed = raw.trim();

  // --- Attempt JSON extraction first -----------------------------------
  const contentValue = extractJsonContent(trimmed);
  if (contentValue !== null) return contentValue;

  // --- Fallback: strip Tera syntax -------------------------------------
  let text = trimmed;

  // Remove comment blocks {# ... #}
  text = text.replace(/\{#[\s\S]*?#\}/g, "");

  // Remove block tags {% ... %}
  text = text.replace(/\{%[\s\S]*?%\}/g, "");

  // Replace expression tags {{ expr }} with the expression name
  text = text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, "[$1]");

  // Collapse excessive whitespace but preserve intentional newlines
  text = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");

  return text;
}

/**
 * Try to parse the template as JSON (after substituting Tera expressions with
 * dummy strings) and pull out `choices[0].message.content`.
 */
function extractJsonContent(raw: string): string | null {
  try {
    // Step 1: remove Tera comments and blocks
    let substituted = raw.replace(/\{#[\s\S]*?#\}/g, "").replace(/\{%[\s\S]*?%\}/g, "");

    // Step 2: Replace Tera expressions inside existing JSON strings.
    // Pattern: the expression is already within quotes, e.g. "foo-{{ bar }}-baz"
    // We replace the {{ ... }} with the placeholder without adding extra quotes.
    substituted = substituted.replace(
      /"([^"]*?)\{\{\s*([\w.]+)\s*\}\}([^"]*?)"/g,
      (_, before, varName, after) => `"${before}[${varName}]${after}"`,
    );

    // Step 3: Replace standalone Tera expressions (not inside quotes),
    // e.g. a bare `{{ content }}` used as a JSON value — wrap with quotes.
    substituted = substituted.replace(/\{\{\s*([\w.]+)\s*\}\}/g, '"[$1]"');

    const parsed = JSON.parse(substituted);

    if (
      parsed &&
      Array.isArray(parsed.choices) &&
      parsed.choices.length > 0 &&
      parsed.choices[0]?.message?.content !== undefined
    ) {
      return String(parsed.choices[0].message.content);
    }
  } catch {
    // Not valid JSON even after substitution — fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filename -> match derivation
// ---------------------------------------------------------------------------

/**
 * Derive a `userMessage` match string from the template filename.
 *
 * Examples:
 *   "greeting.tera"       -> "greeting"
 *   "tell_me_a_joke.json" -> "tell me a joke"
 *   "003-weather.txt"     -> "weather"
 */
export function deriveMatchFromFilename(filename: string): string {
  let name = basename(filename, extname(filename));

  // Strip leading numeric prefixes like "003-"
  name = name.replace(/^\d+[-_]/, "");

  // Replace underscores / hyphens with spaces
  name = name.replace(/[-_]+/g, " ");

  return name.trim();
}

// ---------------------------------------------------------------------------
// File / directory conversion
// ---------------------------------------------------------------------------

const TEMPLATE_EXTENSIONS = new Set([
  ".tera",
  ".json",
  ".txt",
  ".html",
  ".jinja",
  ".jinja2",
  ".j2",
]);

export function convertFile(filePath: string): AimockFixture | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const content = stripTeraTemplate(raw);
    if (!content) return null;

    const match = deriveMatchFromFilename(filePath);
    return { match: { userMessage: match }, response: { content } };
  } catch {
    // Unreadable / binary file — skip gracefully
    return null;
  }
}

export function convertDirectory(dirPath: string): AimockFixture[] {
  const fixtures: AimockFixture[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return fixtures;
  }

  for (const entry of entries.sort()) {
    const fullPath = resolve(dirPath, entry);
    try {
      if (!statSync(fullPath).isFile()) continue;
    } catch {
      continue;
    }

    const ext = extname(entry).toLowerCase();
    if (!TEMPLATE_EXTENSIONS.has(ext)) continue;

    const fixture = convertFile(fullPath);
    if (fixture) fixtures.push(fixture);
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("Usage: npx tsx scripts/convert-vidaimock.ts <input-path> [output-path]");
    process.exit(1);
  }

  const inputPath = resolve(args[0]);
  const outputPath = args[1] ? resolve(args[1]) : null;

  let fixtures: AimockFixture[];

  try {
    const stat = statSync(inputPath);
    if (stat.isDirectory()) {
      fixtures = convertDirectory(inputPath);
    } else {
      const single = convertFile(inputPath);
      fixtures = single ? [single] : [];
    }
  } catch (err) {
    console.error(`Error reading input path: ${inputPath}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (fixtures.length === 0) {
    console.error(
      "No fixtures produced — check that the input contains valid VidaiMock templates.",
    );
    process.exit(1);
  }

  const output: AimockFixtureFile = { fixtures };
  const json = JSON.stringify(output, null, 2) + "\n";

  if (outputPath) {
    writeFileSync(outputPath, json, "utf-8");
    console.log(`Wrote ${fixtures.length} fixture(s) to ${outputPath}`);
  } else {
    process.stdout.write(json);
  }
}

// Only run CLI when executed directly (not when imported by tests)
const isDirectExecution =
  process.argv[1]?.endsWith("convert-vidaimock.ts") ||
  process.argv[1]?.endsWith("convert-vidaimock.js");

if (isDirectExecution) {
  main();
}
