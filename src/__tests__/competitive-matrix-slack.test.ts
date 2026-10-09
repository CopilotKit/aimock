import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSummary } from "../../scripts/update-competitive-matrix.js";
import {
  runFeatureWatch,
  type FeatureWatchResult,
  type WatchSource,
} from "../../scripts/competitive-watch.js";

// Contract test for the Slack digest. It runs the workflow's real "Notify
// Slack" step (its jq and awk, taken from the YAML as the step runs them) on
// the real formatSummary output, and checks the exact Slack text. Competitor
// text must show in Slack exactly as written, with "&", "<" and ">" escaped
// once for Slack, and no GFM escape from the summary table left over.

const WORKFLOW = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows/update-competitive-matrix.yml",
);

/** The `run: |` block of the named step, with the block indentation removed. */
function stepRun(yaml: string, name: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start === -1) throw new Error(`no step "${name}" in the workflow`);
  const stepIndent = lines[start].indexOf("-");
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
  if (runAt === -1) throw new Error(`step "${name}" has no "run: |" block`);
  const keyIndent = lines[runAt].indexOf("run:");
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== "" && indent <= keyIndent) break;
    body.push(line);
  }
  if (keyIndent <= stepIndent) throw new Error(`step "${name}": run is not inside the step`);
  const blockIndent = Math.min(
    ...body.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length),
  );
  return body.map((l) => l.slice(blockIndent)).join("\n");
}

const PR_URL = "https://github.com/CopilotKit/aimock/pull/1";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface SlackEnv {
  CHANGED: string;
  DOCS_CHANGED: string;
  PR_URL: string;
  JOB_STATUS: string;
}

/** Runs the real Notify Slack step on `summary`; returns the posted `text`. */
function runNotifySlack(summary: string, env: SlackEnv): string {
  const dir = mkdtempSync(join(tmpdir(), "slack-contract-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // A curl stub: it writes the -d payload to a file and never posts.
  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    '#!/bin/bash\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-d" ]; then printf "%s" "$2" > "$CURL_OUT"; fi\n  shift\ndone\n',
  );
  chmodSync(curl, 0o755);
  writeFileSync(join(dir, "matrix-summary.md"), summary);
  const script = stepRun(readFileSync(WORKFLOW, "utf8"), "Notify Slack").replaceAll(
    "/tmp/",
    `${dir}/`,
  );
  const scriptPath = join(dir, "notify.sh");
  writeFileSync(scriptPath, script);
  const out = join(dir, "payload.json");
  const res = spawnSync("bash", ["-e", scriptPath], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CURL_OUT: out,
      SLACK_WEBHOOK: "https://hooks.slack.invalid/T/B/X",
      RUN_ID: "42",
      ...env,
    },
  });
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  const payload: unknown = JSON.parse(readFileSync(out, "utf8"));
  if (typeof payload !== "object" || payload === null || !("text" in payload)) {
    throw new Error("payload has no text");
  }
  const text = payload.text;
  if (typeof text !== "string") throw new Error("payload text is not a string");
  return text;
}

// Hostile competitor text: Slack control syntax, GFM escape characters,
// entities, the C0 characters that `&#1;`/`&#2;` decode to, an emoji, and a
// line break (the table cell turns it into a space).
const HOSTILE: FeatureWatchResult = {
  reports: [
    {
      id: "hostile_src",
      competitor: "AT&T <Mock>",
      claims: ["C-S1", "C-S2"],
      url: "https://example.com/docs?a=1&b=2",
      status: "changed",
      details: [
        "version 1.0.0 -> 2.0.0",
        "TOOL_MOCK_ *bold* [x](y) `code` ~s~ a|b back\\slash \\| $x$",
        "<!channel> <https://evil.example|click> &lt; literal &#1; text",
        "c0 a\u0001b\u0002c @user #12 🚀\r\nnext",
      ],
      evidence: { "mcp-tool": "<!here> a|b & 🚀" },
    },
    {
      id: "plain-src",
      competitor: "MockServer",
      claims: [],
      url: "https://www.mock-server.com/",
      status: "no change",
      details: [],
      evidence: {},
    },
  ],
  state: {},
  stateChanged: true,
};

const REPORT_MSG =
  "🔎 *Competitor feature-watch changes need a review* — report PR created. " +
  "<https://github.com/CopilotKit/aimock/actions/runs/42|View run>";

describe("Notify Slack digest (workflow jq/awk contract)", () => {
  it("shows hostile competitor text exactly once-escaped for Slack", () => {
    const text = runNotifySlack(formatSummary([], [], [], [], [], HOSTILE), {
      CHANGED: "true",
      DOCS_CHANGED: "false",
      PR_URL,
      JOB_STATUS: "success",
    });
    expect(text).toBe(
      [
        REPORT_MSG,
        PR_URL,
        "",
        "*Feature watch*",
        "",
        "The scan never changes a homepage cell from these checks. For each source that is not " +
          '"no change", re-check its claims in the MCP spec\'s claims table (14.2), then edit the homepage by hand.',
        "",
        "• *hostile_src* (AT&amp;T &lt;Mock&gt;; C-S1, C-S2): changed — Details: " +
          "version 1.0.0 -&gt; 2.0.0; " +
          "TOOL_MOCK_ *bold* [x](y) `code` ~s~ a|b back\\slash \\| $x$; " +
          "&lt;!channel&gt; &lt;https://evil.example|click&gt; &amp;lt; literal &amp;#1; text; " +
          "c0 a\u0001b\u0002c @user #12 🚀 next" +
          ' — Evidence: mcp-tool: "&lt;!here&gt; a|b &amp; 🚀"',
        "• *plain-src* (MockServer; -): no change",
        "",
      ].join("\n"),
    );
    // Belt and braces on the failure classes the exact text already pins.
    expect(text).not.toContain("&amp;amp;");
    expect(text).not.toContain("-&amp;gt;");
    expect(text).not.toMatch(/\\[_*[\]`~]/);
    expect(text).not.toContain("⁠");
    expect(text.replace(/<https:\/\/github\.com\/[^|>]+\|View run>/, "")).not.toMatch(/<[!@#h]/);
  });

  it("shows competitor `&#1;`/`&#2;` and `$` text with no control byte, `\\` or `|` artifact", async () => {
    // The real path: competitor HTML -> section text -> formatSummary -> Slack.
    const url = "https://example.com/php";
    const src: WatchSource = {
      id: "php-src",
      competitor: "PHP Mock",
      claims: ["C-P1"],
      target: { kind: "html", url, section: { kind: "heading", text: "Tools" } },
      checks: [{ id: "mcp", question: "Is MCP named?", pattern: "\\bmcp\\b" }],
    };
    const watch = await runFeatureWatch({
      sources: [src],
      previous: {},
      today: "2026-10-08",
      fetchText: async () => ({
        ok: true,
        text: "<h2>Tools</h2><p>MCP a&#1;b&#2;c use $client $x$ end</p>",
      }),
      log: () => {},
    });
    const text = runNotifySlack(formatSummary([], [], [], [], [], watch), {
      CHANGED: "true",
      DOCS_CHANGED: "false",
      PR_URL,
      JOB_STATUS: "success",
    });
    const line = text.split("\n").find((l) => l.startsWith("• *php-src*"));
    expect(line).toBe(
      '• *php-src* (PHP Mock; C-P1): baseline — Evidence: mcp: "MCP abc use $client $x$ end"',
    );
    expect(text).not.toMatch(/\p{Cc}(?<!\n)/u);
    expect(line).not.toMatch(/[\\|\u2060]/);
    expect(line).toContain("$client $x$");
  });

  it("sends no digest when no PR was created", () => {
    const text = runNotifySlack(formatSummary([], [], [], [], [], HOSTILE), {
      CHANGED: "true",
      DOCS_CHANGED: "false",
      PR_URL: "",
      JOB_STATUS: "failure",
    });
    expect(text).toBe(
      "❌ *Competitive matrix update failed*. " +
        "<https://github.com/CopilotKit/aimock/actions/runs/42|View run>",
    );
  });
});
