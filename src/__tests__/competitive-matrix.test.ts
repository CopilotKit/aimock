import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// These tests exercise the REAL functions from the competitive-matrix script
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
  findUnmatchedCompetitors,
  COMPETITOR_MIGRATION_PAGES,
  MIGRATION_COMBINED_ROWS,
  runMatrixUpdate,
  type DetectedChange,
} from "../../scripts/update-competitive-matrix.js";
import { migrationCell, seedCells, withMigrationCell } from "./competitive-watch-fixture.js";

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

  it("throws when no table is found", () => {
    const noTableHtml = "<html><body><p>No table here</p></body></html>";
    const features: Record<string, boolean> = {
      "WebSocket APIs": true,
      "Chat Completions SSE": false,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    expect(() => updateMigrationPage(noTableHtml, "TestComp", features, 5)).toThrow(/table/i);
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

  it("reports every competitor as unmatched when <th> lacks <a> anchor tags", () => {
    const noLinks = MATRIX_WITH_LINKS.replace(/<a[^>]*>(.*?)<\/a>/g, "$1");
    const matrix = parseCurrentMatrix(noLinks);
    expect(matrix.headers).toHaveLength(0);
    expect(findUnmatchedCompetitors(matrix)).toEqual([
      "VidaiMock",
      "mock-llm",
      "piyook/llm-mock",
      "mokksy/ai-mocks",
    ]);
  });
});

describe("computeChanges with actual HTML cell structure", () => {
  // This matrix uses the span.no/span.yes cell markup of docs/index.html:
  // cells contain <span class="no">&#10007;</span>, not bare "No". Row labels
  // are simplified to <td>; the real page uses <th scope="row">.
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

    const result = applyChanges(ACTUAL_HTML_MATRIX, changes).html;

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

    const result = applyChanges(ACTUAL_HTML_MATRIX, changes).html;

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

    const result = applyChanges(ACTUAL_HTML_MATRIX, changes).html;

    const matrix = parseCurrentMatrix(result);
    expect(matrix.rows.get("WebSocket APIs")!.get("VidaiMock")).toContain('class="yes"');
    expect(matrix.rows.get("Embeddings API")!.get("mock-llm")).toContain('class="yes"');
  });

  it("returns html unchanged when changes array is empty", () => {
    const result = applyChanges(ACTUAL_HTML_MATRIX, []);
    expect(result).toEqual({ html: ACTUAL_HTML_MATRIX, applied: [], unapplied: [] });
  });
});

describe("applyChanges keeps the other text in every no-cell shape", () => {
  // Built from the real docs/index.html conventions: <th scope="row"> row
  // labels, classes on the inner <span>, never on the <td> itself.
  const YES = '<span class="yes" role="img" aria-label="Yes">&#10003;</span>';
  const matrixWith = (cell: string) => `
<table class="comparison-table">
  <thead>
    <tr>
      <th scope="col">Capability</th>
      <th scope="col" class="col-aimock"><a href="https://github.com/CopilotKit/aimock">aimock</a></th>
      <th scope="col"><a href="https://github.com/mswjs/msw">MSW</a></th>
      <th scope="col"><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">WebSocket APIs</th>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="no" role="img" aria-label="No">&#10007;</span></td>
      ${cell}
    </tr>
  </tbody>
</table>`;
  const flip = (cell: string) => {
    const result = applyChanges(matrixWith(cell), [
      { competitor: "VidaiMock", capability: "WebSocket APIs", from: "No", to: "Yes" },
    ]);
    expect(result.unapplied).toEqual([]);
    return parseCurrentMatrix(result.html).rows.get("WebSocket APIs")!.get("VidaiMock")!;
  };

  it("span form: replaces only the span and keeps the text", () => {
    expect(
      flip('<td><span class="no" role="img" aria-label="No">&#10007;</span> (planned v2)</td>'),
    ).toBe(`${YES} (planned v2)`);
  });

  it("bare &#10007; form: replaces only the entity and keeps the text", () => {
    expect(flip("<td>&#10007; (planned v2)</td>")).toBe(`${YES} (planned v2)`);
  });

  it("bare ✗ form: replaces only the glyph and keeps the text", () => {
    expect(flip("<td>(planned v2) ✗</td>")).toBe(`(planned v2) ${YES}`);
  });

  it('bare cross in a <td class="no">: keeps the text and flips the cell class to yes', () => {
    const matrix = applyChanges(matrixWith('<td class="no">&#10007; (planned v2)</td>'), [
      { competitor: "VidaiMock", capability: "WebSocket APIs", from: "No", to: "Yes" },
    ]).html;
    expect(matrix).toContain(`<td class="yes">${YES} (planned v2)</td>`);
    expect(matrix).not.toContain('<td class="no">');
  });

  it("leaves the other no-cells in the row unchanged", () => {
    const matrix = applyChanges(matrixWith("<td>&#10007; (planned v2)</td>"), [
      { competitor: "VidaiMock", capability: "WebSocket APIs", from: "No", to: "Yes" },
    ]).html;
    expect(parseCurrentMatrix(matrix).rows.get("WebSocket APIs")!.get("MSW")).toBe(
      '<span class="no" role="img" aria-label="No">&#10007;</span>',
    );
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
// Behavior pins for the competitive-matrix script. Each block below names the
// behavior it checks.
// ═══════════════════════════════════════════════════════════════════════════

// ── Mapped migration-page paths exist; mokksy/ai-mocks has a mapping ─────────
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

// ── Keywords match only at word boundaries, not inside other words ───────────
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

// ── countProviders ignores substrings and counts Gemini once ─────────────────
describe("Bug 3: countProviders substring safety", () => {
  it('does not count "cohere" inside "coherent" or "aws" inside "flaws"', () => {
    expect(countProviders("The system is coherent and has flaws.")).toBe(0);
  });

  it("counts Gemini exactly once (no redundant gemini-interactions group)", () => {
    expect(countProviders("gemini interactions with the model")).toBe(1);
  });
});

// ── Literal $-sequences in replacement HTML stay literal ─────────────────────
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
    ]).html;
    // The competitor cell flips to "yes".
    expect(result).toContain(
      '<td><span class="yes" role="img" aria-label="Yes">&#10003;</span></td>',
    );
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

// ── Migration cell column is found by header name, not adjacency ─────────────
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

// ── Realtime variant key uses the real FEATURE_RULE label ────────────────────
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

// P1's model-fault detector is separate from generic transport chaos.
describe("model misbehavior feature detection", () => {
  const row = "Model misbehavior faults (tool-call JSON, schema, unknown tool, stop reasons)";

  it.each([
    ["malformed-tool-arguments", "Inject tool-call malformed arguments"],
    ["unknown-tool", "unknown tool"],
    ["content-filter-probability", "content filter probability"],
    ["invalid-json", "tool call emits invalid json"],
    ["schema-violation", "tool-call schema violation"],
    ["content-filter-block", "content-filter block"],
  ])("recognizes %s", (cell, source) => {
    const actual = extractFeatures(source)[row];
    console.log(JSON.stringify({ cell, source, actual: actual ?? null, expected: true }));
    expect(actual).toBe(true);
  });

  it.each([
    "chaos",
    "Chaos testing",
    "HTTP 429",
    "delay and disconnect",
    "tool calls",
    "schema validation",
  ])("does not infer model faults from %s", (source) => {
    const actual = extractFeatures(source)[row];
    console.log(JSON.stringify({ source, actual: actual ?? null, expected: false }));
    expect(actual).toBe(false);
  });
});

describe("MCP feature rules (spec D5)", () => {
  const hit = (text: string, label: string) => extractFeatures(text)[label] === true;
  const MOCKING = "MCP tool mocking";
  const SCOPED = "Scenario-scoped MCP tool fakes";
  const UNDECLARED = "Fail on undeclared MCP tool";

  it.each([
    "Mock MCP tools in your tests",
    "Use mocked MCP servers in CI",
    "MCP tool mocking",
    "MCP server mocks",
    // mock-llm README heading
    "## MCP (Model Context Protocol) Mocking",
  ])('"MCP tool mocking" matches mock + MCP close together, in either order: %s', (text) => {
    expect(hit(text, MOCKING)).toBe(true);
  });

  it.each([
    "Ships an MCP server for your IDE",
    "ships an MCP server and a mock HTTP server",
    "a mock HTTP server, and an MCP server",
    // Inflections match in both orders, but only when at most one word
    // separates "mock" and "MCP". Wider phrasings are given up so that a README
    // listing an MCP server next to an unrelated mock server stays false.
    "MCP servers can be mocked",
    "MCP servers you can mock",
  ])('"MCP tool mocking" does not match MCP and mock far apart: %s', (text) => {
    expect(hit(text, MOCKING)).toBe(false);
  });

  it.each([
    "MCP fixtures answer tools/call in sequence per test",
    "MCP fixtures answer tools/call in sequences",
    "MCP mocks return different results per scenario",
    "MCP mocking with scenarios",
    "MCP fakes keyed on tool arguments",
    "tools/call fixture answers per scenario",
    "tools/call fixtures cover several scenarios",
  ])('"Scenario-scoped MCP tool fakes" matches scoping wording: %s', (text) => {
    expect(hit(text, SCOPED)).toBe(true);
  });

  it.each(["mock MCP tools", "MCP tool mocking"])(
    '"Scenario-scoped MCP tool fakes" needs scoping, not just MCP mocking: %s',
    (text) => {
      expect(hit(text, SCOPED)).toBe(false);
    },
  );

  it.each([
    "An undeclared tool call fails the test",
    "Calls to undeclared tools fail the test",
    "Unmocked tools fail the run",
    "an unmocked tool call fails",
    "unmocked tool calls are denied",
    "deny unmocked tool calls",
    "the server denies unmocked tool calls",
  ])('"Fail on undeclared MCP tool" matches deny/fail wording: %s', (text) => {
    expect(hit(text, UNDECLARED)).toBe(true);
  });

  it("matches a bare undeclared tool with no deny/fail wording, by design", () => {
    // "undeclared tool" alone names the closed-world behavior, so the rule does
    // not ask for deny/fail wording next to it.
    expect(hit("Lists every undeclared tool in the journal", UNDECLARED)).toBe(true);
  });

  it.each(["an undeclared variable", "unmocked responses are passed through"])(
    '"Fail on undeclared MCP tool" does not match: %s',
    (text) => {
      expect(hit(text, UNDECLARED)).toBe(false);
    },
  );

  it("matches the mock-llm README MCP section", () => {
    const section = [
      "## MCP (Model Context Protocol) Mocking",
      "",
      "Mock-LLM exposes MCP servers and tools which support testing the MCP protocol.",
    ].join("\n");
    expect(hit(section, MOCKING)).toBe(true);
  });

  // Text that names mocks, MCP, or unmocked/undeclared things but does not
  // describe MCP tool mocking. None of the three MCP rows may flip on it.
  // "mock server MCP endpoint" is a mock HTTP server that also has an MCP
  // endpoint. That endpoint can be a real control API for the mock server, so
  // the phrase does not say that MCP tools are mocked. A false Yes on the public
  // homepage costs more than a missed detection, so it stays false.
  it.each([
    "Unmocked requests fail with a 404 so tests never hit the network.",
    "By default, unmocked HTTP calls are denied.",
    "unmocked calls pass through to the real API. This is the denominator",
    "an undeclared variable is used as the denominator",
    "unmocked calls pass through to a dense cache",
    "Run the mock server MCP endpoint",
    "mockserver mcp support",
    "MCP server mode: mock responses for chat completions; set arguments via CLI flags",
    "ships an MCP server and a mock HTTP server",
  ])("no MCP row matches unrelated text: %s", (text) => {
    expect(hit(text, MOCKING)).toBe(false);
    expect(hit(text, SCOPED)).toBe(false);
    expect(hit(text, UNDECLARED)).toBe(false);
  });
});

describe("MCP detections on the migration pages", () => {
  const MOCKING = "MCP tool mocking";
  const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf-8");
  const CROSS = '<td style="color: var(--error)">&#10007;</td>';

  it("maps MCP tool mocking to the per-competitor MCP rows and the combined rows", () => {
    const patterns = buildMigrationRowPatterns(MOCKING);
    expect(patterns).toContain("MCP protocol mocking");
    expect(patterns).toContain("MCP mock");
    expect(MIGRATION_COMBINED_ROWS["MCP / A2A / AG-UI / Vector"]).toContain(MOCKING);
    expect(MIGRATION_COMBINED_ROWS["MCP / A2A / AG-UI / Vector mocking"]).toContain(MOCKING);
  });

  // Each page's own "no" cell for the competitor (VidaiMock's page writes "No").
  const VIDAI_NO = "<td>No</td>";
  it.each([
    ["mock-llm", "MCP protocol mocking", "flipped", CROSS],
    ["mokksy/ai-mocks", "MCP mock", "flipped", CROSS],
    ["piyook/llm-mock", "MCP / A2A / AG-UI / Vector mocking", "combined-row", CROSS],
    ["VidaiMock", "MCP / A2A / AG-UI / Vector", "combined-row", VIDAI_NO],
  ] as const)("%s: an MCP tool mocking detection reaches %s (%s)", (comp, row, status, noCell) => {
    // The scan bot flips live cells, so always seed the competitor's cell (its
    // column, found through the table header) with the page's "no" cell first.
    const html = withMigrationCell(read(COMPETITOR_MIGRATION_PAGES[comp]), comp, row, noCell);
    expect(migrationCell(html, comp, row)).toBe(noCell);
    const result = updateMigrationPage(html, comp, { [MOCKING]: true }, 0);
    expect(result.outcomes).toEqual([
      { rule: MOCKING, row, combined: status === "combined-row", status },
    ]);
  });
});

describe("a homepage flip with no migration-page row is reported loudly", () => {
  const HOME_NO = '<td><span class="no" role="img" aria-label="No">&#10007;</span></td>';
  const CROSS = '<td style="color: var(--error)">&#10007;</td>';
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cm-norow-"));
    for (const rel of ["docs/index.html", ...Object.values(COMPETITOR_MIGRATION_PAGES)]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(resolve(REPO_ROOT, rel), join(root, rel));
    }
    // The scan bot flips these live cells; seed every cell the tests assert on.
    seedCells(root, [
      { page: "home", competitor: "mock-llm", row: "MCP tool mocking", cell: HOME_NO },
      { page: "home", competitor: "mock-llm", row: "Fail on undeclared MCP tool", cell: HOME_NO },
      { page: "migration", competitor: "mock-llm", row: "MCP protocol mocking", cell: CROSS },
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists the detection under the manual-check section with reason no-row", () => {
    const RULE = "Fail on undeclared MCP tool";
    const summary = join(root, "summary.md");
    runMatrixUpdate({
      repoRoot: root,
      competitorFeatures: new Map([["mock-llm", { [RULE]: true }]]),
      competitorProviderCounts: new Map(),
      dryRun: true,
      summaryPath: summary,
    });
    const md = readFileSync(summary, "utf-8");
    expect(md).toContain(`| mock-llm | ${RULE} | No -> Yes |`);
    const manual = md.slice(md.indexOf("## Migration Page Rows To Check By Hand"));
    expect(md).toContain("## Migration Page Rows To Check By Hand");
    expect(manual).toContain(
      `| \`docs/migrate-from-mock-llm/index.html\` | mock-llm | ${RULE} | none | no-row |`,
    );
  });

  it("does not list a homepage flip whose migration page has a row for it", () => {
    const summary = join(root, "summary.md");
    runMatrixUpdate({
      repoRoot: root,
      competitorFeatures: new Map([["mock-llm", { "MCP tool mocking": true }]]),
      competitorProviderCounts: new Map(),
      dryRun: true,
      summaryPath: summary,
    });
    const md = readFileSync(summary, "utf-8");
    expect(md).toContain("| mock-llm | MCP tool mocking | No -> Yes |");
    expect(md).toContain("mock-llm: MCP protocol mocking ✗ -> ✓");
    expect(md).not.toContain("no-row |");
  });
});
