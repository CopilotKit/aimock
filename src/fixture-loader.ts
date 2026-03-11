import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Fixture, FixtureFile, FixtureFileEntry } from "./types.js";

function entryToFixture(entry: FixtureFileEntry): Fixture {
  return {
    match: {
      userMessage: entry.match.userMessage,
      toolCallId: entry.match.toolCallId,
      toolName: entry.match.toolName,
      model: entry.match.model,
    },
    response: entry.response,
    ...(entry.latency !== undefined && { latency: entry.latency }),
    ...(entry.chunkSize !== undefined && { chunkSize: entry.chunkSize }),
    ...(entry.truncateAfterChunks !== undefined && {
      truncateAfterChunks: entry.truncateAfterChunks,
    }),
    ...(entry.disconnectAfterMs !== undefined && { disconnectAfterMs: entry.disconnectAfterMs }),
  };
}

export function loadFixtureFile(filePath: string): Fixture[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.warn(`[fixture-loader] Could not read file ${filePath}:`, err);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[fixture-loader] Invalid JSON in ${filePath}:`, err);
    return [];
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as FixtureFile).fixtures)
  ) {
    console.warn(`[fixture-loader] Missing or invalid "fixtures" array in ${filePath}`);
    return [];
  }

  return (parsed as FixtureFile).fixtures.map(entryToFixture);
}

export function loadFixturesFromDir(dirPath: string): Fixture[] {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    console.warn(`[fixture-loader] Could not read directory ${dirPath}:`, err);
    return [];
  }

  const jsonFiles: string[] = [];
  for (const name of entries) {
    const fullPath = join(dirPath, name);
    try {
      if (statSync(fullPath).isDirectory()) {
        console.warn(
          `[fixture-loader] Skipping subdirectory ${fullPath} (fixtures are not loaded recursively)`,
        );
        continue;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(`[fixture-loader] Could not stat ${fullPath}:`, err);
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
    fixtures.push(...loadFixtureFile(filePath));
  }

  return fixtures;
}
