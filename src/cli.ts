#!/usr/bin/env node
import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "./server.js";
import { loadFixtureFile, loadFixturesFromDir, validateFixtures } from "./fixture-loader.js";
import { Logger, type LogLevel } from "./logger.js";
import { watchFixtures } from "./watcher.js";
import { AGUIMock } from "./agui-mock.js";
import { resolveFixturesValue } from "./fixtures-remote.js";
import type { Fixture, ChaosConfig, RecordConfig } from "./types.js";

const HELP = `
Usage: aimock [options]

Options:
  -p, --port <number>       Port to listen on (default: 4010)
  -h, --host <string>       Host to bind to (default: 127.0.0.1)
  -f, --fixtures <value>    Fixture source (repeatable). Accepts:
                              - filesystem path to a directory or .json file (default: ./fixtures)
                              - https:// or http:// URL to a .json fixture file
  -l, --latency <ms>        Latency in ms between SSE chunks (default: 0)
  -c, --chunk-size <chars>  Chunk size in characters (default: 20)
  -w, --watch               Watch fixture path for changes and reload
      --log-level <level>   Log verbosity: silent, warn, info, debug (default: info)
      --validate-on-load    Validate fixture schemas at startup
      --metrics             Enable Prometheus metrics at GET /metrics
      --record              Record mode: proxy unmatched requests and save fixtures
      --record-full-model-version  Record exact model version without date stripping (default: false)
      --proxy-only          Proxy mode: forward unmatched requests without saving
      --strict              Strict mode: fail on unmatched requests (overridable per-request via X-AIMock-Strict header)
      --journal-max <n>     Max request entries retained in memory (default: 1000, 0 = unbounded)
      --fixture-counts-max <n>  Max unique testIds retained in fixture match-count map (default: 500, 0 = unbounded)
      --provider-openai <url>     Upstream URL for OpenAI (used with --record)
      --provider-anthropic <url>  Upstream URL for Anthropic
      --provider-gemini <url>     Upstream URL for Gemini
      --provider-vertexai <url>   Upstream URL for Vertex AI
      --provider-bedrock <url>    Upstream URL for Bedrock
      --provider-azure <url>      Upstream URL for Azure OpenAI
      --provider-ollama <url>     Upstream URL for Ollama
      --provider-cohere <url>     Upstream URL for Cohere
      --provider-openrouter <url> Upstream URL for OpenRouter (video record proxy)
      --upstream-timeout-ms <ms>  Idle timeout (ms) on upstream socket before response (default: 30000)
      --body-timeout-ms <ms>      Idle timeout (ms) on upstream response body between chunks (default: 30000)
      --max-proxy-buffer-bytes <n> Cap (bytes) on in-memory proxy-path buffer; full body still relayed (default: 67108864)
      --max-proxy-buffer-frames <n> Cap (frames) on in-memory proxy-path per-frame state; full body still relayed (default: 5000000)
      --agui-record              Enable AG-UI recording (proxy unmatched AG-UI requests)
      --agui-upstream <url>      Upstream AG-UI agent URL (used with --agui-record)
      --agui-proxy-only          AG-UI proxy mode: forward without saving
      --replay-speed <n>    Replay speed multiplier (default: 1.0, 2.0 = 2x faster)
      --chaos-drop <rate>   Probability (0-1) of dropping requests with 500
      --chaos-malformed <rate>  Probability (0-1) of returning malformed JSON
      --chaos-disconnect <rate> Probability (0-1) of destroying connection
      --help                Show this help message
`.trim();

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: "4010" },
    host: { type: "string", short: "h", default: "127.0.0.1" },
    fixtures: { type: "string", short: "f", multiple: true },
    latency: { type: "string", short: "l", default: "0" },
    "chunk-size": { type: "string", short: "c", default: "20" },
    watch: { type: "boolean", short: "w", default: false },
    "log-level": { type: "string", default: "info" },
    "validate-on-load": { type: "boolean", default: false },
    metrics: { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    "record-full-model-version": { type: "boolean", default: false },
    "proxy-only": { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    "provider-openai": { type: "string" },
    "provider-anthropic": { type: "string" },
    "provider-gemini": { type: "string" },
    "provider-vertexai": { type: "string" },
    "provider-bedrock": { type: "string" },
    "provider-azure": { type: "string" },
    "provider-ollama": { type: "string" },
    "provider-cohere": { type: "string" },
    "provider-openrouter": { type: "string" },
    "upstream-timeout-ms": { type: "string" },
    "body-timeout-ms": { type: "string" },
    "max-proxy-buffer-bytes": { type: "string" },
    "max-proxy-buffer-frames": { type: "string" },
    "agui-record": { type: "boolean", default: false },
    "agui-upstream": { type: "string" },
    "agui-proxy-only": { type: "boolean", default: false },
    "replay-speed": { type: "string", default: "1.0" },
    "chaos-drop": { type: "string" },
    "chaos-malformed": { type: "string" },
    "chaos-disconnect": { type: "string" },
    "journal-max": { type: "string", default: "1000" },
    "fixture-counts-max": { type: "string", default: "500" },
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
const fixtureValues: string[] =
  values.fixtures && values.fixtures.length > 0 ? values.fixtures : ["./fixtures"];
const watchMode = values.watch!;
const validateOnLoad = values["validate-on-load"]!;
const logLevelStr = values["log-level"]!;

if (!["silent", "warn", "info", "debug"].includes(logLevelStr)) {
  console.error(`Invalid log-level: ${logLevelStr} (must be silent, warn, info, or debug)`);
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

const replaySpeed = Number(values["replay-speed"]);
if (Number.isNaN(replaySpeed) || replaySpeed <= 0) {
  console.error("--replay-speed must be a positive number");
  process.exit(1);
}

const journalMax = Number(values["journal-max"]);
if (Number.isNaN(journalMax) || !Number.isInteger(journalMax) || journalMax < 0) {
  console.error(
    `Invalid journal-max: ${values["journal-max"]} (must be a non-negative integer; 0 = unbounded)`,
  );
  process.exit(1);
}

const fixtureCountsMaxStr = values["fixture-counts-max"];
const fixtureCountsMax = Number(fixtureCountsMaxStr);
if (Number.isNaN(fixtureCountsMax) || !Number.isInteger(fixtureCountsMax) || fixtureCountsMax < 0) {
  console.error(
    `Invalid fixture-counts-max: ${fixtureCountsMaxStr} (must be a non-negative integer; 0 = unbounded)`,
  );
  process.exit(1);
}

const upstreamTimeoutMsStr = values["upstream-timeout-ms"];
let upstreamTimeoutMs: number | undefined;
if (upstreamTimeoutMsStr !== undefined) {
  upstreamTimeoutMs = Number(upstreamTimeoutMsStr);
  if (!Number.isFinite(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    console.error(
      `Invalid upstream-timeout-ms: ${upstreamTimeoutMsStr} (must be a positive finite number)`,
    );
    process.exit(1);
  }
}

const bodyTimeoutMsStr = values["body-timeout-ms"];
let bodyTimeoutMs: number | undefined;
if (bodyTimeoutMsStr !== undefined) {
  bodyTimeoutMs = Number(bodyTimeoutMsStr);
  if (!Number.isFinite(bodyTimeoutMs) || bodyTimeoutMs <= 0) {
    console.error(
      `Invalid body-timeout-ms: ${bodyTimeoutMsStr} (must be a positive finite number)`,
    );
    process.exit(1);
  }
}

const maxProxyBufferBytesStr = values["max-proxy-buffer-bytes"];
let maxProxyBufferBytes: number | undefined;
if (maxProxyBufferBytesStr !== undefined) {
  maxProxyBufferBytes = Number(maxProxyBufferBytesStr);
  if (!Number.isFinite(maxProxyBufferBytes) || maxProxyBufferBytes <= 0) {
    console.error(
      `Invalid max-proxy-buffer-bytes: ${maxProxyBufferBytesStr} (must be a positive finite number)`,
    );
    process.exit(1);
  }
}

const maxProxyBufferFramesStr = values["max-proxy-buffer-frames"];
let maxProxyBufferFrames: number | undefined;
if (maxProxyBufferFramesStr !== undefined) {
  maxProxyBufferFrames = Number(maxProxyBufferFramesStr);
  if (!Number.isFinite(maxProxyBufferFrames) || maxProxyBufferFrames <= 0) {
    console.error(
      `Invalid max-proxy-buffer-frames: ${maxProxyBufferFramesStr} (must be a positive finite number)`,
    );
    process.exit(1);
  }
}

const logger = new Logger(logLevel);

// Parse chaos config from CLI flags
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

// Parse record/proxy config from CLI flags
let record: RecordConfig | undefined;
if (values.record || values["proxy-only"]) {
  const providers: RecordConfig["providers"] = {};
  if (values["provider-openai"]) providers.openai = values["provider-openai"];
  if (values["provider-anthropic"]) providers.anthropic = values["provider-anthropic"];
  if (values["provider-gemini"]) providers.gemini = values["provider-gemini"];
  if (values["provider-vertexai"]) providers.vertexai = values["provider-vertexai"];
  if (values["provider-bedrock"]) providers.bedrock = values["provider-bedrock"];
  if (values["provider-azure"]) providers.azure = values["provider-azure"];
  if (values["provider-ollama"]) providers.ollama = values["provider-ollama"];
  if (values["provider-cohere"]) providers.cohere = values["provider-cohere"];
  if (values["provider-openrouter"]) providers.openrouter = values["provider-openrouter"];

  if (Object.keys(providers).length === 0) {
    console.error(
      `Error: --${values["proxy-only"] ? "proxy-only" : "record"} requires at least one --provider-* flag`,
    );
    process.exit(1);
  }

  // For --record, the first --fixtures value is the base path for the recording
  // destination and must be a local filesystem path — writing to a URL is not supported.
  // For --proxy-only, unmatched requests are forwarded without saving, so no writable
  // destination is required; URL-only --fixtures is valid in that mode.
  const recordBase = fixtureValues[0];
  const recordBaseIsUrl = /^https?:\/\//i.test(recordBase);
  if (values.record && recordBaseIsUrl) {
    console.error(
      `Error: --record requires a local --fixtures path for the recording destination; got URL ${recordBase}`,
    );
    process.exit(1);
  }
  record = {
    providers,
    // In proxy-only mode with only URL sources, fixturePath is never consumed
    // (recorder.ts skips disk writes when proxyOnly is set). Leave it undefined
    // rather than resolving a URL string as a filesystem path.
    fixturePath: recordBaseIsUrl ? undefined : resolve(recordBase, "recorded"),
    proxyOnly: values["proxy-only"],
    recordFullModelVersion: values["record-full-model-version"],
    upstreamTimeoutMs,
    bodyTimeoutMs,
    maxProxyBufferBytes,
    maxProxyBufferFrames,
  };
} else {
  // These flags configure upstream proxying — without --record or
  // --proxy-only they would be parsed and then silently dropped. Routed
  // through the constructed logger so --log-level is respected.
  const droppedProviderFlags = (
    [
      "provider-openai",
      "provider-anthropic",
      "provider-gemini",
      "provider-vertexai",
      "provider-bedrock",
      "provider-azure",
      "provider-ollama",
      "provider-cohere",
      "provider-openrouter",
    ] as const
  ).filter((flag) => values[flag] !== undefined);
  if (droppedProviderFlags.length > 0) {
    logger.warn(
      `--${droppedProviderFlags.join("/--")} only apply to --record/--proxy-only upstream proxying — ignored without one of those flags.`,
    );
  }
  if (
    upstreamTimeoutMs !== undefined ||
    bodyTimeoutMs !== undefined ||
    maxProxyBufferBytes !== undefined ||
    maxProxyBufferFrames !== undefined
  ) {
    logger.warn(
      "--upstream-timeout-ms/--body-timeout-ms/--max-proxy-buffer-bytes/--max-proxy-buffer-frames only apply to --record/--proxy-only upstream proxying — ignored without one of those flags.",
    );
  }
}

// Parse AG-UI record/proxy config from CLI flags
let aguiMount: { path: string; handler: AGUIMock } | undefined;
if (values["agui-record"] || values["agui-proxy-only"]) {
  if (!values["agui-upstream"]) {
    console.error("Error: --agui-record/--agui-proxy-only requires --agui-upstream");
    process.exit(1);
  }
  // --agui-record writes recorded AG-UI fixtures to disk, so a URL source is unsupported.
  // --agui-proxy-only forwards without saving, so URL-only --fixtures is valid.
  const aguiBase = fixtureValues[0];
  const aguiBaseIsUrl = /^https?:\/\//i.test(aguiBase);
  if (values["agui-record"] && aguiBaseIsUrl) {
    console.error(
      `Error: --agui-record requires a local --fixtures path for the recording destination; got URL ${aguiBase}`,
    );
    process.exit(1);
  }
  const agui = new AGUIMock();
  agui.enableRecording({
    upstream: values["agui-upstream"],
    // In proxy-only mode with a URL-only --fixtures, the AG-UI recorder never
    // writes to disk (see agui-recorder.ts). Leave fixturePath undefined rather
    // than resolving a URL as a filesystem path.
    fixturePath: aguiBaseIsUrl ? undefined : resolve(aguiBase, "agui-recorded"),
    proxyOnly: values["agui-proxy-only"],
  });
  aguiMount = { path: "/agui", handler: agui };
}

interface ResolvedFixtureSource {
  source: string;
  path: string;
  isDir: boolean;
}

async function resolveAllFixtureSources(): Promise<ResolvedFixtureSource[]> {
  const resolved: ResolvedFixtureSource[] = [];
  for (const value of fixtureValues) {
    let local;
    try {
      local = await resolveFixturesValue(value, {
        validateOnLoad,
        logger,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to resolve --fixtures value "${value}": ${msg}`);
      process.exit(1);
    }
    if (!local.path) {
      // Remote fetch failed without validate-on-load and no cache — already warned; skip.
      continue;
    }
    try {
      const stat = statSync(local.path);
      resolved.push({ source: local.source, path: local.path, isDir: stat.isDirectory() });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(`Fixtures path not found: ${local.path}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to load fixtures from ${local.path}: ${msg}`);
      }
      process.exit(1);
    }
  }
  return resolved;
}

function loadSource(source: ResolvedFixtureSource): Fixture[] {
  return source.isDir
    ? loadFixturesFromDir(source.path, logger)
    : loadFixtureFile(source.path, logger);
}

async function main() {
  const sources = await resolveAllFixtureSources();

  const fixtures: Fixture[] = [];
  for (const src of sources) {
    fixtures.push(...loadSource(src));
  }

  if (fixtures.length === 0) {
    if (validateOnLoad || values.strict) {
      console.error("Error: No fixtures loaded and validation/strict mode is enabled — aborting.");
      process.exit(1);
    }
    console.warn("Warning: No fixtures loaded. The server will return 404 for all requests.");
  }

  const sourceLabel = sources.map((s) => s.source).join(", ") || "<none>";
  logger.info(`Loaded ${fixtures.length} fixture(s) from ${sourceLabel}`);

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

  const mounts = aguiMount ? [aguiMount] : undefined;

  const instance = await createServer(
    fixtures,
    {
      port,
      host,
      latency,
      chunkSize,
      replaySpeed,
      logLevel,
      chaos,
      metrics: values.metrics,
      record,
      strict: values.strict,
      journalMaxEntries: journalMax,
      fixtureCountsMaxTestIds: fixtureCountsMax,
    },
    mounts,
  );

  logger.info(`aimock server listening on ${instance.url}`);

  // Start file watcher if requested. Only the first local source is watched —
  // remote URL sources are fetched once at boot and are not monitored.
  let watcher: { close: () => void } | null = null;
  if (watchMode) {
    const primary = sources[0];
    if (!primary) {
      logger.warn("--watch requested but no resolvable fixture sources; skipping watcher");
    } else {
      const loadFn = (): Fixture[] => loadSource(primary);
      watcher = watchFixtures(primary.path, fixtures, loadFn, {
        logger,
        validate: validateOnLoad,
        validateFn: validateFixtures,
      });
      logger.info(`Watching ${primary.path} for changes`);
    }
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
