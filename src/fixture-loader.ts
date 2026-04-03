import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Fixture, FixtureFile, FixtureFileEntry } from "./types.js";
import {
  isTextResponse,
  isToolCallResponse,
  isErrorResponse,
  isEmbeddingResponse,
} from "./helpers.js";
import type { Logger } from "./logger.js";

export function entryToFixture(entry: FixtureFileEntry): Fixture {
  return {
    match: {
      userMessage: entry.match.userMessage,
      inputText: entry.match.inputText,
      toolCallId: entry.match.toolCallId,
      toolName: entry.match.toolName,
      model: entry.match.model,
      responseFormat: entry.match.responseFormat,
      ...(entry.match.sequenceIndex !== undefined && { sequenceIndex: entry.match.sequenceIndex }),
    },
    response: entry.response,
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

export function validateFixtures(fixtures: Fixture[]): ValidationResult[] {
  const results: ValidationResult[] = [];

  const seenUserMessages = new Map<string, number>();

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const response = f.response;

    // --- Error checks ---

    // Response type recognition
    if (
      !isTextResponse(response) &&
      !isToolCallResponse(response) &&
      !isErrorResponse(response) &&
      !isEmbeddingResponse(response)
    ) {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message:
          "response is not a recognized type (must have content, toolCalls, error, or embedding)",
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
      if (response.reasoning !== undefined) {
        if (typeof response.reasoning !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "reasoning must be a string",
          });
        } else if (response.reasoning === "") {
          results.push({
            severity: "warning",
            fixtureIndex: i,
            message: "reasoning is empty string — no reasoning events will be emitted",
          });
        }
      }
      if (response.webSearches !== undefined) {
        if (!Array.isArray(response.webSearches)) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "webSearches must be an array of strings",
          });
        } else if (response.webSearches.length === 0) {
          results.push({
            severity: "warning",
            fixtureIndex: i,
            message: "webSearches is empty array — no web search events will be emitted",
          });
        } else {
          for (let j = 0; j < response.webSearches.length; j++) {
            if (typeof response.webSearches[j] !== "string") {
              results.push({
                severity: "error",
                fixtureIndex: i,
                message: `webSearches[${j}] is not a string`,
              });
              break;
            }
            if (response.webSearches[j] === "") {
              results.push({
                severity: "warning",
                fixtureIndex: i,
                message: `webSearches[${j}] is empty string`,
              });
            }
          }
        }
      }
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

    // --- Warning checks ---

    // Duplicate userMessage shadowing
    const um = f.match.userMessage;
    if (typeof um === "string" && um) {
      const prev = seenUserMessages.get(um);
      if (prev !== undefined) {
        results.push({
          severity: "warning",
          fixtureIndex: i,
          message: `duplicate userMessage '${um}' — shadows fixture ${prev}`,
        });
      } else {
        seenUserMessages.set(um, i);
      }
    }

    // Catch-all not in last position
    const match = f.match;
    const hasDiscriminator =
      match.userMessage !== undefined ||
      match.inputText !== undefined ||
      match.responseFormat !== undefined ||
      match.toolCallId !== undefined ||
      match.toolName !== undefined ||
      match.model !== undefined ||
      match.predicate !== undefined;

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
