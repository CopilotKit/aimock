/**
 * Model deprecation checks — verify that models referenced in llmock's
 * tests, docs, and examples still exist at each provider.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { listOpenAIModels, listAnthropicModels, listGeminiModels } from "./providers.js";

// ---------------------------------------------------------------------------
// Scrape referenced models from the codebase
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function scrapeModels(pattern: RegExp, files: string[]): string[] {
  const models = new Set<string>();
  for (const file of files) {
    const filePath = path.join(PROJECT_ROOT, file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      models.add(match[1]);
    }
  }
  return [...models];
}

const sourceFiles = [
  "src/__tests__/api-conformance.test.ts",
  "src/__tests__/ws-api-conformance.test.ts",
  "README.md",
  "fixtures/example-greeting.json",
  "fixtures/example-multi-turn.json",
  "fixtures/example-tool-call.json",
];

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI model availability", () => {
  it("models used in llmock tests are still available", async () => {
    const models = await listOpenAIModels(process.env.OPENAI_API_KEY!);
    const referenced = scrapeModels(/\b(gpt-4o(?:-mini)?|gpt-4|gpt-3\.5-turbo)\b/g, sourceFiles);

    if (referenced.length === 0) return; // no models found to check

    for (const m of referenced) {
      // OpenAI model list may include versioned variants — check prefix match
      const found = models.some((available) => available === m || available.startsWith(`${m}-`));
      expect(found, `Model ${m} no longer available at OpenAI`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic model availability", () => {
  it("models used in llmock tests are still available", async () => {
    const models = await listAnthropicModels(process.env.ANTHROPIC_API_KEY!);
    const referenced = scrapeModels(
      /\b(claude-3(?:\.\d+)?-(?:opus|sonnet|haiku)(?:-\d{8})?)\b/g,
      sourceFiles,
    );

    if (referenced.length === 0) return;

    for (const m of referenced) {
      const found = models.some((available) => available === m || available.startsWith(`${m}`));
      expect(found, `Model ${m} no longer available at Anthropic`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.GOOGLE_API_KEY)("Gemini model availability", () => {
  it("models used in llmock tests are still available", async () => {
    const models = await listGeminiModels(process.env.GOOGLE_API_KEY!);
    const referenced = scrapeModels(/\b(gemini-(?:[\w.-]+))\b/g, sourceFiles);

    if (referenced.length === 0) return;

    // Skip experimental and live-only models — they're ephemeral
    const stable = referenced.filter((m) => !m.includes("-exp") && !m.endsWith("-live"));

    for (const m of stable) {
      const found = models.some((available) => available === m || available.startsWith(`${m}`));
      expect(found, `Model ${m} no longer available at Gemini`).toBe(true);
    }
  });
});
