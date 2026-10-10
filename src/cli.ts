#!/usr/bin/env node
import { isDeepStrictEqual, parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, statSync, type Stats } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { createServer } from "./server.js";
import type { ResponsesToolsMode } from "./types.js";
import {
  FixtureLoadError,
  MisbehaviorConfigError,
  enableHeldFixtureMisbehavior,
  validateFixtures,
} from "./fixture-loader.js";
import {
  loadFixtureFileWithServices,
  loadFixturesFromDirWithServices,
  type FixturesWithServices,
} from "./fixture-loader-services.js";
import { McpFakesAddError } from "./mcp-fakes.js";
import { build, msg } from "./message-text.js";
import { Logger, type LogLevel } from "./logger.js";
import { watchFixtures } from "./watcher.js";
import { AGUIMock } from "./agui-mock.js";
import { MCPMock } from "./mcp-mock.js";
import { mcpRecordEnv, parseMcpRecordFlag } from "./mcp-recorder.js";
import { parseChaosField, CHAOS_FIELDS, type ChaosField } from "./chaos.js";
import { resolveFixturesValue } from "./fixtures-remote.js";
import { readProviderKeysFromEnv } from "./provider-auth.js";
import { resolveInboundAuth, selectInboundAuthSource } from "./api-key-auth.js";
import type { Fixture, ChaosConfig, RecordConfig, McpFakeSource, Mountable } from "./types.js";

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
      --misbehavior         Enable model misbehavior: fixture misbehavior keys and the
                            X-AIMock-Misbehavior header (ignored without this flag)
      --metrics             Enable Prometheus metrics at GET /metrics
      --record              Record mode: proxy unmatched requests and save fixtures
      --record-full-model-version  Record exact model version without date stripping (default: false)
      --proxy-only          Proxy mode: forward unmatched requests without saving
      --strict              Strict mode: fail on unmatched requests (overridable per-request via X-AIMock-Strict header)
      --strict-tool-arguments  Reject fixture tool calls with invalid JSON arguments instead of serving {} (default: false)
      --responses-tools <mode>  OpenAI Responses tool handling: legacy (default) or extended (namespaced and
                            custom tools visible to matching, custom tool rounds counted, namespaces emitted and recorded)
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
      --provider-byteplus <url>   Upstream ORIGIN for BytePlus Ark (e.g. https://ark.ap-southeast.bytepluses.com — origin only, no /api/v3)
      --upstream-timeout-ms <ms>  Idle timeout (ms) on upstream socket before response (default: 30000)
      --body-timeout-ms <ms>      Idle timeout (ms) on upstream response body between chunks (default: 30000)
      --max-proxy-buffer-bytes <n> Cap (bytes) on in-memory proxy-path buffer; full body still relayed (default: 67108864)
      --max-proxy-buffer-frames <n> Cap (frames) on in-memory proxy-path per-frame state; full body still relayed (default: 5000000)
      --agui-record              Enable AG-UI recording (proxy unmatched AG-UI requests)
      --agui-upstream <url>      Upstream AG-UI agent URL (used with --agui-record)
      --agui-proxy-only          AG-UI proxy mode: forward without saving
      --mcp-record <mount>=<url>   Record an upstream MCP server into mcpFakes (repeatable)
      --mcp-proxy-only <mount>=<url>  Proxy an upstream MCP server without saving
      --replay-speed <n>    Replay speed multiplier (default: 1.0, 2.0 = 2x faster)
      --chaos-drop <rate>   Probability (0-1) of dropping requests with 500
      --chaos-malformed <rate>  Probability (0-1) of returning malformed JSON
      --chaos-disconnect <rate> Probability (0-1) of destroying connection
      --chaos-ratelimit <rate> Probability (0-1) of 429 with Retry-After
      --chaos-latency <ms> Delay (0-${CHAOS_FIELDS.latencyMs.max}ms) injected before handling
      AIMOCK_API_KEYS  Comma-separated inbound test API keys (environment only)
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
    misbehavior: { type: "boolean", default: false },
    metrics: { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    "record-full-model-version": { type: "boolean", default: false },
    "proxy-only": { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    "strict-tool-arguments": { type: "boolean", default: false },
    "responses-tools": { type: "string" },
    "provider-openai": { type: "string" },
    "provider-anthropic": { type: "string" },
    "provider-gemini": { type: "string" },
    "provider-vertexai": { type: "string" },
    "provider-bedrock": { type: "string" },
    "provider-azure": { type: "string" },
    "provider-ollama": { type: "string" },
    "provider-cohere": { type: "string" },
    "provider-openrouter": { type: "string" },
    "provider-byteplus": { type: "string" },
    "upstream-timeout-ms": { type: "string" },
    "body-timeout-ms": { type: "string" },
    "max-proxy-buffer-bytes": { type: "string" },
    "max-proxy-buffer-frames": { type: "string" },
    "agui-record": { type: "boolean", default: false },
    "agui-upstream": { type: "string" },
    "agui-proxy-only": { type: "boolean", default: false },
    "mcp-record": { type: "string", multiple: true },
    "mcp-proxy-only": { type: "string", multiple: true },
    "replay-speed": { type: "string", default: "1.0" },
    "chaos-drop": { type: "string" },
    "chaos-malformed": { type: "string" },
    "chaos-disconnect": { type: "string" },
    "chaos-ratelimit": { type: "string" },
    "chaos-latency": { type: "string" },
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

const responsesToolsFlag = values["responses-tools"];
if (
  responsesToolsFlag !== undefined &&
  responsesToolsFlag !== "legacy" &&
  responsesToolsFlag !== "extended"
) {
  console.error(
    `Invalid --responses-tools: ${responsesToolsFlag} (expected "legacy" or "extended")`,
  );
  process.exit(1);
}
const responsesTools: ResponsesToolsMode | undefined = responsesToolsFlag;

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
  const ratelimitStr = values["chaos-ratelimit"];
  const latencyStr = values["chaos-latency"];

  if (
    dropStr !== undefined ||
    malformedStr !== undefined ||
    disconnectStr !== undefined ||
    ratelimitStr !== undefined ||
    latencyStr !== undefined
  ) {
    // Same parser, same TABLE, same reject-never-clamp policy as every other
    // chaos input (headers, fixture, server default, control API) — see
    // `ChaosConfig`. The bounds and the integer-vs-rate grammar are read out of
    // `CHAOS_FIELDS`, never re-typed here, so raising a cap in that one table
    // moves the flag with it instead of leaving `--chaos-latency` on the old
    // limit with no compile error.
    chaos = {};
    const flagFields: Array<{ flag: string; field: ChaosField; raw: string | undefined }> = [
      { flag: "chaos-drop", field: "dropRate", raw: dropStr },
      { flag: "chaos-malformed", field: "malformedRate", raw: malformedStr },
      { flag: "chaos-disconnect", field: "disconnectRate", raw: disconnectStr },
      { flag: "chaos-ratelimit", field: "rateLimitRate", raw: ratelimitStr },
      { flag: "chaos-latency", field: "latencyMs", raw: latencyStr },
    ];
    for (const { flag, field, raw } of flagFields) {
      if (raw === undefined) continue;
      const val = parseChaosField(field, raw);
      if (val === undefined) {
        console.error(`Invalid ${flag}: ${raw} (must be 0-${CHAOS_FIELDS[field].max})`);
        process.exit(1);
      }
      chaos[field] = val;
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
  if (values["provider-byteplus"]) providers.byteplus = values["provider-byteplus"];

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
    // aimock's own upstream keys, sourced from AIMOCK_PROVIDER_*_KEY env vars
    // (not CLI flags — secrets must not appear in `ps`). Injected on a
    // fixture-miss passthrough when the caller sent no/dummy credential.
    providerKeys: readProviderKeysFromEnv(),
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
      "provider-byteplus",
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

// Parse MCP record/proxy mounts (MR1, AM6): --mcp-record / --mcp-proxy-only <mount>=<url>
const mcpRecordMounts: { path: string; handler: MCPMock }[] = [];
{
  const recordValues = values["mcp-record"] ?? [];
  const proxyValues = values["mcp-proxy-only"] ?? [];
  if (recordValues.length > 0) {
    // C11: check the flag itself; fixtureValues defaults to ./fixtures.
    if (!(values.fixtures && values.fixtures.length > 0)) {
      console.error(
        "Error: --mcp-record requires --fixtures <local path> for the recording destination",
      );
      process.exit(1);
    }
    if (/^https?:\/\//i.test(values.fixtures[0])) {
      console.error(
        `Error: --mcp-record requires a local --fixtures path for the recording destination; got URL ${values.fixtures[0]}`,
      );
      process.exit(1);
    }
  }
  const flags = [
    ...recordValues.map((value) => ({ flag: "--mcp-record", value, proxyOnly: false })),
    ...proxyValues.map((value) => ({ flag: "--mcp-proxy-only", value, proxyOnly: true })),
  ];
  if (flags.length > 0) {
    let env: ReturnType<typeof mcpRecordEnv>;
    try {
      env = mcpRecordEnv(process.env);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    for (const { flag, value, proxyOnly } of flags) {
      try {
        const { mount, upstream } = parseMcpRecordFlag(value, flag);
        if (aguiMount && mount === aguiMount.path) {
          throw new Error(`${flag} mount ${mount} is held by a mount that is not an MCP mock`);
        }
        if (mcpRecordMounts.some((m) => m.path === mount)) {
          throw new Error(`${flag} mount ${mount} is given more than once`);
        }
        const mcp = new MCPMock().enableRecording({
          upstream,
          fixturePath: proxyOnly ? undefined : resolve(values.fixtures![0], "recorded"),
          proxyOnly,
          secretValues: env.secretValues,
          upstreamAuth: env.upstreamAuth,
          strict: values.strict,
        });
        mcpRecordMounts.push({ path: mount, handler: mcp });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }
  }
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

// F3: the loaders that carry `mcpFakes`. A file's entry-id source (I6) is the
// --fixtures value as given: the path, or the URL of a remote file (whose
// `path` is the on-disk cache).
function loadSource(source: ResolvedFixtureSource): FixturesWithServices {
  const loaded = source.isDir
    ? loadFixturesFromDirWithServices(source.path, logger)
    : loadFixtureFileWithServices(source.path, logger, undefined, source.source);
  // --misbehavior: a bad fixture `misbehavior` key fails the load; without it the key is ignored.
  if (values.misbehavior) loaded.fixtures.forEach(enableHeldFixtureMisbehavior);
  return loaded;
}

/** Each source's `mcpFakes` blocks, in load order, for the --watch comparison. */
function fakesBySource(blocks: McpFakeSource[]): Map<string, unknown[]> {
  const bySource = new Map<string, unknown[]>();
  for (const block of blocks) {
    const list = bySource.get(block.source) ?? [];
    list.push([block.blockIndex, block.raw]);
    bySource.set(block.source, list);
  }
  return bySource;
}

/**
 * R9/F11: fakes are not reloaded by --watch, so a reload whose `mcpFakes`
 * differ from the boot set is rejected. Returns the first changed source.
 * A source in `unreadable` could not be read or parsed: it is not compared,
 * because its blocks are unknown, not removed.
 */
function changedFakesSource(
  boot: McpFakeSource[],
  reload: McpFakeSource[],
  unreadable: ReadonlySet<string>,
): string | null {
  const before = fakesBySource(boot);
  const after = fakesBySource(reload);
  for (const source of new Set([...before.keys(), ...after.keys()])) {
    if (unreadable.has(source)) continue;
    if (!isDeepStrictEqual(before.get(source), after.get(source))) return source;
  }
  return null;
}

/**
 * L3: a load error on stderr, whatever the log level: every error of a
 * `McpFakesAddError`, one per line, then its L8 warnings.
 */
function printLoadError(err: FixtureLoadError | MisbehaviorConfigError): void {
  const errors = err instanceof McpFakesAddError ? err.errors : [err];
  for (const e of errors) console.error(e.message);
  if (err instanceof McpFakesAddError) {
    for (const w of err.warnings) console.warn(w.message);
  }
}

/** A --watch reload that `loadFn` rejected and already printed (L3, L7). */
class ReloadRejected extends Error {}

/**
 * The --watch logger: as `Logger`, except that the watcher's own report of a
 * {@link ReloadRejected} reload is dropped, so the error is printed once.
 */
class WatchLogger extends Logger {
  override error(...args: unknown[]): void {
    if (args.some((a) => a instanceof ReloadRejected)) return;
    super.error(...args);
  }
}

/**
 * MR13: --watch with record mounts. (a) An event for a recorder temp file, or
 * for a file whose bytes are exactly what a recorder last wrote there, does
 * not reload; everything else (a delete, a directory, a user edit) reloads as
 * on main. (b) Each recorder write moves the --watch baseline of that file,
 * so the next reload does not reject the recording as a changed `mcpFakes`.
 * Without record mounts (or for a file source), --watch is exactly as on main.
 */
function recorderWatch(
  primary: ResolvedFixtureSource,
  moveBaseline: (moved: (boot: McpFakeSource[]) => McpFakeSource[]) => void,
): { ignore?: (absPath: string) => boolean } {
  const events = mcpRecordMounts.map((m) => m.handler.recorderEvents()).filter((ev) => ev !== null);
  if (events.length === 0 || !primary.isDir) return {};
  for (const ev of events) {
    ev.onWrite((file, written) => {
      const source = relative(primary.path, file).split(sep).join("/");
      const blocks: McpFakeSource[] = Array.isArray(written)
        ? written.map((raw, blockIndex) => ({ source, blockIndex, raw }))
        : [{ source, blockIndex: null, raw: written }];
      moveBaseline((boot) => {
        // Replace this source's blocks in place; a new source goes last.
        const others = boot.filter((b) => b.source !== source);
        const at = boot.findIndex((b) => b.source === source);
        const pos = at === -1 ? others.length : at;
        return [...others.slice(0, pos), ...blocks, ...others.slice(pos)];
      });
    });
  }
  return {
    ignore: (absPath: string): boolean => {
      // Recorder temp files only (persistServiceFakes writes `<file>.tmp.<uuid>`, then renames it).
      if (/\.tmp\.[0-9a-f-]+$/i.test(absPath)) return true;
      let st: Stats;
      try {
        st = statSync(absPath);
      } catch {
        return false; // gone: a user deleted a fixture — this MUST reload (r2 N2)
      }
      if (st.isDirectory()) return false; // directory events behave as on main
      let data: Buffer;
      try {
        data = readFileSync(absPath);
      } catch {
        return false;
      }
      const hash = createHash("sha256").update(data).digest("hex");
      return events.some((ev) => ev.lastWrittenHash(absPath) === hash);
    },
  };
}

async function main() {
  const sources = await resolveAllFixtureSources();

  const fixtures: Fixture[] = [];
  const mcpFakes: McpFakeSource[] = [];
  // The primary source's blocks: what a --watch reload of it is compared with.
  let primaryFakes: McpFakeSource[] = [];
  for (const src of sources) {
    const loaded = loadSource(src);
    fixtures.push(...loaded.fixtures);
    mcpFakes.push(...loaded.mcpFakes);
    if (src === sources[0]) primaryFakes = loaded.mcpFakes;
  }

  if (fixtures.length === 0 && mcpFakes.length > 0) {
    // F5/L9: fake blocks count as loaded; only LLM requests have nothing to match.
    console.warn(build(msg`Warning: No LLM fixtures loaded; LLM requests will return 404`));
  } else if (fixtures.length === 0) {
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
    // L8 (shadowed mcpFakes entries) is not printed here: the hand-off in
    // createServer prints it on every start.
    for (const e of errors) {
      logger.error(`Fixture ${e.fixtureIndex}: ${e.message}`);
    }

    if (errors.length > 0) {
      console.error(`Validation failed: ${errors.length} error(s), ${warnings.length} warning(s)`);
      process.exit(1);
    }
  }

  const allMounts: { path: string; handler: Mountable }[] = [
    ...(aguiMount ? [aguiMount] : []),
    ...mcpRecordMounts,
  ];
  const mounts = allMounts.length > 0 ? allMounts : undefined;

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
      strictToolArguments: values["strict-tool-arguments"],
      enableMisbehavior: values.misbehavior,
      ...(responsesTools !== undefined ? { responsesTools } : {}),
      journalMaxEntries: journalMax,
      fixtureCountsMaxTestIds: fixtureCountsMax,
      auth: resolveInboundAuth(selectInboundAuthSource(undefined)).publicConfig,
    },
    mounts,
    { search: [], rerank: [], moderation: [], mcpFakes },
  );

  // Only the first local source is watched — remote URL sources are fetched once
  // at boot and are not monitored. Declared before the readiness announcement so
  // shutdown can close it whenever the signal arrives.
  let watcher: { close: () => void } | null = null;

  function shutdown() {
    logger.info("Shutting down...");
    if (watcher) watcher.close();
    instance.server.close(() => {
      process.exit(0);
    });
  }

  // Register BEFORE announcing readiness. Writes to a pipe are synchronous on Linux
  // (and to a file on every POSIX platform), so a supervisor that reacts to the line
  // below can deliver SIGTERM while this process is still mid-statement. Announcing
  // first left a window in which SIGTERM hit Node's default disposition, which
  // re-raises: the process died with a null exit code instead of shutting down.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(`aimock server listening on ${instance.url}`);

  // Start file watcher if requested.
  if (watchMode) {
    const primary = sources[0];
    if (!primary) {
      logger.warn("--watch requested but no resolvable fixture sources; skipping watcher");
    } else {
      // A rejected reload is printed here, whatever the log level, then
      // thrown as ReloadRejected: watchFixtures keeps the previous fixtures,
      // and its WatchLogger does not print the error a second time.
      const reject = (err: FixtureLoadError | MisbehaviorConfigError): never => {
        printLoadError(err);
        throw new ReloadRejected(build(msg`--watch reload rejected`));
      };
      const loadFn = (): Fixture[] => {
        let loaded: FixturesWithServices;
        try {
          loaded = loadSource(primary);
        } catch (err) {
          // L3: a bad block in the reloaded file.
          if (err instanceof FixtureLoadError || err instanceof MisbehaviorConfigError) {
            return reject(err);
          }
          throw err;
        }
        const changed = changedFakesSource(
          primaryFakes,
          loaded.mcpFakes,
          new Set(loaded.unreadable),
        );
        if (changed !== null) {
          // L7.
          return reject(
            new FixtureLoadError({
              rule: "mcp-fakes/watch-reload-changed",
              file: changed,
              detail: msg`mcpFakes changed on --watch reload; MCP fakes are not reloaded, so the whole reload is rejected and the previous fixtures stay loaded. Restart aimock to load the new fakes`,
            }),
          );
        }
        return loaded.fixtures;
      };
      watcher = watchFixtures(primary.path, fixtures, loadFn, {
        logger: new WatchLogger(logLevel),
        validate: validateOnLoad,
        validateFn: validateFixtures,
        ...recorderWatch(primary, (moved) => (primaryFakes = moved(primaryFakes))),
      });
      logger.info(`Watching ${primary.path} for changes`);
    }
  }
}

main().catch((err) => {
  if (err instanceof FixtureLoadError || err instanceof MisbehaviorConfigError) {
    printLoadError(err);
  } else {
    console.error(err);
  }
  process.exit(1);
});
