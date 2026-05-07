#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, basename } from "node:path";
import { loadConfig, startFromConfig } from "./config-loader.js";
import { runConvertCli, type ConvertCliDeps } from "./convert.js";

const HELP = `
Usage: aimock [options]
       aimock convert <format> <input> [output]

Options:
  -c, --config <path>   Path to aimock config JSON file (required)
  -p, --port <number>   Port override (default: from config or 0)
  -h, --host <string>   Host override (default: from config or 127.0.0.1)
      --help            Show this help message

Subcommands:
  convert               Convert third-party mock configs to aimock format
                        Run "aimock convert --help" for details
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

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        config: { type: "string", short: "c" },
        port: { type: "string", short: "p" },
        host: { type: "string", short: "h" },
        help: { type: "boolean", default: false },
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
  if (!values.config) {
    logError("Error: --config is required.\n\n" + HELP);
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

  const port = values.port ? Number(values.port) : undefined;
  if (
    port !== undefined &&
    (Number.isNaN(port) || !Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    logError(`Error: invalid port "${values.port}".\n\n${HELP}`);
    exit(1);
    return;
  }
  const host = values.host;

  async function main() {
    const { llmock, url } = await startFromConfigFn(config!, { port, host });
    log(`aimock server listening on ${url}`);

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
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

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
const scriptName = process.argv[1] ?? "";
const base = basename(scriptName);
if (base === "aimock" || base === "aimock-cli.js" || base === "aimock-cli.ts") {
  runAimockCli();
}
/* v8 ignore stop */
