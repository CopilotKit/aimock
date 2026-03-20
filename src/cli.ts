#!/usr/bin/env node
import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "./server.js";
import { loadFixtureFile, loadFixturesFromDir, validateFixtures } from "./fixture-loader.js";
import { Logger, type LogLevel } from "./logger.js";
import { watchFixtures } from "./watcher.js";

const HELP = `
Usage: llmock [options]

Options:
  -p, --port <number>       Port to listen on (default: 4010)
  -h, --host <string>       Host to bind to (default: 127.0.0.1)
  -f, --fixtures <path>     Path to fixtures directory or file (default: ./fixtures)
  -l, --latency <ms>        Latency in ms between SSE chunks (default: 0)
  -c, --chunk-size <chars>  Chunk size in characters (default: 20)
  -w, --watch               Watch fixture path for changes and reload
      --log-level <level>   Log verbosity: silent, info, debug (default: info)
      --validate-on-load    Validate fixture schemas at startup
      --chaos-drop <rate>   Probability (0-1) of dropping requests with 500
      --chaos-malformed <rate>  Probability (0-1) of returning malformed JSON
      --chaos-disconnect <rate> Probability (0-1) of destroying connection
      --help                Show this help message
`.trim();

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: "4010" },
    host: { type: "string", short: "h", default: "127.0.0.1" },
    fixtures: { type: "string", short: "f", default: "./fixtures" },
    latency: { type: "string", short: "l", default: "0" },
    "chunk-size": { type: "string", short: "c", default: "20" },
    watch: { type: "boolean", short: "w", default: false },
    "log-level": { type: "string", default: "info" },
    "validate-on-load": { type: "boolean", default: false },
    "chaos-drop": { type: "string" },
    "chaos-malformed": { type: "string" },
    "chaos-disconnect": { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const port = Number(values.port);
const host = values.host!;
const latency = Number(values.latency);
const chunkSize = Number(values["chunk-size"]);
const fixturePath = resolve(values.fixtures!);
const watchMode = values.watch!;
const validateOnLoad = values["validate-on-load"]!;
const logLevelStr = values["log-level"]!;

if (!["silent", "info", "debug"].includes(logLevelStr)) {
  console.error(`Invalid log-level: ${logLevelStr} (must be silent, info, or debug)`);
  process.exit(1);
}
const logLevel = logLevelStr as LogLevel;

if (Number.isNaN(port) || port < 0 || port > 65535) {
  console.error(`Invalid port: ${values.port}`);
  process.exit(1);
}

if (Number.isNaN(latency) || latency < 0) {
  console.error(`Invalid latency: ${values.latency}`);
  process.exit(1);
}

if (Number.isNaN(chunkSize) || chunkSize < 1) {
  console.error(`Invalid chunk-size: ${values["chunk-size"]}`);
  process.exit(1);
}

const logger = new Logger(logLevel);

// Parse chaos config from CLI flags
import type { ChaosConfig } from "./types.js";
let chaos: ChaosConfig | undefined;
{
  const dropStr = values["chaos-drop"];
  const malformedStr = values["chaos-malformed"];
  const disconnectStr = values["chaos-disconnect"];

  if (dropStr !== undefined || malformedStr !== undefined || disconnectStr !== undefined) {
    chaos = {};
    if (dropStr !== undefined) {
      const val = parseFloat(dropStr);
      if (isNaN(val) || val < 0 || val > 1) {
        console.error(`Invalid chaos-drop: ${dropStr} (must be 0-1)`);
        process.exit(1);
      }
      chaos.dropRate = val;
    }
    if (malformedStr !== undefined) {
      const val = parseFloat(malformedStr);
      if (isNaN(val) || val < 0 || val > 1) {
        console.error(`Invalid chaos-malformed: ${malformedStr} (must be 0-1)`);
        process.exit(1);
      }
      chaos.malformedRate = val;
    }
    if (disconnectStr !== undefined) {
      const val = parseFloat(disconnectStr);
      if (isNaN(val) || val < 0 || val > 1) {
        console.error(`Invalid chaos-disconnect: ${disconnectStr} (must be 0-1)`);
        process.exit(1);
      }
      chaos.disconnectRate = val;
    }
  }
}

async function main() {
  // Load fixtures from path (detect file vs directory)
  let isDir: boolean;
  let fixtures;
  try {
    const stat = statSync(fixturePath);
    isDir = stat.isDirectory();
    if (isDir) {
      fixtures = loadFixturesFromDir(fixturePath, logger);
    } else {
      fixtures = loadFixtureFile(fixturePath, logger);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Fixtures path not found: ${fixturePath}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to load fixtures from ${fixturePath}: ${msg}`);
    }
    process.exit(1);
  }

  if (fixtures.length === 0) {
    console.warn("Warning: No fixtures loaded. The server will return 404 for all requests.");
  }

  logger.info(`Loaded ${fixtures.length} fixture(s) from ${fixturePath}`);

  // Validate fixtures if requested
  if (validateOnLoad) {
    const results = validateFixtures(fixtures);
    const errors = results.filter((r) => r.severity === "error");
    const warnings = results.filter((r) => r.severity === "warning");

    for (const w of warnings) {
      logger.warn(`Fixture ${w.fixtureIndex}: ${w.message}`);
    }
    for (const e of errors) {
      logger.error(`Fixture ${e.fixtureIndex}: ${e.message}`);
    }

    if (errors.length > 0) {
      console.error(`Validation failed: ${errors.length} error(s), ${warnings.length} warning(s)`);
      process.exit(1);
    }
  }

  const instance = await createServer(fixtures, {
    port,
    host,
    latency,
    chunkSize,
    logLevel,
    chaos,
  });

  logger.info(`llmock server listening on ${instance.url}`);

  // Start file watcher if requested
  let watcher: { close: () => void } | null = null;
  if (watchMode) {
    const loadFn = isDir!
      ? () => loadFixturesFromDir(fixturePath, logger)
      : () => loadFixtureFile(fixturePath, logger);

    watcher = watchFixtures(fixturePath, fixtures, loadFn, {
      logger,
      validate: validateOnLoad,
      validateFn: validateFixtures,
    });
    logger.info(`Watching ${fixturePath} for changes`);
  }

  function shutdown() {
    logger.info("Shutting down...");
    if (watcher) watcher.close();
    instance.server.close(() => {
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
