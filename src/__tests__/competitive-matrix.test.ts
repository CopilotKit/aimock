import { describe, it, expect } from "vitest";

// ── Reimplement pure functions from scripts/update-competitive-matrix.ts ─────
// These mirror the logic so we can unit-test without requiring network access
// or dealing with import.meta.dirname in the test runner.

// ── Provider count detection ────────────────────────────────────────────────

const PROVIDER_GROUPS: string[][] = [
  ["openai"],
  ["claude", "anthropic"],
  ["gemini", "google.*ai"],
  ["bedrock", "aws"],
  ["azure"],
  ["vertex"],
  ["ollama"],
  ["cohere"],
  ["mistral"],
  ["groq"],
  ["together"],
  ["llama"],
];

function countProviders(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const group of PROVIDER_GROUPS) {
    const found = group.some((kw) => new RegExp(kw, "i").test(lower));
    if (found) count++;
  }
  return count;
}

// ── Feature rules (subset needed for tests) ────────────────────────────────

interface FeatureRule {
  rowLabel: string;
  keywords: string[];
}

const FEATURE_RULES: FeatureRule[] = [
  {
    rowLabel: "Chat Completions SSE",
    keywords: ["chat/completions", "streaming", "SSE", "server-sent", "stream.*true"],
  },
  {
    rowLabel: "WebSocket APIs",
    keywords: ["websocket", "realtime", "ws://", "wss://"],
  },
  {
    rowLabel: "Embeddings API",
    keywords: ["/v1/embeddings", "embeddings api", "embedding endpoint", "embedding model"],
  },
  {
    rowLabel: "Image generation",
    keywords: ["dall-e", "dalle", "/v1/images", "image generation", "imagen", "generate.*image"],
  },
  {
    rowLabel: "Video generation",
    keywords: ["sora", "/v1/videos", "video generation", "generate.*video"],
  },
  {
    rowLabel: "Docker image",
    keywords: ["dockerfile", "docker image", "docker-compose", "docker compose", "docker run"],
  },
  {
    rowLabel: "Structured output / JSON mode",
    keywords: ["json_object", "json_schema", "structured output", "response_format"],
  },
];

function extractFeatures(text: string): Record<string, boolean> {
  const lower = text.toLowerCase();
  const result: Record<string, boolean> = {};
  for (const rule of FEATURE_RULES) {
    const found = rule.keywords.some((kw) => {
      const pattern = new RegExp(kw.toLowerCase(), "i");
      return pattern.test(lower);
    });
    result[rule.rowLabel] = found;
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ── Migration page row pattern builder ──────────────────────────────────────

function buildMigrationRowPatterns(rowLabel: string): string[] {
  const patterns = [rowLabel];
  const variants: Record<string, string[]> = {
    "Chat Completions SSE": ["OpenAI Chat Completions", "Streaming SSE"],
    "Responses API SSE": ["OpenAI Responses API"],
    "Claude Messages API": ["Anthropic Claude"],
    "Gemini streaming": ["Google Gemini"],
    "WebSocket APIs": ["WebSocket protocols"],
    "Structured output / JSON mode": ["Structured output / JSON mode", "Structured output"],
    "Sequential / stateful responses": ["Sequential responses"],
    "Docker image": ["Docker"],
    "Fixture files (JSON)": ["Fixture files"],
    "CLI server": ["CLI"],
    "Error injection (one-shot)": ["Error injection"],
    "Request journal": ["Request journal"],
    "Drift detection": ["Drift detection"],
  };
  if (variants[rowLabel]) {
    patterns.push(...variants[rowLabel]);
  }
  return patterns;
}

// ── Provider count update logic (scoped version) ───────────────────────────

/** Replaces "N providers" or "N+ providers" in a string if detected > current */
function replaceProviderCount(text: string, detectedCount: number): string {
  return text.replace(/(\d+)\+?\s*(?:LLM\s*)?providers?/gi, (match, numStr) => {
    const currentCount = parseInt(numStr, 10);
    if (detectedCount > currentCount) {
      return `${detectedCount} providers`;
    }
    return match;
  });
}

function updateProviderCounts(
  html: string,
  competitorName: string,
  detectedCount: number,
  changes: string[],
): string {
  let result = html;
  const escapedName = escapeRegex(competitorName);

  // Strategy 1: Replace provider counts in table rows about providers,
  // scoped to the competitor's column.
  const tableMatch = result.match(
    /<table class="(?:comparison-table|endpoint-table)">([\s\S]*?)<\/table>/,
  );
  if (tableMatch) {
    const fullTable = tableMatch[0];

    // Find the competitor's column index from headers
    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/g;
    const thTexts: string[] = [];
    let thM: RegExpExecArray | null;
    while ((thM = thRegex.exec(fullTable)) !== null) {
      thTexts.push(thM[1].trim());
    }
    const compColIdx = thTexts.findIndex((t) => t.includes(competitorName) || t === competitorName);

    if (compColIdx >= 0) {
      const updatedTable = fullTable.replace(
        /<tr>([\s\S]*?)<\/tr>/g,
        (trMatch, trContent: string) => {
          const firstTd = trContent.match(/<td[^>]*>([\s\S]*?)<\/td>/);
          if (!firstTd || !/provider/i.test(firstTd[1])) return trMatch;

          let cellIdx = 0;
          return trMatch.replace(/<td[^>]*>([\s\S]*?)<\/td>/g, (tdMatch, tdContent: string) => {
            const currentIdx = cellIdx++;
            if (currentIdx !== compColIdx) return tdMatch;

            const updated = replaceProviderCount(tdContent, detectedCount);
            if (updated !== tdContent) {
              const oldCount = tdContent.match(/(\d+)/)?.[1] ?? "?";
              changes.push(
                `${competitorName}: provider count ${oldCount} -> ${detectedCount} (table)`,
              );
              return tdMatch.replace(tdContent, updated);
            }
            return tdMatch;
          });
        },
      );

      result = result.replace(fullTable, updatedTable);
    }
  }

  // Strategy 2: Replace provider counts in prose paragraphs/sentences that
  // explicitly mention the competitor by name.
  const prosePattern = new RegExp(
    `(<[^>]*>[^<]*${escapedName}[^<]*)(\\d+)\\+?\\s*(?:LLM\\s*)?providers?`,
    "gi",
  );
  result = result.replace(prosePattern, (match, prefix, numStr) => {
    const currentCount = parseInt(numStr, 10);
    if (detectedCount > currentCount) {
      changes.push(`${competitorName}: provider count ${currentCount} -> ${detectedCount} (prose)`);
      return match.replace(/(\d+)\+?\s*(?:LLM\s*)?providers?/, `${detectedCount} providers`);
    }
    return match;
  });

  return result;
}

// ── Migration page update logic ─────────────────────────────────────────────

function updateMigrationPage(
  html: string,
  competitorName: string,
  features: Record<string, boolean>,
  providerCount: number,
): { html: string; changes: string[] } {
  let result = html;
  const changes: string[] = [];

  const tableMatch = result.match(
    /<table class="(?:comparison-table|endpoint-table)">([\s\S]*?)<\/table>/,
  );
  if (!tableMatch) {
    return { html: result, changes };
  }

  for (const rule of FEATURE_RULES) {
    if (!features[rule.rowLabel]) continue;

    const rowPatterns = buildMigrationRowPatterns(rule.rowLabel);
    for (const rowPat of rowPatterns) {
      const rowRegex = new RegExp(
        `(<tr>\\s*<td>${escapeRegex(rowPat)}</td>\\s*)<td style="color: var\\(--error\\)">&#10007;</td>`,
      );
      if (rowRegex.test(result)) {
        result = result.replace(rowRegex, `$1<td style="color: var(--accent)">&#10003;</td>`);
        changes.push(`${competitorName}: ${rowPat} ✗ -> ✓`);
      }
    }
  }

  if (providerCount > 0) {
    result = updateProviderCounts(result, competitorName, providerCount, changes);
  }

  return { html: result, changes };
}

// ── parseCurrentMatrix reimplementation for testing ────────────────────────

function parseCurrentMatrix(html: string): {
  headers: string[];
  rows: Map<string, Map<string, string>>;
} {
  const tableMatch = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) {
    throw new Error("Could not find comparison-table in HTML");
  }
  const tableHtml = tableMatch[1];

  const thRegex = /<th[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a[\s\S]*?<\/th>/g;
  const headers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = thRegex.exec(tableHtml)) !== null) {
    headers.push(m[1].trim());
  }

  const rows = new Map<string, Map<string, string>>();
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  let tr: RegExpExecArray | null;
  const trIter = new RegExp(/<tr>([\s\S]*?)<\/tr>/g);

  while ((tr = trIter.exec(tbody)) !== null) {
    const tds: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let td: RegExpExecArray | null;
    while ((td = tdRegex.exec(tr[1])) !== null) {
      tds.push(td[1].trim());
    }
    if (tds.length < 2) continue;

    const rowLabel = tds[0];
    const rowMap = new Map<string, string>();
    for (let i = 1; i < tds.length && i - 1 < headers.length; i++) {
      rowMap.set(headers[i - 1], tds[i]);
    }
    rows.set(rowLabel, rowMap);
  }

  return { headers, rows };
}

// ── computeChanges reimplementation (mirrors fixed version) ────────────────

interface DetectedChange {
  competitor: string;
  capability: string;
  from: string;
  to: string;
}

function computeChanges(
  _html: string,
  matrix: { headers: string[]; rows: Map<string, Map<string, string>> },
  competitorFeatures: Map<string, Record<string, boolean>>,
): DetectedChange[] {
  const changes: DetectedChange[] = [];

  for (const [compName, features] of competitorFeatures) {
    for (const [rowLabel, detected] of Object.entries(features)) {
      if (!detected) continue;

      const row = matrix.rows.get(rowLabel);
      if (!row) continue;

      const currentCell = row.get(compName);
      if (!currentCell) continue;

      // Only upgrade "No" cells — cells contain inner HTML like
      // '<span class="no">&#10007;</span>', not bare "No" text.
      if (
        currentCell.includes('class="no"') ||
        currentCell.includes("\u2717") ||
        currentCell.includes("&#10007;")
      ) {
        changes.push({
          competitor: compName,
          capability: rowLabel,
          from: "No",
          to: "Yes",
        });
      }
    }
  }

  return changes;
}

// ── applyChanges reimplementation (mirrors fixed version) ──────────────────

function applyChanges(html: string, changes: DetectedChange[]): string {
  if (changes.length === 0) return html;

  const tableMatch = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) return html;

  const theadMatch = tableMatch[1].match(/<thead>([\s\S]*?)<\/thead>/);
  if (!theadMatch) return html;

  const thRegex = /<th[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a[\s\S]*?<\/th>/g;
  const headers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = thRegex.exec(theadMatch[1])) !== null) {
    headers.push(m[1].trim());
  }

  const compColumnIndex = (name: string): number => {
    const idx = headers.indexOf(name);
    return idx === -1 ? -1 : idx + 1;
  };

  let result = html;

  for (const change of changes) {
    const colIdx = compColumnIndex(change.competitor);
    if (colIdx === -1) continue;

    const rowPattern = new RegExp(
      `(<tr>\\s*<td>\\s*${escapeRegex(change.capability)}\\s*</td>)([\\s\\S]*?)(</tr>)`,
    );
    const rowMatch = result.match(rowPattern);
    if (!rowMatch) continue;

    const prefix = rowMatch[1];
    const cellsHtml = rowMatch[2];
    const suffix = rowMatch[3];

    const targetTdIdx = colIdx - 1;
    let tdCount = 0;
    const tdReplace = cellsHtml.replace(/<td[^>]*>([\s\S]*?)<\/td>/g, (fullMatch, content) => {
      const currentIdx = tdCount++;
      if (
        currentIdx === targetTdIdx &&
        (content.includes('class="no"') ||
          content.includes("\u2717") ||
          content.includes("&#10007;"))
      ) {
        return `<td><span class="yes">&#10003;</span></td>`;
      }
      return fullMatch;
    });

    result = result.replace(rowPattern, prefix + tdReplace + suffix);
  }

  return result;
}

// ── Tests ───────────────────────────────────────────────────────────────────

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

  it("counts all 12 provider groups when all are mentioned", () => {
    const readme = `
      OpenAI, Claude, Gemini, Bedrock, Azure, Vertex AI,
      Ollama, Cohere, Mistral, Groq, Together AI, Llama
    `;
    expect(countProviders(readme)).toBe(12);
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
      <td>11 providers</td>
    </tr>
  </tbody>
</table>`;
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    // TestComp's cell should be updated
    expect(result).toContain("8 providers");
    // aimock's 11 providers should be left alone
    expect(result).toContain("11 providers");
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
      <td>11 providers</td>
      <td>5 providers</td>
    </tr>
  </tbody>
</table>`;
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    // aimock's count must remain 11
    expect(result).toContain("11 providers");
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
    const html = "<p>aimock supports 11 providers natively.</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 15, changes);

    // aimock's claim in prose should not be touched
    expect(result).toContain("11 providers");
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

// ── computeChanges tests with actual HTML structure ────────────────────────

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

// ── applyChanges tests with actual HTML structure ──────────────────────────

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

// ── extractFeatures tests (tightened keyword patterns) ─────────────────────

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
