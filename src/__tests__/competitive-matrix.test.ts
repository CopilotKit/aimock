import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// These tests exercise the REAL functions from the drift-automation script
// (not a reimplemented mirror), so behavioral bugs surface here directly.
import {
  countProviders,
  extractFeatures,
  buildMigrationRowPatterns,
  updateProviderCounts,
  updateMigrationPage,
  parseCurrentMatrix,
  computeChanges,
  applyChanges,
  COMPETITOR_MIGRATION_PAGES,
  type DetectedChange,
} from "../../scripts/update-competitive-matrix.ts";

// Repo root: this file lives at <root>/src/__tests__/, so up two levels.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("provider count extraction from README text", () => {
  it("counts distinct providers from a README mentioning several", () => {
    const readme = `
      Supports OpenAI, Anthropic Claude, Google Gemini, AWS Bedrock,
      Azure OpenAI, and Cohere.
    `;
    expect(countProviders(readme)).toBe(6);
  });

  it("de-duplicates overlapping patterns (anthropic + claude = 1)", () => {
    const readme = "Works with Anthropic and Claude models.";
    expect(countProviders(readme)).toBe(1);
  });

  it("de-duplicates aws + bedrock as one provider", () => {
    const readme = "Supports AWS Bedrock for model inference.";
    expect(countProviders(readme)).toBe(1);
  });

  it("returns 0 for text with no provider mentions", () => {
    expect(countProviders("This is a generic testing library.")).toBe(0);
  });

  it("counts all 13 provider groups when all are mentioned (Gemini Interactions is not its own group)", () => {
    const readme = `
      OpenAI, Claude, Gemini, Gemini Interactions, Bedrock, Azure, Vertex AI,
      Ollama, Cohere, Mistral, Groq, Together AI, Llama, ElevenLabs
    `;
    expect(countProviders(readme)).toBe(13);
  });

  it("is case-insensitive", () => {
    expect(countProviders("OPENAI and ANTHROPIC")).toBe(2);
  });
});

describe("migration page table update logic", () => {
  const SAMPLE_TABLE = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th>TestComp</th>
      <th>aimock</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>WebSocket protocols</td>
      <td style="color: var(--error)">&#10007;</td>
      <td style="color: var(--accent)">&#10003;</td>
    </tr>
    <tr>
      <td>Streaming SSE</td>
      <td style="color: var(--accent)">&#10003;</td>
      <td style="color: var(--accent)">&#10003;</td>
    </tr>
    <tr>
      <td>Structured output</td>
      <td style="color: var(--error)">&#10007;</td>
      <td style="color: var(--accent)">&#10003;</td>
    </tr>
  </tbody>
</table>`;

  it("updates a No cell to Yes when the feature is detected", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": true,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html, changes } = updateMigrationPage(SAMPLE_TABLE, "TestComp", features, 0);

    // WebSocket protocols row should now show checkmark
    expect(html).toContain(
      '<td>WebSocket protocols</td>\n      <td style="color: var(--accent)">&#10003;</td>',
    );
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]).toContain("WebSocket protocols");
  });

  it("does not downgrade an already-yes cell", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": true, // maps to "Streaming SSE" variant
      "WebSocket APIs": false,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html } = updateMigrationPage(SAMPLE_TABLE, "TestComp", features, 0);

    // Streaming SSE was already checkmark, should remain unchanged
    expect(html).toContain(
      '<td>Streaming SSE</td>\n      <td style="color: var(--accent)">&#10003;</td>',
    );
  });

  it("returns no changes when no table is found", () => {
    const noTableHtml = "<html><body><p>No table here</p></body></html>";
    const features: Record<string, boolean> = {
      "WebSocket APIs": true,
      "Chat Completions SSE": false,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html, changes } = updateMigrationPage(noTableHtml, "TestComp", features, 5);

    expect(html).toBe(noTableHtml);
    expect(changes).toHaveLength(0);
  });

  it("handles endpoint-table class as well as comparison-table", () => {
    const endpointTable = SAMPLE_TABLE.replace("comparison-table", "endpoint-table");
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": true,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { changes } = updateMigrationPage(endpointTable, "TestComp", features, 0);

    expect(changes.length).toBeGreaterThan(0);
  });

  it("updates multiple features in one pass", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": true,
      "Embeddings API": false,
      "Structured output / JSON mode": true,
    };

    const { html, changes } = updateMigrationPage(SAMPLE_TABLE, "TestComp", features, 0);

    // Both WebSocket protocols and Structured output should be updated
    expect(changes.length).toBe(2);
    expect(html).not.toContain("&#10007;");
  });
});

describe("scoped provider count updates", () => {
  it("updates competitor column in provider table row", () => {
    const html = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th>TestComp</th>
      <th>aimock</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>LLM providers</td>
      <td>5 providers</td>
      <td>12 providers</td>
    </tr>
  </tbody>
</table>`;
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    // TestComp's cell should be updated
    expect(result).toContain("8 providers");
    // aimock's 12 providers should be left alone
    expect(result).toContain("12 providers");
    expect(changes.length).toBe(1);
  });

  it("does not corrupt aimock's own provider count", () => {
    const html = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th>aimock</th>
      <th>TestComp</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Multi-provider support</td>
      <td>12 providers</td>
      <td>5 providers</td>
    </tr>
  </tbody>
</table>`;
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    // aimock's count must remain 12
    expect(result).toContain("12 providers");
    // TestComp's count should be updated to 8
    expect(result).toContain("8 providers");
  });

  it("updates prose mentioning the competitor by name", () => {
    const html = "<p>TestComp supports 5 providers today.</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    expect(result).toContain("8 providers");
    expect(changes.length).toBe(1);
  });

  it("does not update prose about aimock when updating competitor", () => {
    const html = "<p>aimock supports 12 providers natively.</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 15, changes);

    // aimock's claim in prose should not be touched
    expect(result).toContain("12 providers");
    expect(changes).toHaveLength(0);
  });

  it("does not update when detected count is lower or equal", () => {
    const html = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th>TestComp</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>LLM providers</td>
      <td>10 providers</td>
    </tr>
  </tbody>
</table>`;
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    expect(result).toContain("10 providers");
    expect(changes).toHaveLength(0);
  });

  it("handles no numeric claims gracefully", () => {
    const html = "<p>A great testing tool.</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 5, changes);

    expect(result).toBe(html);
    expect(changes).toHaveLength(0);
  });

  it("does not change provider count when equal", () => {
    const html = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th>TestComp</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>LLM providers</td>
      <td>8 providers</td>
    </tr>
  </tbody>
</table>`;
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    expect(result).toContain("8 providers");
    expect(changes).toHaveLength(0);
  });
});

describe("migration page update with provider counts", () => {
  const PAGE_WITH_COUNTS = `
<p>TestComp supports 5 providers today.</p>
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th>TestComp</th>
      <th>aimock</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>LLM providers</td>
      <td>5+</td>
      <td>10+</td>
    </tr>
    <tr>
      <td>WebSocket protocols</td>
      <td style="color: var(--error)">&#10007;</td>
      <td style="color: var(--accent)">&#10003;</td>
    </tr>
  </tbody>
</table>`;

  it("updates both feature cells and provider counts in one call", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": true,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html, changes } = updateMigrationPage(PAGE_WITH_COUNTS, "TestComp", features, 8);

    // Feature cell should be updated
    expect(html).not.toContain("&#10007;");
    // Provider count should be updated somewhere
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves provider count alone when detected is not higher", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": false,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html, changes } = updateMigrationPage(PAGE_WITH_COUNTS, "TestComp", features, 3);

    // Count should remain as-is
    expect(html).toContain("5 providers");
    expect(changes).toHaveLength(0);
  });
});

describe("buildMigrationRowPatterns", () => {
  it("returns the original label plus variants", () => {
    const patterns = buildMigrationRowPatterns("WebSocket APIs");
    expect(patterns).toContain("WebSocket APIs");
    expect(patterns).toContain("WebSocket protocols");
  });

  it("returns just the label for unknown rules", () => {
    const patterns = buildMigrationRowPatterns("Some Unknown Feature");
    expect(patterns).toEqual(["Some Unknown Feature"]);
  });

  it("returns multiple variants for Chat Completions SSE", () => {
    const patterns = buildMigrationRowPatterns("Chat Completions SSE");
    expect(patterns).toContain("OpenAI Chat Completions");
    expect(patterns).toContain("Streaming SSE");
  });
});

describe("parseCurrentMatrix header extraction", () => {
  const MATRIX_WITH_LINKS = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th class="col-aimock"><a href="https://github.com/CopilotKit/aimock">aimock</a></th>
      <th><a href="https://github.com/mswjs/msw">MSW</a></th>
      <th><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>
      <th><a href="https://github.com/dwmkerr/mock-llm">mock-llm</a></th>
      <th><a href="https://github.com/piyook/llm-mock">piyook/llm-mock</a></th>
      <th><a href="https://github.com/mokksy/ai-mocks">mokksy/ai-mocks</a></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Chat Completions SSE</td>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="manual">manual</span></td>
      <td><span class="yes">&#10003;</span></td>
      <td><span class="yes">&#10003;</span></td>
      <td><span class="yes">&#10003;</span></td>
      <td><span class="yes">&#10003;</span></td>
    </tr>
    <tr>
      <td>WebSocket APIs</td>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td class="no">No</td>
    </tr>
  </tbody>
</table>`;

  it("extracts all 6 competitor headers from linked <th> elements", () => {
    const { headers } = parseCurrentMatrix(MATRIX_WITH_LINKS);
    expect(headers).toHaveLength(6);
    expect(headers).toEqual([
      "aimock",
      "MSW",
      "VidaiMock",
      "mock-llm",
      "piyook/llm-mock",
      "mokksy/ai-mocks",
    ]);
  });

  it("maps each header to the correct column index", () => {
    const { headers } = parseCurrentMatrix(MATRIX_WITH_LINKS);
    expect(headers[0]).toBe("aimock");
    expect(headers[1]).toBe("MSW");
    expect(headers[2]).toBe("VidaiMock");
    expect(headers[3]).toBe("mock-llm");
    expect(headers[4]).toBe("piyook/llm-mock");
    expect(headers[5]).toBe("mokksy/ai-mocks");
  });

  it("correctly parses row data for each competitor column", () => {
    const { rows } = parseCurrentMatrix(MATRIX_WITH_LINKS);
    const chatRow = rows.get("Chat Completions SSE");
    expect(chatRow).toBeDefined();
    expect(chatRow!.get("mokksy/ai-mocks")).toContain("&#10003;");
  });

  it("fails to parse headers when <th> lacks <a> anchor tags", () => {
    const noLinks = MATRIX_WITH_LINKS.replace(/<a[^>]*>(.*?)<\/a>/g, "$1");
    const { headers } = parseCurrentMatrix(noLinks);
    expect(headers).toHaveLength(0);
  });
});

describe("computeChanges with actual HTML cell structure", () => {
  // This matrix uses the actual HTML structure from docs/index.html:
  // cells contain <span class="no">&#10007;</span> not bare "No"
  const ACTUAL_HTML_MATRIX = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th class="col-aimock"><a href="https://github.com/CopilotKit/aimock">aimock</a></th>
      <th><a href="https://github.com/mswjs/msw">MSW</a></th>
      <th><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>
      <th><a href="https://github.com/dwmkerr/mock-llm">mock-llm</a></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>WebSocket APIs</td>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
    </tr>
    <tr>
      <td>Chat Completions SSE</td>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="manual">manual</span></td>
      <td><span class="yes">&#10003;</span></td>
      <td><span class="yes">&#10003;</span></td>
    </tr>
    <tr>
      <td>Embeddings API</td>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="yes">&#10003;</span></td>
      <td><span class="no">&#10007;</span></td>
    </tr>
  </tbody>
</table>`;

  it("detects changes when cells contain span.no markup", () => {
    const matrix = parseCurrentMatrix(ACTUAL_HTML_MATRIX);
    const features = new Map<string, Record<string, boolean>>();
    features.set("VidaiMock", {
      "WebSocket APIs": true,
      "Chat Completions SSE": true,
      "Embeddings API": false,
    });

    const changes = computeChanges(ACTUAL_HTML_MATRIX, matrix, features);

    // VidaiMock WebSocket APIs cell has <span class="no">&#10007;</span> -> should be detected
    expect(changes).toHaveLength(1);
    expect(changes[0].competitor).toBe("VidaiMock");
    expect(changes[0].capability).toBe("WebSocket APIs");
  });

  it("does not flag already-yes cells as changes", () => {
    const matrix = parseCurrentMatrix(ACTUAL_HTML_MATRIX);
    const features = new Map<string, Record<string, boolean>>();
    features.set("VidaiMock", {
      "Chat Completions SSE": true, // already <span class="yes">
      "WebSocket APIs": false,
      "Embeddings API": false,
    });

    const changes = computeChanges(ACTUAL_HTML_MATRIX, matrix, features);

    expect(changes).toHaveLength(0);
  });

  it("does not flag manual cells as changes", () => {
    const matrix = parseCurrentMatrix(ACTUAL_HTML_MATRIX);
    const features = new Map<string, Record<string, boolean>>();
    features.set("MSW", {
      "Chat Completions SSE": true, // MSW has <span class="manual">manual</span>
      "WebSocket APIs": false,
      "Embeddings API": false,
    });

    const changes = computeChanges(ACTUAL_HTML_MATRIX, matrix, features);

    // MSW's manual cell should not trigger a change
    expect(changes).toHaveLength(0);
  });

  it("detects changes for multiple competitors at once", () => {
    const matrix = parseCurrentMatrix(ACTUAL_HTML_MATRIX);
    const features = new Map<string, Record<string, boolean>>();
    features.set("VidaiMock", {
      "WebSocket APIs": true,
      "Chat Completions SSE": false,
      "Embeddings API": false,
    });
    features.set("mock-llm", {
      "WebSocket APIs": true,
      "Chat Completions SSE": false,
      "Embeddings API": true,
    });

    const changes = computeChanges(ACTUAL_HTML_MATRIX, matrix, features);

    expect(changes).toHaveLength(3);
    const competitors = changes.map((c) => c.competitor);
    expect(competitors).toContain("VidaiMock");
    expect(competitors).toContain("mock-llm");
  });
});

describe("applyChanges with actual HTML cell structure", () => {
  const ACTUAL_HTML_MATRIX = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th class="col-aimock"><a href="https://github.com/CopilotKit/aimock">aimock</a></th>
      <th><a href="https://github.com/mswjs/msw">MSW</a></th>
      <th><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>
      <th><a href="https://github.com/dwmkerr/mock-llm">mock-llm</a></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>WebSocket APIs</td>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
    </tr>
    <tr>
      <td>Embeddings API</td>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="yes">&#10003;</span></td>
      <td><span class="no">&#10007;</span></td>
    </tr>
  </tbody>
</table>`;

  it("replaces span.no cell with span.yes cell for the correct competitor column", () => {
    const changes: DetectedChange[] = [
      { competitor: "VidaiMock", capability: "WebSocket APIs", from: "No", to: "Yes" },
    ];

    const result = applyChanges(ACTUAL_HTML_MATRIX, changes);

    // VidaiMock's WebSocket APIs cell should now be yes
    // Parse to verify only VidaiMock column changed
    const matrix = parseCurrentMatrix(result);
    const wsRow = matrix.rows.get("WebSocket APIs");
    expect(wsRow).toBeDefined();
    // VidaiMock should now have yes checkmark
    expect(wsRow!.get("VidaiMock")).toContain("&#10003;");
    expect(wsRow!.get("VidaiMock")).toContain('class="yes"');
    // MSW and mock-llm should still have no
    expect(wsRow!.get("MSW")).toContain("&#10007;");
    expect(wsRow!.get("mock-llm")).toContain("&#10007;");
  });

  it("does not modify cells in other rows", () => {
    const changes: DetectedChange[] = [
      { competitor: "VidaiMock", capability: "WebSocket APIs", from: "No", to: "Yes" },
    ];

    const result = applyChanges(ACTUAL_HTML_MATRIX, changes);

    const matrix = parseCurrentMatrix(result);
    const embRow = matrix.rows.get("Embeddings API");
    expect(embRow).toBeDefined();
    // VidaiMock's Embeddings API cell was already yes, should remain
    expect(embRow!.get("VidaiMock")).toContain("&#10003;");
  });

  it("applies multiple changes across different rows and competitors", () => {
    const changes: DetectedChange[] = [
      { competitor: "VidaiMock", capability: "WebSocket APIs", from: "No", to: "Yes" },
      { competitor: "mock-llm", capability: "Embeddings API", from: "No", to: "Yes" },
    ];

    const result = applyChanges(ACTUAL_HTML_MATRIX, changes);

    const matrix = parseCurrentMatrix(result);
    expect(matrix.rows.get("WebSocket APIs")!.get("VidaiMock")).toContain('class="yes"');
    expect(matrix.rows.get("Embeddings API")!.get("mock-llm")).toContain('class="yes"');
  });

  it("returns html unchanged when changes array is empty", () => {
    const result = applyChanges(ACTUAL_HTML_MATRIX, []);
    expect(result).toBe(ACTUAL_HTML_MATRIX);
  });
});

describe("extractFeatures keyword precision", () => {
  it("does not trigger Embeddings API on bare word 'embed'", () => {
    const text = "You can embed this widget in your page.";
    const features = extractFeatures(text);
    expect(features["Embeddings API"]).toBe(false);
  });

  it("triggers Embeddings API on /v1/embeddings path", () => {
    const text = "Supports the /v1/embeddings endpoint for vector generation.";
    const features = extractFeatures(text);
    expect(features["Embeddings API"]).toBe(true);
  });

  it("triggers Embeddings API on 'embeddings api' phrase", () => {
    const text = "Full support for the embeddings API.";
    const features = extractFeatures(text);
    expect(features["Embeddings API"]).toBe(true);
  });

  it("does not trigger Image generation on bare word 'image'", () => {
    const text = "See the image below for architecture details.";
    const features = extractFeatures(text);
    expect(features["Image generation"]).toBe(false);
  });

  it("triggers Image generation on 'dall-e' or '/v1/images'", () => {
    const text = "Generate images via DALL-E or the /v1/images endpoint.";
    const features = extractFeatures(text);
    expect(features["Image generation"]).toBe(true);
  });

  it("does not trigger Video generation on bare word 'video'", () => {
    const text = "Watch the video tutorial for setup instructions.";
    const features = extractFeatures(text);
    expect(features["Video generation"]).toBe(false);
  });

  it("triggers Video generation on 'video generation' phrase", () => {
    const text = "Supports video generation via the Sora API.";
    const features = extractFeatures(text);
    expect(features["Video generation"]).toBe(true);
  });

  it("does not trigger Docker image on bare word 'docker'", () => {
    const text = "This is like a docker for your tests.";
    const features = extractFeatures(text);
    expect(features["Docker image"]).toBe(false);
  });

  it("triggers Docker image on 'dockerfile' or 'docker image'", () => {
    const text = "Includes a Dockerfile for easy deployment.";
    const features = extractFeatures(text);
    expect(features["Docker image"]).toBe(true);
  });

  it("triggers Docker image on 'docker run'", () => {
    const text = "Run with: docker run -p 8080:8080 aimock";
    const features = extractFeatures(text);
    expect(features["Docker image"]).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression coverage for the 6 pre-existing drift-automation bugs. Each block
// is a red→green repro: it fails against the pre-fix script and passes after.
// ═══════════════════════════════════════════════════════════════════════════

// ── Bug 1: migration-page paths must resolve; missing competitor mapping ─────
describe("Bug 1: COMPETITOR_MIGRATION_PAGES", () => {
  it("maps every mapped competitor to a file that actually exists on disk", () => {
    for (const [competitor, relPath] of Object.entries(COMPETITOR_MIGRATION_PAGES)) {
      const abs = resolve(REPO_ROOT, relPath);
      expect(existsSync(abs), `${competitor} -> ${relPath} should exist`).toBe(true);
    }
  });

  it("includes a mapping for the mokksy/ai-mocks competitor", () => {
    expect(COMPETITOR_MIGRATION_PAGES["mokksy/ai-mocks"]).toBeDefined();
  });
});

// ── Bug 2: unanchored keyword regexes → false substring flips ────────────────
describe("Bug 2: extractFeatures keyword anchoring", () => {
  it('does not flip "CLI server" from the words "client"/"click"', () => {
    const feats = extractFeatures("This mock has a Python client library and you click buttons.");
    expect(feats["CLI server"]).toBe(false);
  });

  it('does not flip "Chat Completions SSE" from the word "assess"', () => {
    const feats = extractFeatures("We assess the output quality carefully.");
    expect(feats["Chat Completions SSE"]).toBe(false);
  });

  it("still detects a genuine standalone CLI mention", () => {
    const feats = extractFeatures("Run it via npx or the cli command.");
    expect(feats["CLI server"]).toBe(true);
  });

  it("still detects a genuine standalone SSE / streaming mention", () => {
    const feats = extractFeatures("Supports SSE streaming responses.");
    expect(feats["Chat Completions SSE"]).toBe(true);
  });
});

// ── Bug 3: countProviders substring inflation + redundant group ──────────────
describe("Bug 3: countProviders substring safety", () => {
  it('does not count "cohere" inside "coherent" or "aws" inside "flaws"', () => {
    expect(countProviders("The system is coherent and has flaws.")).toBe(0);
  });

  it("counts Gemini exactly once (no redundant gemini-interactions group)", () => {
    expect(countProviders("gemini interactions with the model")).toBe(1);
  });
});

// ── Bug 4: String.replace $-sequence corruption ──────────────────────────────
describe("Bug 4: literal $-sequences in HTML replacements stay literal", () => {
  const matrixWithDollar = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th class="col-aimock"><a href="#">aimock</a></th>
      <th><a href="#">VidaiMock</a></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Docker image</td>
      <td class="col-aimock"><span class="yes">&#10003; price $&amp;</span></td>
      <td><span class="no">&#10007;</span></td>
    </tr>
  </tbody>
</table>`;

  it("applyChanges does not duplicate the row when replacement text contains $&", () => {
    const result = applyChanges(matrixWithDollar, [
      { competitor: "VidaiMock", capability: "Docker image", from: "No", to: "Yes" },
    ]);
    // The competitor cell flips to "yes".
    expect(result).toContain('<td><span class="yes">&#10003;</span></td>');
    // The row label must appear exactly once — a $&-expanding replace duplicates it.
    expect((result.match(/Docker image/g) || []).length).toBe(1);
  });

  it("updateProviderCounts does not corrupt the table when a cell contains $&", () => {
    const migration = `
<table class="comparison-table">
  <thead>
    <tr><th>Capability</th><th>VidaiMock</th><th>aimock</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>LLM providers supported</td>
      <td style="color: var(--text-dim)">3 providers $&amp;</td>
      <td style="color: var(--accent)">13 providers</td>
    </tr>
  </tbody>
</table>`;
    const changes: string[] = [];
    const result = updateProviderCounts(migration, "VidaiMock", 8, changes);
    expect(result).toContain("8 providers");
    // Table label must not be duplicated by $&-expansion.
    expect((result.match(/LLM providers supported/g) || []).length).toBe(1);
  });
});

// ── Bug 5: migration cell column located by header name, not adjacency ───────
describe("Bug 5: migration cell column resolution by header name", () => {
  it("flips the competitor cell even when aimock is the first data column", () => {
    const migration = `
<table class="comparison-table">
  <thead>
    <tr><th>Capability</th><th>aimock</th><th>VidaiMock</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Docker</td>
      <td style="color: var(--accent)">&#10003;</td>
      <td style="color: var(--error)">&#10007;</td>
    </tr>
  </tbody>
</table>`;
    const { html } = updateMigrationPage(migration, "VidaiMock", { "Docker image": true }, 0);
    // The only error cell (VidaiMock) must be flipped to accent; none remain,
    // and aimock's original accent cell is untouched (2 accent cells total).
    expect(html).not.toContain("var(--error)");
    expect((html.match(/var\(--accent\)/g) || []).length).toBe(2);
  });

  it("resolves the column when the header text differs from the competitor key (Mokksy)", () => {
    const migration = `
<table class="comparison-table">
  <thead>
    <tr><th>Capability</th><th>Mokksy</th><th>aimock</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>LLM providers supported</td>
      <td style="color: var(--text-dim)">3 providers</td>
      <td style="color: var(--accent)">13 providers</td>
    </tr>
  </tbody>
</table>`;
    const { html } = updateMigrationPage(migration, "mokksy/ai-mocks", {}, 8);
    expect(html).toContain("8 providers");
  });
});

// ── Bug 6: orphaned variant key renamed to the real FEATURE_RULE label ───────
describe("Bug 6: buildMigrationRowPatterns realtime variant key", () => {
  it("returns variants for the real rule label 'Realtime transcription/translation'", () => {
    const patterns = buildMigrationRowPatterns("Realtime transcription/translation");
    expect(patterns.length).toBeGreaterThan(1);
    expect(patterns).toContain("Translate/Whisper");
  });

  it("flips a migration row that uses a variant label for the realtime rule", () => {
    const migration = `
<table class="comparison-table">
  <thead>
    <tr><th>Capability</th><th>VidaiMock</th><th>aimock</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Translate/Whisper</td>
      <td style="color: var(--error)">&#10007;</td>
      <td style="color: var(--accent)">&#10003;</td>
    </tr>
  </tbody>
</table>`;
    const { html, changes } = updateMigrationPage(
      migration,
      "VidaiMock",
      { "Realtime transcription/translation": true },
      0,
    );
    expect(changes.length).toBeGreaterThan(0);
    expect(html).not.toContain("var(--error)");
  });
});

// ── Regression guard: PR #328 OpenRouter entry must keep working ─────────────
describe("Regression guard: OpenRouter router / fallback simulation (PR #328)", () => {
  const ROW = "OpenRouter router / fallback simulation";

  it("detects OpenRouter fallback signals", () => {
    const feats = extractFeatures("Supports OpenRouter with allow_fallbacks and provider routing.");
    expect(feats[ROW]).toBe(true);
  });

  it("does not false-trigger on an unrelated 'router' mention", () => {
    const feats = extractFeatures("This is a router for plain HTTP requests.");
    expect(feats[ROW]).toBe(false);
  });

  it("keeps its migration row variants", () => {
    const patterns = buildMigrationRowPatterns(ROW);
    expect(patterns).toContain("Model fallback/failover");
  });
});
