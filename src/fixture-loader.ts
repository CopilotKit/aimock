import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  Fixture,
  FixtureFile,
  FixtureFileEntry,
  FixtureFileResponse,
  FixtureResponse,
  ResponseOverrides,
} from "./types.js";
import {
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  isEmbeddingResponse,
  isImageResponse,
  isAudioResponse,
  isTranscriptionResponse,
  isVideoResponse,
  isJSONResponse,
} from "./helpers.js";
import type { Logger } from "./logger.js";

/**
 * Auto-stringify object-valued `content` and `toolCalls[].arguments` fields.
 * This lets fixture authors write plain JSON objects instead of escaped strings.
 * All other fields (including ResponseOverrides) pass through unmodified.
 */
export function normalizeResponse(raw: FixtureFileResponse): FixtureResponse {
  // Shallow-clone so we don't mutate the parsed JSON input.
  const response = { ...raw } as Record<string, unknown>;

  // Auto-stringify object content (e.g. structured output)
  if (typeof response.content === "object" && response.content !== null) {
    response.content = JSON.stringify(response.content);
  }

  // Auto-stringify object arguments in toolCalls
  if (Array.isArray(response.toolCalls)) {
    response.toolCalls = (response.toolCalls as Array<Record<string, unknown>>).map((tc) => {
      if (typeof tc.arguments === "object" && tc.arguments !== null) {
        return { ...tc, arguments: JSON.stringify(tc.arguments) };
      }
      return tc;
    });
  }

  return response as unknown as FixtureResponse;
}

export function entryToFixture(entry: FixtureFileEntry): Fixture {
  return {
    match: {
      userMessage: entry.match.userMessage,
      inputText: entry.match.inputText,
      toolCallId: entry.match.toolCallId,
      toolName: entry.match.toolName,
      model: entry.match.model,
      responseFormat: entry.match.responseFormat,
      endpoint: entry.match.endpoint,
      ...(entry.match.sequenceIndex !== undefined && { sequenceIndex: entry.match.sequenceIndex }),
      ...(entry.match.turnIndex !== undefined && {
        turnIndex: entry.match.turnIndex,
      }),
      ...(entry.match.hasToolResult !== undefined && {
        hasToolResult: entry.match.hasToolResult,
      }),
    },
    response: normalizeResponse(entry.response),
    ...(entry.latency !== undefined && { latency: entry.latency }),
    ...(entry.chunkSize !== undefined && { chunkSize: entry.chunkSize }),
    ...(entry.truncateAfterChunks !== undefined && {
      truncateAfterChunks: entry.truncateAfterChunks,
    }),
    ...(entry.disconnectAfterMs !== undefined && { disconnectAfterMs: entry.disconnectAfterMs }),
    ...(entry.streamingProfile !== undefined && { streamingProfile: entry.streamingProfile }),
    ...(entry.chaos !== undefined && { chaos: entry.chaos }),
  };
}

// Logging helper — uses logger if provided, falls back to console.warn.
function warn(logger: Logger | undefined, msg: string, ...rest: unknown[]): void {
  if (logger) {
    logger.warn(msg, ...rest);
  } else {
    console.warn(`[fixture-loader] ${msg}`, ...rest);
  }
}

export function loadFixtureFile(filePath: string, logger?: Logger): Fixture[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    warn(logger, `Could not read file ${filePath}:`, err);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(logger, `Invalid JSON in ${filePath}:`, err);
    return [];
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as FixtureFile).fixtures)
  ) {
    warn(logger, `Missing or invalid "fixtures" array in ${filePath}`);
    return [];
  }

  return (parsed as FixtureFile).fixtures.map(entryToFixture);
}

export function loadFixturesFromDir(dirPath: string, logger?: Logger): Fixture[] {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    warn(logger, `Could not read directory ${dirPath}:`, err);
    return [];
  }

  const jsonFiles: string[] = [];
  for (const name of entries) {
    const fullPath = join(dirPath, name);
    try {
      if (statSync(fullPath).isDirectory()) {
        warn(logger, `Skipping subdirectory ${fullPath} (fixtures are not loaded recursively)`);
        continue;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        warn(logger, `Could not stat ${fullPath}:`, err);
      }
      continue;
    }
    if (name.endsWith(".json")) {
      jsonFiles.push(name);
    }
  }
  jsonFiles.sort();

  const fixtures: Fixture[] = [];
  for (const name of jsonFiles) {
    const filePath = join(dirPath, name);
    fixtures.push(...loadFixtureFile(filePath, logger));
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// Fixture validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  severity: "error" | "warning";
  fixtureIndex: number;
  message: string;
}

function validateReasoning(
  response: { reasoning?: unknown },
  fixtureIndex: number,
  results: ValidationResult[],
): void {
  if (response.reasoning !== undefined) {
    if (typeof response.reasoning !== "string") {
      results.push({
        severity: "error",
        fixtureIndex,
        message: "reasoning must be a string",
      });
    } else if (response.reasoning === "") {
      results.push({
        severity: "warning",
        fixtureIndex,
        message: "reasoning is empty string — no reasoning events will be emitted",
      });
    }
  }
}

function validateWebSearches(
  response: { webSearches?: unknown },
  fixtureIndex: number,
  results: ValidationResult[],
): void {
  if (response.webSearches !== undefined) {
    if (!Array.isArray(response.webSearches)) {
      results.push({
        severity: "error",
        fixtureIndex,
        message: "webSearches must be an array of strings",
      });
    } else if (response.webSearches.length === 0) {
      results.push({
        severity: "warning",
        fixtureIndex,
        message: "webSearches is empty array — no web search events will be emitted",
      });
    } else {
      for (let j = 0; j < response.webSearches.length; j++) {
        if (typeof response.webSearches[j] !== "string") {
          results.push({
            severity: "error",
            fixtureIndex,
            message: `webSearches[${j}] is not a string`,
          });
          break;
        }
        if (response.webSearches[j] === "") {
          results.push({
            severity: "warning",
            fixtureIndex,
            message: `webSearches[${j}] is empty string`,
          });
        }
      }
    }
  }
}

export function validateFixtures(fixtures: Fixture[]): ValidationResult[] {
  const results: ValidationResult[] = [];

  const seenUserMessages = new Map<string, number>();

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const response = f.response;

    // Skip response-shape validation for function responses — they are
    // evaluated at runtime so we cannot statically inspect them.
    if (typeof response === "function") {
      // Still validate match fields and numeric options below.
    } else {
      // --- Error checks ---

      // Response type recognition
      // Note: isContentWithToolCallsResponse must be checked before isTextResponse
      // and isToolCallResponse since it is a structural superset of both.
      if (
        !isContentWithToolCallsResponse(response) &&
        !isTextResponse(response) &&
        !isToolCallResponse(response) &&
        !isErrorResponse(response) &&
        !isEmbeddingResponse(response) &&
        !isImageResponse(response) &&
        !isAudioResponse(response) &&
        !isTranscriptionResponse(response) &&
        !isVideoResponse(response) &&
        !isJSONResponse(response)
      ) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message:
            "response is not a recognized type (must have content, toolCalls, error, embedding, image, audio, transcription, video, or json)",
        });
      }

      // Text response checks
      if (isTextResponse(response)) {
        if (response.content === "") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "content is empty string",
          });
        }
        validateReasoning(response, i, results);
        validateWebSearches(response, i, results);
      }

      // ContentWithToolCalls response checks
      if (isContentWithToolCallsResponse(response)) {
        if (response.content === "") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "content is empty string",
          });
        }
        if (response.toolCalls.length === 0) {
          results.push({
            severity: "warning",
            fixtureIndex: i,
            message: "toolCalls array is empty — fixture will never produce tool calls",
          });
        }
        for (let j = 0; j < response.toolCalls.length; j++) {
          const tc = response.toolCalls[j];
          if (!tc.name) {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `toolCalls[${j}].name is empty`,
            });
          }
          try {
            JSON.parse(tc.arguments);
          } catch {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `toolCalls[${j}].arguments is not valid JSON: ${tc.arguments}`,
            });
          }
        }
        validateReasoning(response, i, results);
        validateWebSearches(response, i, results);
      }

      // Tool call response checks
      if (isToolCallResponse(response)) {
        if (response.toolCalls.length === 0) {
          results.push({
            severity: "warning",
            fixtureIndex: i,
            message: "toolCalls array is empty — fixture will never produce tool calls",
          });
        }
        for (let j = 0; j < response.toolCalls.length; j++) {
          const tc = response.toolCalls[j];
          if (!tc.name) {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `toolCalls[${j}].name is empty`,
            });
          }
          try {
            JSON.parse(tc.arguments);
          } catch {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `toolCalls[${j}].arguments is not valid JSON: ${tc.arguments}`,
            });
          }
        }
      }

      // Error response checks
      if (isErrorResponse(response)) {
        if (!response.error.message) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "error.message is empty",
          });
        }
        if (response.status !== undefined && (response.status < 100 || response.status > 599)) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `error status ${response.status} is not a valid HTTP status code`,
          });
        }
      }

      // Embedding response checks
      if (isEmbeddingResponse(response)) {
        if (response.embedding.length === 0) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "embedding array is empty",
          });
        }
        for (let j = 0; j < response.embedding.length; j++) {
          if (typeof response.embedding[j] !== "number") {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `embedding[${j}] is not a number`,
            });
            break; // one error is enough
          }
        }
      }

      // Audio response checks — validate object-form audio
      if (isAudioResponse(response) && typeof response.audio === "object") {
        const audioObj = response.audio;
        if (typeof audioObj.b64Json !== "string" || audioObj.b64Json === "") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "audio.b64Json must be a non-empty string",
          });
        }
        if (audioObj.contentType !== undefined && typeof audioObj.contentType !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `audio.contentType must be a string, got ${typeof audioObj.contentType}`,
          });
        }
      }

      // Validate ResponseOverrides fields
      if (
        isTextResponse(response) ||
        isToolCallResponse(response) ||
        isContentWithToolCallsResponse(response)
      ) {
        const r = response as ResponseOverrides;
        if (r.id !== undefined && typeof r.id !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "id" must be a string, got ${typeof r.id}`,
          });
        }
        if (r.created !== undefined && (typeof r.created !== "number" || r.created < 0)) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "created" must be a non-negative number`,
          });
        }
        if (r.model !== undefined && typeof r.model !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "model" must be a string, got ${typeof r.model}`,
          });
        }
        if (r.finishReason !== undefined && typeof r.finishReason !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "finishReason" must be a string, got ${typeof r.finishReason}`,
          });
        }
        if (r.role !== undefined && typeof r.role !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "role" must be a string, got ${typeof r.role}`,
          });
        }
        if (r.systemFingerprint !== undefined && typeof r.systemFingerprint !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "systemFingerprint" must be a string, got ${typeof r.systemFingerprint}`,
          });
        }
        if (r.usage !== undefined) {
          if (typeof r.usage !== "object" || r.usage === null || Array.isArray(r.usage)) {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `override "usage" must be an object`,
            });
          } else {
            // Check all known usage fields are numbers if present
            for (const key of Object.keys(r.usage)) {
              const val = (r.usage as Record<string, unknown>)[key];
              if (val !== undefined && typeof val !== "number") {
                results.push({
                  severity: "error",
                  fixtureIndex: i,
                  message: `override "usage.${key}" must be a number, got ${typeof val}`,
                });
              }
            }
          }
        }
      }
    } // end: skip response-shape validation for function responses

    // Numeric sanity checks
    if (f.latency !== undefined && f.latency < 0) {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: "latency must be >= 0",
      });
    }
    if (f.chunkSize !== undefined && f.chunkSize < 1) {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: "chunkSize must be >= 1",
      });
    }
    if (f.truncateAfterChunks !== undefined && f.truncateAfterChunks < 1) {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: "truncateAfterChunks must be >= 1",
      });
    }
    if (f.disconnectAfterMs !== undefined && f.disconnectAfterMs < 0) {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: "disconnectAfterMs must be >= 0",
      });
    }
    if (f.streamingProfile !== undefined) {
      const sp = f.streamingProfile;
      if (sp.ttft !== undefined && sp.ttft < 0) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "streamingProfile.ttft must be >= 0",
        });
      }
      if (sp.tps !== undefined && sp.tps <= 0) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "streamingProfile.tps must be > 0",
        });
      }
      if (sp.jitter !== undefined && (sp.jitter < 0 || sp.jitter > 1)) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "streamingProfile.jitter must be between 0 and 1",
        });
      }
    }
    if (f.chaos !== undefined) {
      const ch = f.chaos;
      if (ch.dropRate !== undefined && (ch.dropRate < 0 || ch.dropRate > 1)) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "chaos.dropRate must be between 0 and 1",
        });
      }
      if (ch.malformedRate !== undefined && (ch.malformedRate < 0 || ch.malformedRate > 1)) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "chaos.malformedRate must be between 0 and 1",
        });
      }
      if (ch.disconnectRate !== undefined && (ch.disconnectRate < 0 || ch.disconnectRate > 1)) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "chaos.disconnectRate must be between 0 and 1",
        });
      }
    }

    // Match field type checks
    if (f.match.turnIndex !== undefined) {
      if (
        typeof f.match.turnIndex !== "number" ||
        f.match.turnIndex < 0 ||
        !Number.isInteger(f.match.turnIndex)
      ) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "match.turnIndex must be a non-negative integer",
        });
      }
    }
    if (f.match.hasToolResult !== undefined && typeof f.match.hasToolResult !== "boolean") {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: `match.hasToolResult must be a boolean, got ${typeof f.match.hasToolResult}`,
      });
    }

    // --- Warning checks ---

    // Duplicate userMessage shadowing — include turnIndex, hasToolResult, and
    // sequenceIndex in the dedup key so that fixtures which share a userMessage
    // but differ on those fields are NOT considered duplicates.
    const um = f.match.userMessage;
    if (typeof um === "string" && um) {
      const dedupKey = `${um}|${f.match.turnIndex}|${f.match.hasToolResult}|${f.match.sequenceIndex}`;
      const prev = seenUserMessages.get(dedupKey);
      if (prev !== undefined) {
        results.push({
          severity: "warning",
          fixtureIndex: i,
          message: `duplicate userMessage '${um}' — shadows fixture ${prev}`,
        });
      } else {
        seenUserMessages.set(dedupKey, i);
      }
    }

    // Catch-all not in last position
    const match = f.match;
    const hasDiscriminator =
      match.endpoint !== undefined ||
      match.userMessage !== undefined ||
      match.inputText !== undefined ||
      match.responseFormat !== undefined ||
      match.toolCallId !== undefined ||
      match.toolName !== undefined ||
      match.model !== undefined ||
      match.predicate !== undefined ||
      match.turnIndex !== undefined ||
      match.hasToolResult !== undefined;

    if (!hasDiscriminator && i < fixtures.length - 1) {
      results.push({
        severity: "warning",
        fixtureIndex: i,
        message: `empty match acts as catch-all but is not the last fixture — shadows fixtures ${i + 1}+`,
      });
    }
  }

  return results;
}
