import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSimpleYaml,
  convertConfig,
  type MockLLMConfig,
} from "../../scripts/convert-mockllm.js";
import { loadFixtureFile } from "../fixture-loader.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "convert-mockllm-test-"));
}

describe("convert-mockllm", () => {
  describe("convertConfig: simple route to fixture", () => {
    it("converts a single route with choices[0].message.content", () => {
      const config: MockLLMConfig = {
        routes: [
          {
            path: "/v1/chat/completions",
            method: "POST",
            response: {
              id: "chatcmpl-123",
              object: "chat.completion",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "Hello from mock-llm!",
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            },
          },
        ],
      };

      const result = convertConfig(config);
      expect(result.fixtures).toHaveLength(1);
      expect(result.fixtures[0].response.content).toBe("Hello from mock-llm!");
      // No match criteria -> should have _comment with path and empty match
      expect(result.fixtures[0]._comment).toBe("POST /v1/chat/completions");
      expect(result.fixtures[0].match).toEqual({});
    });
  });

  describe("convertConfig: route with match criteria", () => {
    it("extracts userMessage from match.body.messages", () => {
      const config: MockLLMConfig = {
        routes: [
          {
            path: "/v1/chat/completions",
            method: "POST",
            match: {
              body: {
                messages: [{ role: "user", content: "weather" }],
              },
            },
            response: {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "The weather is sunny.",
                  },
                },
              ],
            },
          },
        ],
      };

      const result = convertConfig(config);
      expect(result.fixtures).toHaveLength(1);
      expect(result.fixtures[0].match).toEqual({ userMessage: "weather" });
      expect(result.fixtures[0].response.content).toBe("The weather is sunny.");
      expect(result.fixtures[0]._comment).toBeUndefined();
    });

    it("uses the last user message when multiple messages present", () => {
      const config: MockLLMConfig = {
        routes: [
          {
            path: "/v1/chat/completions",
            match: {
              body: {
                messages: [
                  { role: "system", content: "You are helpful" },
                  { role: "user", content: "first question" },
                  { role: "assistant", content: "answer" },
                  { role: "user", content: "follow up" },
                ],
              },
            },
            response: {
              choices: [{ message: { role: "assistant", content: "Follow-up response" } }],
            },
          },
        ],
      };

      const result = convertConfig(config);
      expect(result.fixtures[0].match).toEqual({ userMessage: "follow up" });
    });
  });

  describe("convertConfig: MCP tools", () => {
    it("converts mcp.tools to aimock MCPTool format", () => {
      const config: MockLLMConfig = {
        mcp: {
          tools: [
            {
              name: "get_weather",
              description: "Get weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                },
              },
            },
            {
              name: "search",
              description: "Search the web",
            },
          ],
        },
      };

      const result = convertConfig(config);
      expect(result.fixtures).toHaveLength(0);
      expect(result.mcpTools).toHaveLength(2);
      expect(result.mcpTools![0]).toEqual({
        name: "get_weather",
        description: "Get weather for a location",
        inputSchema: {
          type: "object",
          properties: { location: { type: "string" } },
        },
      });
      expect(result.mcpTools![1]).toEqual({
        name: "search",
        description: "Search the web",
      });
    });

    it("omits mcpTools from result when no mcp.tools present", () => {
      const config: MockLLMConfig = { routes: [] };
      const result = convertConfig(config);
      expect(result.mcpTools).toBeUndefined();
    });
  });

  describe("convertConfig: multiple routes", () => {
    it("converts all routes and preserves order", () => {
      const config: MockLLMConfig = {
        routes: [
          {
            path: "/v1/chat/completions",
            response: {
              choices: [{ message: { role: "assistant", content: "Default response" } }],
            },
          },
          {
            path: "/v1/chat/completions",
            match: { body: { messages: [{ role: "user", content: "hello" }] } },
            response: {
              choices: [{ message: { role: "assistant", content: "Hi there!" } }],
            },
          },
          {
            path: "/v1/chat/completions",
            match: { body: { messages: [{ role: "user", content: "bye" }] } },
            response: {
              choices: [{ message: { role: "assistant", content: "Goodbye!" } }],
            },
          },
        ],
      };

      const result = convertConfig(config);
      expect(result.fixtures).toHaveLength(3);
      expect(result.fixtures[0].response.content).toBe("Default response");
      expect(result.fixtures[0]._comment).toBeDefined();
      expect(result.fixtures[1].match).toEqual({ userMessage: "hello" });
      expect(result.fixtures[1].response.content).toBe("Hi there!");
      expect(result.fixtures[2].match).toEqual({ userMessage: "bye" });
      expect(result.fixtures[2].response.content).toBe("Goodbye!");
    });
  });

  describe("convertConfig: missing/malformed config", () => {
    it("returns empty fixtures for empty config", () => {
      const result = convertConfig({});
      expect(result.fixtures).toHaveLength(0);
      expect(result.mcpTools).toBeUndefined();
    });

    it("skips routes with no choices in response", () => {
      const config: MockLLMConfig = {
        routes: [
          {
            path: "/v1/chat/completions",
            response: { id: "123" },
          },
        ],
      };
      const result = convertConfig(config);
      expect(result.fixtures).toHaveLength(0);
    });

    it("skips routes with empty choices array", () => {
      const config: MockLLMConfig = {
        routes: [
          {
            path: "/v1/chat/completions",
            response: { choices: [] },
          },
        ],
      };
      const result = convertConfig(config);
      expect(result.fixtures).toHaveLength(0);
    });

    it("skips routes where message.content is not a string", () => {
      const config: MockLLMConfig = {
        routes: [
          {
            path: "/v1/chat/completions",
            response: {
              choices: [{ message: { role: "assistant" } }],
            },
          },
        ],
      };
      const result = convertConfig(config);
      expect(result.fixtures).toHaveLength(0);
    });

    it("handles config with routes: undefined", () => {
      const config: MockLLMConfig = { routes: undefined };
      const result = convertConfig(config);
      expect(result.fixtures).toHaveLength(0);
    });
  });

  describe("YAML parsing", () => {
    it("parses mock-llm style YAML config", () => {
      const yaml = `
routes:
  - path: /v1/chat/completions
    method: POST
    response:
      choices:
        - message:
            role: assistant
            content: "Hello!"
`;
      const parsed = parseSimpleYaml(yaml) as MockLLMConfig;
      expect(parsed.routes).toHaveLength(1);
      expect(parsed.routes![0].path).toBe("/v1/chat/completions");
      expect(parsed.routes![0].method).toBe("POST");
    });

    it("parses nested match criteria", () => {
      const yaml = `
routes:
  - path: /v1/chat/completions
    match:
      body:
        messages:
          - role: user
            content: weather
    response:
      choices:
        - message:
            role: assistant
            content: "Sunny today"
`;
      const parsed = parseSimpleYaml(yaml) as MockLLMConfig;
      const route = parsed.routes![0];
      expect(route.match?.body?.messages).toHaveLength(1);
      expect(route.match!.body!.messages![0].role).toBe("user");
      expect(route.match!.body!.messages![0].content).toBe("weather");
    });

    it("parses mcp tools", () => {
      const yaml = `
mcp:
  tools:
    - name: get_weather
      description: "Get weather"
      parameters:
        type: object
        properties:
          location:
            type: string
`;
      const parsed = parseSimpleYaml(yaml) as MockLLMConfig;
      expect(parsed.mcp?.tools).toHaveLength(1);
      expect(parsed.mcp!.tools![0].name).toBe("get_weather");
      expect(parsed.mcp!.tools![0].description).toBe("Get weather");
    });

    it("handles numbers and booleans", () => {
      const yaml = `
count: 42
enabled: true
disabled: false
ratio: 3.14
`;
      const parsed = parseSimpleYaml(yaml) as Record<string, unknown>;
      expect(parsed.count).toBe(42);
      expect(parsed.enabled).toBe(true);
      expect(parsed.disabled).toBe(false);
      expect(parsed.ratio).toBe(3.14);
    });
  });

  describe("round-trip: converted fixtures load into aimock", () => {
    it("produces valid aimock fixture JSON that loadFixtureFile accepts", () => {
      const config: MockLLMConfig = {
        routes: [
          {
            path: "/v1/chat/completions",
            match: { body: { messages: [{ role: "user", content: "hello" }] } },
            response: {
              choices: [{ message: { role: "assistant", content: "Hi there!" } }],
            },
          },
          {
            path: "/v1/chat/completions",
            match: { body: { messages: [{ role: "user", content: "goodbye" }] } },
            response: {
              choices: [{ message: { role: "assistant", content: "See you!" } }],
            },
          },
        ],
      };

      const converted = convertConfig(config);

      // Write to a temp file in aimock fixture format
      const tmpDir = makeTmpDir();
      try {
        const outputPath = join(tmpDir, "converted.json");
        const fixtureJson = JSON.stringify({ fixtures: converted.fixtures }, null, 2);
        writeFileSync(outputPath, fixtureJson, "utf-8");

        // Load with aimock's fixture loader
        const loaded = loadFixtureFile(outputPath);
        expect(loaded).toHaveLength(2);

        // Verify the fixtures match what aimock expects
        expect(loaded[0].match.userMessage).toBe("hello");
        expect((loaded[0].response as { content: string }).content).toBe("Hi there!");

        expect(loaded[1].match.userMessage).toBe("goodbye");
        expect((loaded[1].response as { content: string }).content).toBe("See you!");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("round-trips a full YAML config through parse -> convert -> load", () => {
      const yaml = `
routes:
  - path: /v1/chat/completions
    match:
      body:
        messages:
          - role: user
            content: weather
    response:
      choices:
        - message:
            role: assistant
            content: "The weather is sunny."
  - path: /v1/chat/completions
    response:
      choices:
        - message:
            role: assistant
            content: "Default response"
`;
      const parsed = parseSimpleYaml(yaml) as MockLLMConfig;
      const converted = convertConfig(parsed);

      const tmpDir = makeTmpDir();
      try {
        const outputPath = join(tmpDir, "roundtrip.json");
        writeFileSync(
          outputPath,
          JSON.stringify({ fixtures: converted.fixtures }, null, 2),
          "utf-8",
        );

        const loaded = loadFixtureFile(outputPath);
        expect(loaded).toHaveLength(2);

        // First fixture has match criteria
        expect(loaded[0].match.userMessage).toBe("weather");
        expect((loaded[0].response as { content: string }).content).toBe("The weather is sunny.");

        // Second fixture is a catch-all (no match criteria)
        expect(loaded[1].match.userMessage).toBeUndefined();
        expect((loaded[1].response as { content: string }).content).toBe("Default response");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
