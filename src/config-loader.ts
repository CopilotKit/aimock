import * as fs from "node:fs";
import * as path from "node:path";
import { LLMock } from "./llmock.js";
import { MCPMock } from "./mcp-mock.js";
import { A2AMock } from "./a2a-mock.js";
import type { ChaosConfig, RecordConfig } from "./types.js";
import type { MCPToolDefinition, MCPPromptDefinition } from "./mcp-types.js";
import type { A2AAgentDefinition, A2APart, A2AArtifact, A2AStreamEvent } from "./a2a-types.js";
import { VectorMock } from "./vector-mock.js";
import type { QueryResult } from "./vector-types.js";
import { Logger } from "./logger.js";

export interface MCPConfigTool extends MCPToolDefinition {
  result?: string;
}

export interface MCPConfigResource {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
  text?: string;
  blob?: string;
}

export interface MCPConfigPrompt extends MCPPromptDefinition {
  result?: {
    messages: Array<{ role: string; content: { type: string; text: string } }>;
  };
}

export interface MCPConfig {
  path?: string;
  serverInfo?: { name: string; version: string };
  tools?: MCPConfigTool[];
  resources?: MCPConfigResource[];
  prompts?: MCPConfigPrompt[];
}

export interface A2AConfigPattern {
  pattern: string;
  parts?: A2APart[];
  artifacts?: A2AArtifact[];
  events?: A2AStreamEvent[];
  delayMs?: number;
}

export interface A2AConfigAgent extends A2AAgentDefinition {
  messages?: A2AConfigPattern[];
  tasks?: A2AConfigPattern[];
  streamingTasks?: A2AConfigPattern[];
}

export interface A2AConfig {
  path?: string;
  agents?: A2AConfigAgent[];
}

export interface VectorConfigCollection {
  name: string;
  dimension: number;
  vectors?: Array<{
    id: string;
    values: number[];
    metadata?: Record<string, unknown>;
  }>;
  queryResults?: QueryResult[];
}

export interface VectorConfig {
  path?: string;
  collections?: VectorConfigCollection[];
}

export interface AimockConfig {
  llm?: {
    fixtures?: string;
    chaos?: ChaosConfig;
    record?: RecordConfig;
  };
  mcp?: MCPConfig;
  a2a?: A2AConfig;
  vector?: VectorConfig;
  services?: { search?: boolean; rerank?: boolean; moderate?: boolean };
  metrics?: boolean;
  strict?: boolean;
  port?: number;
  host?: string;
}

export function loadConfig(configPath: string): AimockConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as AimockConfig;
}

export async function startFromConfig(
  config: AimockConfig,
  overrides?: { port?: number; host?: string },
): Promise<{ llmock: LLMock; url: string }> {
  const logger = new Logger("info");

  // Load fixtures if specified
  const llmock = new LLMock({
    port: overrides?.port ?? config.port ?? 0,
    host: overrides?.host ?? config.host ?? "127.0.0.1",
    chaos: config.llm?.chaos,
    record: config.llm?.record,
    metrics: config.metrics,
    strict: config.strict,
  });

  if (config.llm?.fixtures) {
    const fixturePath = path.resolve(config.llm.fixtures);
    const stat = fs.statSync(fixturePath);
    if (stat.isDirectory()) {
      llmock.loadFixtureDir(fixturePath);
    } else {
      llmock.loadFixtureFile(fixturePath);
    }
  }

  // MCP
  if (config.mcp) {
    const mcpConfig = config.mcp;
    const mcp = new MCPMock({
      serverInfo: mcpConfig.serverInfo,
    });

    if (mcpConfig.tools) {
      for (const tool of mcpConfig.tools) {
        const { result, ...def } = tool;
        mcp.addTool(def);
        if (result !== undefined) {
          mcp.onToolCall(def.name, () => result);
        }
      }
    }

    if (mcpConfig.resources) {
      for (const res of mcpConfig.resources) {
        mcp.addResource(
          { uri: res.uri, name: res.name, mimeType: res.mimeType, description: res.description },
          res.text !== undefined || res.blob !== undefined
            ? { text: res.text, blob: res.blob, mimeType: res.mimeType }
            : undefined,
        );
      }
    }

    if (mcpConfig.prompts) {
      for (const prompt of mcpConfig.prompts) {
        const { result, ...def } = prompt;
        if (result) {
          mcp.addPrompt(def, () => result as import("./mcp-types.js").MCPPromptResult);
        } else {
          mcp.addPrompt(def);
        }
      }
    }

    const mcpPath = mcpConfig.path ?? "/mcp";
    llmock.mount(mcpPath, mcp);
    logger.info(`MCPMock mounted at ${mcpPath}`);
  }

  // A2A
  if (config.a2a) {
    const a2aConfig = config.a2a;
    const a2a = new A2AMock();

    if (a2aConfig.agents) {
      for (const agentConfig of a2aConfig.agents) {
        const { messages, tasks, streamingTasks, ...def } = agentConfig;
        a2a.registerAgent(def);

        if (messages) {
          for (const m of messages) {
            a2a.onMessage(def.name, m.pattern, m.parts ?? [{ text: "" }]);
          }
        }

        if (tasks) {
          for (const t of tasks) {
            a2a.onTask(def.name, t.pattern, t.artifacts ?? []);
          }
        }

        if (streamingTasks) {
          for (const s of streamingTasks) {
            a2a.onStreamingTask(def.name, s.pattern, s.events ?? [], s.delayMs);
          }
        }
      }
    }

    const a2aPath = a2aConfig.path ?? "/a2a";
    llmock.mount(a2aPath, a2a);
    logger.info(`A2AMock mounted at ${a2aPath}`);
  }

  // Vector
  if (config.vector) {
    const vectorConfig = config.vector;
    const vector = new VectorMock();

    if (vectorConfig.collections) {
      for (const col of vectorConfig.collections) {
        vector.addCollection(col.name, { dimension: col.dimension });

        if (col.vectors && col.vectors.length > 0) {
          vector.upsert(col.name, col.vectors);
        }

        if (col.queryResults) {
          vector.onQuery(col.name, col.queryResults);
        }
      }
    }

    const vectorPath = vectorConfig.path ?? "/vector";
    llmock.mount(vectorPath, vector);
    logger.info(`VectorMock mounted at ${vectorPath}`);
  }

  // Services — configure default catch-all responses
  if (config.services) {
    if (config.services.search) {
      llmock.onSearch(/.*/, []);
      logger.info("Search service enabled with default empty results");
    }
    if (config.services.rerank) {
      llmock.onRerank(/.*/, []);
      logger.info("Rerank service enabled with default empty results");
    }
    if (config.services.moderate) {
      llmock.onModerate(/.*/, { flagged: false, categories: {} });
      logger.info("Moderation service enabled with default unflagged results");
    }
  }

  const url = await llmock.start();
  return { llmock, url };
}
