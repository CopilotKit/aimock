#!/usr/bin/env tsx

/**
 * mock-llm (dwmkerr) -> aimock fixture converter
 *
 * Parses mock-llm YAML config files and produces aimock fixture JSON.
 *
 * Usage:
 *   npx tsx scripts/convert-mockllm.ts <input.yaml> [output.json]
 *
 * If output is omitted, prints to stdout.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Minimal YAML parser
// ---------------------------------------------------------------------------
// Handles the subset used by mock-llm configs: indented maps, arrays with
// `-` prefix, quoted/unquoted strings, numbers, booleans, and null.
// Does NOT handle: anchors, aliases, multi-line scalars, flow collections,
// tags, or other advanced YAML features.

interface YamlLine {
  indent: number;
  raw: string;
  content: string; // trimmed, without trailing comment
  isArrayItem: boolean;
  arrayItemContent: string; // content after "- "
}

function tokenizeYamlLines(input: string): YamlLine[] {
  const lines: YamlLine[] = [];
  for (const raw of input.split("\n")) {
    // Skip blank lines and full-line comments
    const trimmed = raw.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = raw.length - raw.trimStart().length;
    // Strip trailing comments (but not inside quoted strings)
    const content = stripTrailingComment(trimmed);
    const isArrayItem = content.startsWith("- ");
    const arrayItemContent = isArrayItem ? content.slice(2).trim() : "";

    lines.push({ indent, raw, content, isArrayItem, arrayItemContent });
  }
  return lines;
}

function stripTrailingComment(s: string): string {
  // Naive: find # not inside quotes
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble && i > 0 && s[i - 1] === " ") {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function parseScalar(value: string): unknown {
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;

  // Quoted string
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  // Number
  const num = Number(value);
  if (!Number.isNaN(num) && value !== "") return num;

  // Unquoted string
  return value;
}

export function parseSimpleYaml(input: string): unknown {
  const lines = tokenizeYamlLines(input);
  if (lines.length === 0) return null;

  const result = parseBlock(lines, 0, 0);
  return result.value;
}

interface ParseResult {
  value: unknown;
  nextIndex: number;
}

function parseBlock(lines: YamlLine[], startIndex: number, minIndent: number): ParseResult {
  if (startIndex >= lines.length) {
    return { value: null, nextIndex: startIndex };
  }

  const line = lines[startIndex];

  // Determine if this block is an array or a map
  if (line.isArrayItem && line.indent >= minIndent) {
    return parseArray(lines, startIndex, line.indent);
  }

  // Map
  if (line.content.includes(":")) {
    return parseMap(lines, startIndex, line.indent);
  }

  // Single scalar
  return { value: parseScalar(line.content), nextIndex: startIndex + 1 };
}

function parseArray(lines: YamlLine[], startIndex: number, baseIndent: number): ParseResult {
  const arr: unknown[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) break; // shouldn't happen at array level
    if (!line.isArrayItem) break;

    const itemContent = line.arrayItemContent;

    if (itemContent === "") {
      // Array item with nested block on next lines
      const nested = parseBlock(lines, i + 1, baseIndent + 1);
      arr.push(nested.value);
      i = nested.nextIndex;
    } else if (itemContent.includes(":")) {
      // Inline map start: "- key: value" possibly with more keys below
      // Parse as a map, treating the "- " offset as extra indent
      const inlineMap = parseArrayItemMap(lines, i, baseIndent);
      arr.push(inlineMap.value);
      i = inlineMap.nextIndex;
    } else {
      // Simple scalar array item
      arr.push(parseScalar(itemContent));
      i++;
    }
  }

  return { value: arr, nextIndex: i };
}

function parseArrayItemMap(
  lines: YamlLine[],
  startIndex: number,
  arrayIndent: number,
): ParseResult {
  // First line is "- key: value", subsequent lines at indent > arrayIndent are part of this map
  const map: Record<string, unknown> = {};
  const firstLine = lines[startIndex];
  const firstContent = firstLine.arrayItemContent;

  // Parse the first key: value from the array item line
  const colonIdx = findColon(firstContent);
  if (colonIdx === -1) {
    return { value: parseScalar(firstContent), nextIndex: startIndex + 1 };
  }

  const key = firstContent.slice(0, colonIdx).trim();
  const valueStr = firstContent.slice(colonIdx + 1).trim();

  if (valueStr === "") {
    // Value is a nested block
    const nested = parseBlock(lines, startIndex + 1, arrayIndent + 2);
    map[key] = nested.value;
    let i = nested.nextIndex;

    // Continue reading sibling keys at the array-item's content indent
    const siblingIndent = arrayIndent + 2;
    while (i < lines.length && lines[i].indent >= siblingIndent && !lines[i].isArrayItem) {
      if (lines[i].indent === siblingIndent || lines[i].indent > siblingIndent) {
        // Only parse if at exactly sibling indent and is a map key
        if (lines[i].indent === siblingIndent && lines[i].content.includes(":")) {
          const mapResult = parseMapEntries(lines, i, siblingIndent, map);
          i = mapResult.nextIndex;
        } else {
          break;
        }
      }
    }

    return { value: map, nextIndex: i };
  } else {
    map[key] = parseScalar(valueStr);
  }

  // Read additional keys at indent > arrayIndent (the "  key: value" lines after "- first: val")
  let i = startIndex + 1;
  const contentIndent = arrayIndent + 2; // "- " adds 2 to effective indent

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < contentIndent) break;
    if (line.isArrayItem && line.indent <= arrayIndent) break;

    if (line.indent === contentIndent && !line.isArrayItem && line.content.includes(":")) {
      const colonPos = findColon(line.content);
      if (colonPos === -1) break;
      const k = line.content.slice(0, colonPos).trim();
      const v = line.content.slice(colonPos + 1).trim();

      if (v === "") {
        const nested = parseBlock(lines, i + 1, contentIndent + 1);
        map[k] = nested.value;
        i = nested.nextIndex;
      } else {
        map[k] = parseScalar(v);
        i++;
      }
    } else if (line.indent === contentIndent && line.isArrayItem) {
      // This is a new array item at the same level -- not part of this map
      break;
    } else if (line.indent > contentIndent) {
      // Skip nested content already consumed
      i++;
    } else {
      break;
    }
  }

  return { value: map, nextIndex: i };
}

function parseMap(lines: YamlLine[], startIndex: number, baseIndent: number): ParseResult {
  const map: Record<string, unknown> = {};
  const result = parseMapEntries(lines, startIndex, baseIndent, map);
  return { value: map, nextIndex: result.nextIndex };
}

function parseMapEntries(
  lines: YamlLine[],
  startIndex: number,
  baseIndent: number,
  map: Record<string, unknown>,
): ParseResult {
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) {
      // Shouldn't happen at map level if properly structured -- skip
      i++;
      continue;
    }
    if (line.isArrayItem) break;

    const colonIdx = findColon(line.content);
    if (colonIdx === -1) {
      // Not a map entry
      break;
    }

    const key = line.content.slice(0, colonIdx).trim();
    const valueStr = line.content.slice(colonIdx + 1).trim();

    if (valueStr === "") {
      // Value is a nested block on subsequent lines
      const nested = parseBlock(lines, i + 1, baseIndent + 1);
      map[key] = nested.value;
      i = nested.nextIndex;
    } else {
      map[key] = parseScalar(valueStr);
      i++;
    }
  }

  return { value: map, nextIndex: i };
}

function findColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ":" && !inSingle && !inDouble) {
      // Must be followed by space, end of line, or nothing
      if (i === s.length - 1 || s[i + 1] === " ") {
        return i;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// mock-llm config types
// ---------------------------------------------------------------------------

export interface MockLLMRoute {
  path: string;
  method?: string;
  match?: {
    body?: {
      messages?: Array<{ role: string; content: string }>;
    };
  };
  response: Record<string, unknown>;
}

export interface MockLLMTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface MockLLMConfig {
  routes?: MockLLMRoute[];
  mcp?: {
    tools?: MockLLMTool[];
  };
}

// ---------------------------------------------------------------------------
// aimock output types
// ---------------------------------------------------------------------------

export interface AimockFixture {
  match?: { userMessage?: string };
  response: { content?: string; toolCalls?: Array<{ name: string; arguments: string }> };
  _comment?: string;
}

export interface AimockMCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ConvertResult {
  fixtures: AimockFixture[];
  mcpTools?: AimockMCPTool[];
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------

export function convertConfig(config: MockLLMConfig): ConvertResult {
  const fixtures: AimockFixture[] = [];

  if (config.routes) {
    for (const route of config.routes) {
      const fixture = convertRoute(route);
      if (fixture) {
        fixtures.push(fixture);
      }
    }
  }

  const result: ConvertResult = { fixtures };

  if (config.mcp?.tools && config.mcp.tools.length > 0) {
    result.mcpTools = config.mcp.tools.map(convertMCPTool);
  }

  return result;
}

function convertRoute(route: MockLLMRoute): AimockFixture | null {
  // Extract content from response.choices[0].message.content
  const content = extractResponseContent(route.response);
  if (content === null) return null;

  const fixture: AimockFixture = {
    match: {},
    response: { content },
  };

  // Extract match criteria from match.body.messages
  const userMessage = extractUserMessage(route);
  if (userMessage) {
    fixture.match = { userMessage };
  } else {
    // Use path as a comment/identifier when no match criteria
    fixture._comment = `${route.method ?? "POST"} ${route.path}`;
  }

  return fixture;
}

function extractResponseContent(response: Record<string, unknown>): string | null {
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const firstChoice = choices[0];
  const message = firstChoice.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = message.content;
  if (typeof content !== "string") return null;

  return content;
}

function extractUserMessage(route: MockLLMRoute): string | null {
  const messages = route.match?.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i].content;
    }
  }

  // Fall back to last message content regardless of role
  return messages[messages.length - 1].content ?? null;
}

function convertMCPTool(tool: MockLLMTool): AimockMCPTool {
  const result: AimockMCPTool = { name: tool.name };
  if (tool.description) result.description = tool.description;
  if (tool.parameters) result.inputSchema = tool.parameters;
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: npx tsx scripts/convert-mockllm.ts <input.yaml> [output.json]

Converts a mock-llm (dwmkerr) YAML config to aimock fixture JSON.

If output path is omitted, prints JSON to stdout.`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const inputPath = resolve(args[0]);
  const outputPath = args[1] ? resolve(args[1]) : null;

  let yamlContent: string;
  try {
    yamlContent = readFileSync(inputPath, "utf-8");
  } catch (err) {
    console.error(`Error reading input file: ${(err as Error).message}`);
    process.exit(1);
  }

  const parsed = parseSimpleYaml(yamlContent) as MockLLMConfig | null;
  if (!parsed || typeof parsed !== "object") {
    console.error("Error: could not parse YAML config");
    process.exit(1);
  }

  const result = convertConfig(parsed);

  // Build aimock fixture file
  const fixtureOutput = { fixtures: result.fixtures };
  const fixtureJson = JSON.stringify(fixtureOutput, null, 2);

  if (outputPath) {
    writeFileSync(outputPath, fixtureJson + "\n", "utf-8");
    console.log(`Wrote fixtures to ${outputPath}`);

    // If MCP tools present, write a companion aimock.json config
    if (result.mcpTools) {
      const configPath = outputPath.replace(/\.json$/, ".aimock.json");
      const aimockConfig = {
        llm: { fixtures: outputPath },
        mcp: {
          tools: result.mcpTools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? {},
            result: `Mock result for ${t.name}`,
          })),
        },
      };
      writeFileSync(configPath, JSON.stringify(aimockConfig, null, 2) + "\n", "utf-8");
      console.log(`Wrote aimock config with MCP tools to ${configPath}`);
    }
  } else {
    console.log(fixtureJson);

    if (result.mcpTools) {
      console.log("\n--- MCP Tools (aimock config format) ---");
      console.log(JSON.stringify({ mcp: { tools: result.mcpTools } }, null, 2));
    }
  }
}

// Only run CLI when executed directly (not imported)
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("convert-mockllm.ts") ||
    process.argv[1].endsWith("convert-mockllm.js"));

if (isDirectRun) {
  main();
}
