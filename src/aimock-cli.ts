#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig, startFromConfig } from "./config-loader.js";

const HELP = `
Usage: aimock [options]

Options:
  -c, --config <path>   Path to aimock config JSON file (required)
  -p, --port <number>   Port override (default: from config or 0)
  -h, --host <string>   Host override (default: from config or 127.0.0.1)
      --help            Show this help message
`.trim();

export interface AimockCliDeps {
  argv?: string[];
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  exit?: (code: number) => void;
  loadConfigFn?: typeof loadConfig;
  startFromConfigFn?: typeof startFromConfig;
  onReady?: (ctx: { shutdown: () => void }) => void;
}

export function runAimockCli(deps: AimockCliDeps = {}): void {
  /* v8 ignore next 6 -- defaults used only when called from CLI entry point */
  const argv = deps.argv ?? process.argv.slice(2);
  const log = deps.log ?? console.log.bind(console);
  const logError = deps.logError ?? console.error.bind(console);
  const exit = deps.exit ?? process.exit.bind(process);
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const startFromConfigFn = deps.startFromConfigFn ?? startFromConfig;

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
if (scriptName.endsWith("aimock-cli.js") || scriptName.endsWith("aimock-cli.ts")) {
  runAimockCli();
}
/* v8 ignore stop */
