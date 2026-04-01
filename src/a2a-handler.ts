import type { JsonRpcResponse, MethodHandler } from "./jsonrpc.js";
import type {
  A2AAgentDefinition,
  A2AArtifact,
  A2APart,
  A2AStreamEvent,
  A2ATask,
  A2ATaskState,
} from "./a2a-types.js";
import { generateId } from "./helpers.js";

// ---- Pattern types ----

export interface MessagePatternEntry {
  kind: "message";
  pattern: string | RegExp;
  agentName: string;
  parts: A2APart[];
}

export interface TaskPatternEntry {
  kind: "task";
  pattern: string | RegExp;
  agentName: string;
  artifacts: A2AArtifact[];
}

export interface StreamingTaskPatternEntry {
  kind: "streamingTask";
  pattern: string | RegExp;
  agentName: string;
  events: A2AStreamEvent[];
  delayMs?: number;
}

export type PatternEntry = MessagePatternEntry | TaskPatternEntry | StreamingTaskPatternEntry;

// ---- Helpers ----

function extractText(params: unknown): string {
  const p = params as Record<string, unknown> | undefined;
  if (!p?.message) return "";
  const msg = p.message as Record<string, unknown>;
  const parts = msg.parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ");
}

function matchPattern(text: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return text.includes(pattern);
  }
  return pattern.test(text);
}

export const TERMINAL_STATES: Set<string> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
]);

// ---- Agent card builder ----

export function buildAgentCard(
  agents: Map<string, { def: A2AAgentDefinition; patterns: PatternEntry[] }>,
  baseUrl: string,
): Record<string, unknown> {
  // Use the first registered agent as the primary card, or a default
  const first = agents.values().next().value;
  const def = first?.def;

  return {
    name: def?.name ?? "a2a-mock",
    description: def?.description ?? "A2A mock agent",
    version: def?.version ?? "1.0.0",
    supportedInterfaces: [
      {
        url: baseUrl,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    skills: def?.skills ?? [],
    capabilities: def?.capabilities ?? { streaming: true },
  };
}

// ---- Method handlers ----

export function createA2AMethods(
  agents: Map<string, { def: A2AAgentDefinition; patterns: PatternEntry[] }>,
  tasks: Map<string, A2ATask>,
): Record<string, MethodHandler> {
  function findMatch(text: string): PatternEntry | null {
    for (const agent of agents.values()) {
      for (const entry of agent.patterns) {
        if (matchPattern(text, entry.pattern)) {
          return entry;
        }
      }
    }
    return null;
  }

  function createTask(
    _agentName: string,
    artifacts: A2AArtifact[],
    userParts: A2APart[],
    state: A2ATaskState = "TASK_STATE_COMPLETED",
  ): A2ATask {
    const taskId = generateId("task");
    const contextId = generateId("ctx");
    const task: A2ATask = {
      id: taskId,
      contextId,
      status: { state, timestamp: new Date().toISOString() },
      artifacts,
      history: [
        {
          messageId: generateId("msg"),
          role: "ROLE_USER",
          parts: userParts,
        },
      ],
    };
    tasks.set(taskId, task);
    return task;
  }

  const methods: Record<string, MethodHandler> = {
    SendMessage: async (params: unknown, id: string | number): Promise<JsonRpcResponse> => {
      const text = extractText(params);
      const entry = findMatch(text);

      if (!entry) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "No matching pattern for message" },
        };
      }

      const p = params as Record<string, unknown> | undefined;
      const msg = p?.message as Record<string, unknown> | undefined;
      const userParts: A2APart[] = (msg?.parts as A2APart[]) ?? [{ text }];

      if (entry.kind === "message") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            message: {
              messageId: generateId("msg"),
              role: "ROLE_AGENT",
              parts: entry.parts,
            },
          },
        };
      }

      if (entry.kind === "task") {
        const task = createTask(entry.agentName, entry.artifacts, userParts);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            task: {
              id: task.id,
              contextId: task.contextId,
              status: task.status,
              artifacts: task.artifacts,
            },
          },
        };
      }

      // streamingTask patterns matched via SendMessage just return task
      if (entry.kind === "streamingTask") {
        const artifacts: A2AArtifact[] = [];
        for (const evt of entry.events) {
          if (evt.type === "artifact") {
            artifacts.push({ parts: evt.parts, name: evt.name });
          }
        }
        const task = createTask(entry.agentName, artifacts, userParts);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            task: {
              id: task.id,
              contextId: task.contextId,
              status: task.status,
              artifacts: task.artifacts,
            },
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "No matching pattern for message" },
      };
    },

    // SendStreamingMessage is handled specially in A2AMock (SSE response),
    // but we register a placeholder so the dispatcher doesn't return "method not found".
    SendStreamingMessage: async (
      params: unknown,
      id: string | number,
    ): Promise<JsonRpcResponse | null> => {
      // This is intercepted before reaching the dispatcher in a2a-mock.ts
      // If it reaches here, return an error
      const text = extractText(params);
      const entry = findMatch(text);
      if (!entry) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "No matching pattern for message" },
        };
      }
      return null;
    },

    GetTask: async (params: unknown, id: string | number): Promise<JsonRpcResponse> => {
      const p = params as Record<string, unknown> | undefined;
      const taskId = p?.id as string | undefined;

      if (!taskId || !tasks.has(taskId)) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: "Task not found" },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        result: { task: tasks.get(taskId) },
      };
    },

    ListTasks: async (params: unknown, id: string | number): Promise<JsonRpcResponse> => {
      const p = params as Record<string, unknown> | undefined;
      const contextId = p?.contextId as string | undefined;
      const status = p?.status as string | undefined;

      let results = Array.from(tasks.values());

      if (contextId) {
        results = results.filter((t) => t.contextId === contextId);
      }
      if (status) {
        results = results.filter((t) => t.status.state === status);
      }

      return {
        jsonrpc: "2.0",
        id,
        result: { tasks: results },
      };
    },

    CancelTask: async (params: unknown, id: string | number): Promise<JsonRpcResponse> => {
      const p = params as Record<string, unknown> | undefined;
      const taskId = p?.id as string | undefined;

      if (!taskId || !tasks.has(taskId)) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: "Task not found" },
        };
      }

      const task = tasks.get(taskId)!;

      if (TERMINAL_STATES.has(task.status.state)) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32002, message: "Task already in terminal state" },
        };
      }

      task.status = {
        state: "TASK_STATE_CANCELED",
        timestamp: new Date().toISOString(),
      };

      return {
        jsonrpc: "2.0",
        id,
        result: { task },
      };
    },
  };

  return methods;
}

// ---- Streaming helpers ----

export function findStreamingMatch(
  text: string,
  agents: Map<string, { def: A2AAgentDefinition; patterns: PatternEntry[] }>,
): StreamingTaskPatternEntry | null {
  for (const agent of agents.values()) {
    for (const entry of agent.patterns) {
      if (entry.kind === "streamingTask" && matchPattern(text, entry.pattern)) {
        return entry;
      }
    }
  }
  return null;
}

export { extractText };
