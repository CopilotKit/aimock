#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, basename } from "node:path";
import { loadConfig, startFromConfig, type StartFromConfigOverrides } from "./config-loader.js";
import { runConvertCli, type ConvertCliDeps } from "./convert.js";
import { runValidateCli } from "./validate-cli.js";

const HELP = `
Usage: aimock [options]
       aimock convert <format> <input> [output]
       aimock validate [--strict] [--json] [--] <path> [more paths ...]

Options:
  -c, --config <path>   Path to aimock config JSON file (required)
  -p, --port <number>   Port override (default: from config or 0)
      --host <string>   Host override (default: from config or 127.0.0.1)
      --misbehavior     Enable model misbehavior (same as llm.enableMisbehavior: true)
      --strict-tool-arguments  Reject fixture tool calls with invalid JSON arguments
                        instead of serving {} (same as llm.strictToolArguments: true)
      --responses-tools <mode>  OpenAI Responses tool handling: legacy (default) or
                        extended (overrides llm.responsesTools)
  -h, --help            Show this help message

Subcommands:
  convert               Convert third-party mock configs to aimock format
                        Run "aimock convert --help" for details
  validate              Validate fixture files or directories offline
                        Run "aimock validate --help" for details
`.trim();

export interface AimockCliDeps {
  argv?: string[];
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  exit?: (code: number) => void;
  loadConfigFn?: typeof loadConfig;
  startFromConfigFn?: typeof startFromConfig;
  onReady?: (ctx: { shutdown: () => void }) => void;
  convertDeps?: Partial<ConvertCliDeps>;
  validateDeps?: {
    log?: (msg: string) => void;
    logError?: (msg: string) => void;
    exit?: (code: number) => void;
  };
}

export function runAimockCli(deps: AimockCliDeps = {}): void {
  /* v8 ignore next 6 -- defaults used only when called from CLI entry point */
  const argv = deps.argv ?? process.argv.slice(2);
  const log = deps.log ?? console.log.bind(console);
  const logError = deps.logError ?? console.error.bind(console);
  const exit = deps.exit ?? process.exit.bind(process);
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const startFromConfigFn = deps.startFromConfigFn ?? startFromConfig;

  // Intercept "convert" subcommand before parseArgs (which uses strict mode)
  if (argv[0] === "convert") {
    runConvertCli({
      argv: argv.slice(1),
      log,
      logError,
      exit,
      ...deps.convertDeps,
    });
    return;
  }

  // Intercept "validate" the same way — it takes file paths, not --config.
  if (argv[0] === "validate") {
    runValidateCli({
      argv: argv.slice(1),
      log: deps.validateDeps?.log ?? log,
      logError: deps.validateDeps?.logError ?? logError,
      exit: deps.validateDeps?.exit ?? exit,
    });
    return;
  }

  // Short-flag rule for the `aimock` bin: a short flag means the same thing at
  // the top level and in every subcommand. `-h` is `--help` everywhere, which
  // is what `convert` (src/convert.ts) and `validate` (src/validate-cli.ts)
  // already did and what a reader typing `aimock -h` expects; the host
  // override is long-form `--host` only, and had no documented short use.
  // Short flags are per-bin: the separate `llmock` bin (src/cli.ts, the
  // Docker ENTRYPOINT) keeps its own documented set, where `-h` is `--host`
  // and `-c` is `--chunk-size`.
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        config: { type: "string", short: "c" },
        port: { type: "string", short: "p" },
        host: { type: "string" },
        misbehavior: { type: "boolean", default: false },
        "strict-tool-arguments": { type: "boolean", default: false },
        "responses-tools": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }));
  } catch (err) {
    /* v8 ignore next -- parseArgs always throws Error subclasses */
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Error: ${msg}\n\n${HELP}`);
    exit(1);
    return;
  }

  if (values.help) {
    log(HELP);
    exit(0);
    return;
  }
  if (values.config === undefined) {
    logError("Error: --config is required.\n\n" + HELP);
    exit(1);
    return;
  }
  // A value-taking option that was GIVEN an empty (or blank) value is a usage
  // error, not an absent option. Testing these for truthiness instead let
  // `--config ""` read as "not given", and let `--port ""` / `--host ""` be
  // dropped in silence — `--host ""` in particular reached the server as an
  // empty bind address, which listens on every interface rather than on the
  // documented 127.0.0.1 default.
  const blank = (
    [
      ["config", values.config],
      ["port", values.port],
      ["host", values.host],
      ["responses-tools", values["responses-tools"]],
    ] as const
  ).find(([, value]) => value !== undefined && value.trim() === "");
  if (blank !== undefined) {
    logError(`Error: --${blank[0]} requires a non-empty value.\n\n${HELP}`);
    exit(1);
    return;
  }

  const configPath = resolve(values.config);
  let config;
  try {
    config = loadConfigFn(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Failed to load config from ${configPath}: ${msg}`);
    exit(1);
    return;
  }

  const port = values.port === undefined ? undefined : Number(values.port);
  if (
    port !== undefined &&
    (Number.isNaN(port) || !Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    logError(`Error: invalid port "${values.port}".\n\n${HELP}`);
    exit(1);
    return;
  }
  const host = values.host;
  const responsesToolsFlag = values["responses-tools"];
  if (
    responsesToolsFlag !== undefined &&
    responsesToolsFlag !== "legacy" &&
    responsesToolsFlag !== "extended"
  ) {
    logError(
      `Error: invalid --responses-tools "${responsesToolsFlag}" (expected "legacy" or "extended").\n\n${HELP}`,
    );
    exit(1);
    return;
  }
  // The boolean opt-ins override the config only when given, so an absent flag
  // leaves llm.enableMisbehavior / llm.strictToolArguments in charge.
  const responsesTools: StartFromConfigOverrides["responsesTools"] = responsesToolsFlag;
  const overrides: StartFromConfigOverrides = {
    port,
    host,
    ...(values.misbehavior ? { enableMisbehavior: true } : {}),
    ...(values["strict-tool-arguments"] ? { strictToolArguments: true } : {}),
    ...(responsesTools !== undefined ? { responsesTools } : {}),
  };

  async function main() {
    const { llmock, url } = await startFromConfigFn(config!, overrides);

    function shutdown() {
      log("Shutting down...");
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      llmock.stop().then(
        () => exit(0),
        (err) => {
          logError(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
          exit(1);
        },
      );
    }
    // Register BEFORE announcing readiness — see the note in src/cli.ts. A supervisor
    // that reacts to the readiness line must never win a race against this listener.
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    log(`aimock server listening on ${url}`);

    if (deps.onReady) {
      deps.onReady({ shutdown });
    }
  }

  main().catch((err) => {
    logError(err instanceof Error ? err.message : String(err));
    exit(1);
  });
}

// Run when executed as a script (not when imported for testing).
/* v8 ignore start -- entry-point guard, exercised by integration tests */
// The basenames this module is ever argv[1] under: the `aimock` bin (the
// package.json "bin" name), both build outputs — tsdown.config.ts builds
// src/aimock-cli.ts in "esm" AND "cjs" format, which under `"type": "module"`
// emits dist/aimock-cli.js and dist/aimock-cli.cjs — and the TypeScript
// source, run through tsx. Omitting the .cjs made `node dist/aimock-cli.cjs`
// print nothing and exit 0 despite its shebang and exec bit.
const ENTRY_BASENAMES = new Set(["aimock", "aimock-cli.js", "aimock-cli.cjs", "aimock-cli.ts"]);
const scriptName = process.argv[1] ?? "";
if (ENTRY_BASENAMES.has(basename(scriptName))) {
  runAimockCli();
}
/* v8 ignore stop */
