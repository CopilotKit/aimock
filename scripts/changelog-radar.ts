/// <reference types="node" />

/**
 * Changelog Radar
 *
 * Fetches the OpenAI API changelog, filters for entries relevant to aimock's
 * provider surface, and outputs a JSON report of new entries since the last run.
 *
 * On first run (no cursor file), sets the cursor to today and reports nothing.
 * If parsing fails, logs a warning and exits 0 (never fails the workflow).
 *
 * Usage:
 *   npx tsx scripts/changelog-radar.ts
 *
 * Output (stdout): JSON report when new entries found, empty otherwise.
 * Side effect: updates .changelog-radar-cursor with the latest entry date.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CHANGELOG_URL = "https://platform.openai.com/docs/changelog";
const CURSOR_FILE = resolve(import.meta.dirname ?? ".", "../.changelog-radar-cursor");

const SURFACE_KEYWORDS = [
  "realtime",
  "chat",
  "completions",
  "embeddings",
  "responses",
  "audio",
  "speech",
  "transcription",
  "images",
  "moderation",
  "models",
  "deprecat",
  "breaking",
  "websocket",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChangelogEntry {
  date: string;
  title: string;
  url: string;
  keywords: string[];
}

interface RadarReport {
  newEntries: ChangelogEntry[];
  since: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCursor(): string | null {
  if (!existsSync(CURSOR_FILE)) return null;
  const raw = readFileSync(CURSOR_FILE, "utf-8").trim();
  // Validate it looks like a date
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return null;
}

function writeCursor(date: string): void {
  writeFileSync(CURSOR_FILE, date + "\n", "utf-8");
}

function matchKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return SURFACE_KEYWORDS.filter((kw) => lower.includes(kw));
}

/**
 * Parse changelog entries from the HTML page.
 *
 * The OpenAI changelog page uses a structured format with date headings and
 * entry titles. We look for common patterns:
 *   - Date strings like "January 15, 2025" or "2025-01-15"
 *   - Heading-like elements following dates
 *
 * This is intentionally loose — we'd rather over-match than miss entries.
 */
function parseEntries(html: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];

  // Strategy 1: Look for date patterns followed by content blocks.
  // OpenAI's changelog typically has entries with dates in heading elements.
  // Match patterns like: <h2>January 15, 2025</h2> or date attributes
  const dateContentPattern =
    /(?:<h[23][^>]*>|<time[^>]*>|<div[^>]*date[^>]*>)\s*([A-Z][a-z]+ \d{1,2},?\s*\d{4}|\d{4}-\d{2}-\d{2})\s*(?:<\/h[23]>|<\/time>|<\/div>)/gi;

  // Also try: entries as list items or article elements with dates
  const entryPattern =
    /(\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4})[^<]*<[^>]*>([^<]{5,200})/gi;

  // Strategy 2: Broader pattern — grab anything that looks like a dated entry
  const broadPattern =
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}|\d{4}-\d{2}-\d{2})[\s\S]{0,500}?(?:<[hH][1-6][^>]*>|<a[^>]*>|<strong>|<b>)\s*([^<]{5,200})/g;

  const seen = new Set<string>();

  for (const pattern of [dateContentPattern, entryPattern, broadPattern]) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const rawDate = match[1]!.trim();
      const title = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();

      // Normalize date to YYYY-MM-DD
      const normalizedDate = normalizeDate(rawDate);
      if (!normalizedDate) continue;

      const key = `${normalizedDate}:${title.slice(0, 80)}`;
      if (seen.has(key) || !title) continue;
      seen.add(key);

      entries.push({
        date: normalizedDate,
        title,
        url: `${CHANGELOG_URL}#${normalizedDate}`,
        keywords: [],
      });
    }
  }

  // Sort newest first
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

function normalizeDate(raw: string): string | null {
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // "Month DD, YYYY" or "Month DD YYYY"
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return null;

  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Fetch the changelog page
  let html: string;
  try {
    const resp = await fetch(CHANGELOG_URL, {
      headers: { "User-Agent": "aimock-changelog-radar/1.0" },
    });
    if (!resp.ok) {
      console.warn(`Changelog fetch failed: ${resp.status} ${resp.statusText}`);
      process.exit(0);
    }
    html = await resp.text();
  } catch (err) {
    console.warn(`Changelog fetch error: ${err}`);
    process.exit(0);
  }

  // Parse entries
  const allEntries = parseEntries(html);
  if (allEntries.length === 0) {
    console.warn("No changelog entries parsed — format may have changed");
    process.exit(0);
  }

  // Read cursor
  const cursor = readCursor();
  const today = new Date().toISOString().slice(0, 10);

  // First run: set cursor and exit
  if (!cursor) {
    const newestDate = allEntries[0]?.date ?? today;
    writeCursor(newestDate);
    console.log(`First run — cursor set to ${newestDate}. No entries to report.`);
    process.exit(0);
  }

  // Filter to entries newer than cursor
  const newEntries = allEntries.filter((e) => e.date > cursor);

  if (newEntries.length === 0) {
    console.log(`No new entries since ${cursor}.`);
    process.exit(0);
  }

  // Filter for surface-relevant entries
  const relevant: ChangelogEntry[] = [];
  for (const entry of newEntries) {
    const kw = matchKeywords(`${entry.title} ${entry.url}`);
    if (kw.length > 0) {
      entry.keywords = kw;
      relevant.push(entry);
    }
  }

  // Update cursor to newest entry
  const newestDate = newEntries[0]?.date ?? today;
  writeCursor(newestDate);

  if (relevant.length === 0) {
    console.log(
      `${newEntries.length} new entries since ${cursor}, but none matched surface keywords.`,
    );
    process.exit(0);
  }

  // Output report
  const report: RadarReport = {
    newEntries: relevant,
    since: cursor,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.warn(`Unhandled error: ${err}`);
  process.exit(0);
});
