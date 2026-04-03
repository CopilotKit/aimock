import { LLMock } from "./llmock.js";
import { MCPMock } from "./mcp-mock.js";
import { A2AMock } from "./a2a-mock.js";
import { VectorMock } from "./vector-mock.js";
import type { MockServerOptions } from "./types.js";
import type { MCPMockOptions } from "./mcp-types.js";
import type { A2AMockOptions } from "./a2a-types.js";
import type { VectorMockOptions } from "./vector-types.js";

export interface MockSuiteOptions {
  llm?: MockServerOptions;
  mcp?: MCPMockOptions;
  a2a?: A2AMockOptions;
  vector?: VectorMockOptions;
}

export interface MockSuite {
  llm: LLMock;
  mcp?: MCPMock;
  a2a?: A2AMock;
  vector?: VectorMock;
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
}

export async function createMockSuite(options: MockSuiteOptions = {}): Promise<MockSuite> {
  const llm = new LLMock(options.llm);
  let mcp: MCPMock | undefined;
  let a2a: A2AMock | undefined;
  let vector: VectorMock | undefined;

  if (options.mcp) {
    mcp = new MCPMock(options.mcp);
    llm.mount("/mcp", mcp);
  }

  if (options.a2a) {
    a2a = new A2AMock(options.a2a);
    llm.mount("/a2a", a2a);
  }

  if (options.vector) {
    vector = new VectorMock(options.vector);
    llm.mount("/vector", vector);
  }

  return {
    llm,
    mcp,
    a2a,
    vector,
    async start() {
      await llm.start();
    },
    async stop() {
      await llm.stop();
    },
    reset() {
      llm.reset();
      if (mcp) mcp.reset();
      if (a2a) a2a.reset();
      if (vector) vector.reset();
    },
  };
}
