/**
 * CLI dispatcher for `aimock convert` subcommands.
 *
 * Delegates to the converter modules in src/convert-vidaimock.ts and
 * src/convert-mockllm.ts.
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { convertFile, convertDirectory, type AimockFixtureFile } from "./convert-vidaimock.js";
import { parseSimpleYaml, convertConfig, type MockLLMConfig } from "./convert-mockllm.js";

const CONVERT_HELP = `
Usage: aimock convert <format> <input> [output]

Formats:
  vidaimock    Convert VidaiMock Tera templates to aimock JSON
  mockllm      Convert mock-llm YAML config to aimock JSON

Examples:
  aimock convert vidaimock ./templates/ ./fixtures/vidaimock.json
  aimock convert mockllm ./config.yaml ./fixtures/converted.json
`.trim();

export interface ConvertCliDeps {
  argv: string[];
  log: (msg: string) => void;
  logError: (msg: string) => void;
  exit: (code: number) => void;
}

export function runConvertCli(deps: ConvertCliDeps): void {
  const { argv, log, logError, exit } = deps;

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length === 0) {
      logError(CONVERT_HELP);
      exit(1);
    } else {
      log(CONVERT_HELP);
      exit(0);
    }
    return;
  }

  const format = argv[0];
  const inputArg = argv[1];
  const outputArg = argv[2];

  if (!inputArg) {
    logError(`Error: missing <input> argument.\n\n${CONVERT_HELP}`);
    exit(1);
    return;
  }

  switch (format) {
    case "vidaimock":
      runVidaimockConvert(inputArg, outputArg, { log, logError, exit });
      break;
    case "mockllm":
      runMockllmConvert(inputArg, outputArg, { log, logError, exit });
      break;
    default:
      logError(`Error: unknown format "${format}".\n\n${CONVERT_HELP}`);
      exit(1);
  }
}

// ---------------------------------------------------------------------------
// VidaiMock converter
// ---------------------------------------------------------------------------

function runVidaimockConvert(
  inputArg: string,
  outputArg: string | undefined,
  io: { log: (msg: string) => void; logError: (msg: string) => void; exit: (code: number) => void },
): void {
  const inputPath = resolve(inputArg);
  const outputPath = outputArg ? resolve(outputArg) : null;

  let fixtures: AimockFixtureFile["fixtures"];

  try {
    const stat = statSync(inputPath);
    if (stat.isDirectory()) {
      fixtures = convertDirectory(inputPath);
    } else {
      const single = convertFile(inputPath);
      fixtures = single ? [single] : [];
    }
  } catch (err) {
    io.logError(`Error reading input path: ${inputPath}`);
    io.logError(err instanceof Error ? err.message : String(err));
    io.exit(1);
    return;
  }

  if (fixtures.length === 0) {
    io.logError("No fixtures produced — check that the input contains valid VidaiMock templates.");
    io.exit(1);
    return;
  }

  const output: AimockFixtureFile = { fixtures };
  const json = JSON.stringify(output, null, 2) + "\n";

  if (outputPath) {
    try {
      writeFileSync(outputPath, json, "utf-8");
    } catch (err) {
      io.logError(`Error writing output: ${(err as Error).message}`);
      io.exit(1);
      return;
    }
    io.log(`Wrote ${fixtures.length} fixture(s) to ${outputPath}`);
  } else {
    io.log(json.trimEnd());
  }
}

// ---------------------------------------------------------------------------
// mock-llm converter
// ---------------------------------------------------------------------------

function runMockllmConvert(
  inputArg: string,
  outputArg: string | undefined,
  io: { log: (msg: string) => void; logError: (msg: string) => void; exit: (code: number) => void },
): void {
  const inputPath = resolve(inputArg);
  const outputPath = outputArg ? resolve(outputArg) : null;

  let yamlContent: string;
  try {
    yamlContent = readFileSync(inputPath, "utf-8");
  } catch (err) {
    io.logError(`Error reading input file: ${(err as Error).message}`);
    io.exit(1);
    return;
  }

  const parsed = parseSimpleYaml(yamlContent) as MockLLMConfig | null;
  if (!parsed || typeof parsed !== "object") {
    io.logError("Error: could not parse YAML config");
    io.exit(1);
    return;
  }

  const result = convertConfig(parsed);
  const fixtureJson = JSON.stringify({ fixtures: result.fixtures }, null, 2);

  if (outputPath) {
    try {
      writeFileSync(outputPath, fixtureJson + "\n", "utf-8");
    } catch (err) {
      io.logError(`Error writing output: ${(err as Error).message}`);
      io.exit(1);
      return;
    }
    io.log(`Wrote fixtures to ${outputPath}`);

    if (result.mcpTools) {
      const configPath = outputPath.endsWith(".json")
        ? outputPath.replace(/\.json$/, ".aimock.json")
        : outputPath + ".aimock.json";
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
      try {
        writeFileSync(configPath, JSON.stringify(aimockConfig, null, 2) + "\n", "utf-8");
      } catch (err) {
        io.logError(`Error writing config: ${(err as Error).message}`);
        io.exit(1);
        return;
      }
      io.log(`Wrote aimock config with MCP tools to ${configPath}`);
    }
  } else {
    io.log(fixtureJson);

    if (result.mcpTools) {
      io.log("\n--- MCP Tools (aimock config format) ---");
      io.log(JSON.stringify({ mcp: { tools: result.mcpTools } }, null, 2));
    }
  }
}
