import { isDeepStrictEqual } from "node:util";
import type {
  A2AConversationOptions,
  A2AConversationTurn,
  A2AMessage,
  A2APart,
  A2ATask,
} from "./a2a-types.js";
import { errorResponse } from "./jsonrpc.js";
import type { JsonRpcResponse } from "./jsonrpc.js";
import { generateId } from "./helpers.js";

export interface ConversationPatternEntry {
  kind: "conversation";
  agentName: string;
  pattern: string | RegExp;
  turns: A2AConversationTurn[];
  replayLimit: number;
}

export function matchesConversation(text: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string"
    ? text.includes(pattern)
    : new RegExp(pattern.source, pattern.flags).test(text);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPart(part: unknown, contentKeys: readonly string[]): boolean {
  if (!isObject(part)) return false;
  // A part has exactly one content field, and that field holds a value.
  const content = contentKeys.filter((key) => key in part);
  if (content.length !== 1) return false;
  const value = part[content[0]];
  if (content[0] === "data" ? value === undefined || value === null : typeof value !== "string") {
    return false;
  }
  return part.mediaType === undefined || typeof part.mediaType === "string";
}

const FIXTURE_CONTENT = ["text", "data", "url"];
// Clients may also send raw (base64) parts, which are valid A2A parts.
const MESSAGE_CONTENT = [...FIXTURE_CONTENT, "raw"];

function validParts(value: unknown, contentKeys = FIXTURE_CONTENT): boolean {
  return Array.isArray(value) && value.every((part: unknown) => isPart(part, contentKeys));
}

function validArtifacts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (artifact: unknown) =>
        isObject(artifact) &&
        validParts(artifact.parts) &&
        ["artifactId", "name", "description"].every(
          (key) => artifact[key] === undefined || typeof artifact[key] === "string",
        ),
    )
  );
}

function optionalId(value: unknown): unknown {
  return value === null || value === "" ? undefined : value;
}

export function conversationPattern(
  agentName: string,
  turns: A2AConversationTurn[],
  options: A2AConversationOptions = {},
): ConversationPatternEntry {
  const replayLimit = options.replayLimit === undefined ? 0 : options.replayLimit;
  if (!Number.isSafeInteger(replayLimit) || replayLimit < 0) {
    throw new Error("A conversation replay limit must be a nonnegative safe integer");
  }
  // Validate a private copy, so accessors on the caller's objects and later changes to
  // them cannot bypass validation.
  const copy = structuredClone(turns);
  if (!Array.isArray(copy) || copy.length === 0) {
    throw new Error("A conversation needs at least one turn");
  }
  for (let index = 0; index < copy.length; index++) {
    const turn = copy[index];
    if (
      !turn ||
      (typeof turn.pattern !== "string" && !(turn.pattern instanceof RegExp)) ||
      !isObject(turn.response) ||
      (turn.response.parts !== undefined && !validParts(turn.response.parts)) ||
      (turn.response.artifacts !== undefined && !validArtifacts(turn.response.artifacts))
    ) {
      throw new Error(`Invalid conversation turn at index ${index}`);
    }
    const state = turn.response.state;
    const valid =
      index < copy.length - 1
        ? state === "TASK_STATE_INPUT_REQUIRED"
        : state === "TASK_STATE_COMPLETED" || state === "TASK_STATE_FAILED";
    if (!valid) throw new Error(`Invalid conversation state at index ${index}`);
  }
  return { kind: "conversation", agentName, pattern: copy[0].pattern, turns: copy, replayLimit };
}

interface Progress {
  turns: A2AConversationTurn[];
  next: number;
  replayLimit: number;
  accepted: Map<string, { parts: A2APart[]; task: A2ATask }>;
}

export class ConversationStore {
  private progress = new Map<string, Progress>();
  // Tasks created by a conversation. Only these are continued by task ID. A send
  // with any other task ID goes through fixture matching: legacy fixtures handle it
  // as before, and a conversation that matches rejects it (-32602 or -32001/-32004).
  private owned = new Set<string>();

  constructor(private tasks: Map<string, A2ATask>) {}

  clear(): void {
    this.progress.clear();
    this.owned.clear();
  }

  owns(taskId: unknown): boolean {
    return typeof taskId === "string" && this.owned.has(taskId);
  }

  send(
    params: unknown,
    id: string | number,
    text: string,
    entry?: ConversationPatternEntry,
  ): JsonRpcResponse {
    const fail = (code: number, message: string): JsonRpcResponse =>
      errorResponse(code, message, id);
    const message = (params as { message?: A2AMessage } | undefined)?.message;
    if (!message || !Array.isArray(message.parts)) {
      return fail(-32602, "A conversation send requires message parts");
    }
    if (!validParts(message.parts, MESSAGE_CONTENT)) {
      return fail(-32602, "Invalid message parts");
    }
    // JSON null and "" count as absent for these IDs, as an empty context does for ListTasks.
    const messageId = optionalId(message.messageId);
    if (messageId !== undefined && typeof messageId !== "string") {
      return fail(-32602, "Invalid message ID");
    }
    const contextId = optionalId(message.contextId);
    if (contextId !== undefined && typeof contextId !== "string") {
      return fail(-32602, "Invalid context ID");
    }
    const taskId = optionalId(message.taskId);
    if (taskId !== undefined && typeof taskId !== "string") {
      return fail(-32602, "Invalid task ID");
    }

    let task: A2ATask | undefined;
    let cursor: Progress;
    if (taskId !== undefined) {
      task = this.tasks.get(taskId);
      if (!task) return fail(-32001, "Task not found");
      const existing = this.progress.get(task.id);
      if (contextId !== undefined && contextId !== task.contextId) {
        return fail(-32602, "Context does not belong to task");
      }
      const accepted = messageId === undefined ? undefined : existing?.accepted.get(messageId);
      if (accepted) {
        if (!isDeepStrictEqual(message.parts, accepted.parts)) {
          return fail(-32602, "Message ID was already accepted with different parts");
        }
        return { jsonrpc: "2.0", id, result: { task: structuredClone(accepted.task) } };
      }
      if (task.status.state !== "TASK_STATE_INPUT_REQUIRED" || !existing) {
        return fail(-32004, "Task cannot be continued");
      }
      cursor = existing;
    } else {
      if (!entry) return fail(-32000, "No matching conversation");
      cursor = { turns: entry.turns, next: 0, replayLimit: entry.replayLimit, accepted: new Map() };
    }

    const turn = cursor.turns[cursor.next];
    if (!matchesConversation(text, turn.pattern)) {
      return fail(-32000, "Message does not match the next conversation turn");
    }
    // Stored and returned messages carry the IDs of the task they belong to.
    const ids = {
      taskId: task?.id ?? generateId("task"),
      contextId: task?.contextId ?? contextId ?? generateId("ctx"),
    };
    const user: A2AMessage = {
      ...structuredClone(message),
      messageId: messageId ?? generateId("msg"),
      role: "ROLE_USER",
      ...ids,
    };
    const reply: A2AMessage = {
      messageId: generateId("msg"),
      role: "ROLE_AGENT",
      parts: structuredClone(turn.response.parts ?? []),
      ...ids,
    };
    const state = turn.response.state;
    const nextTask: A2ATask = {
      id: ids.taskId,
      contextId: ids.contextId,
      // A task that waits for input carries the agent's question in its status, per A2A.
      status:
        state === "TASK_STATE_INPUT_REQUIRED"
          ? { state, message: structuredClone(reply), timestamp: new Date().toISOString() }
          : { state, timestamp: new Date().toISOString() },
      history: [...(task?.history ?? []), user, reply],
      artifacts: [...(task?.artifacts ?? []), ...structuredClone(turn.response.artifacts ?? [])],
    };
    this.tasks.set(nextTask.id, nextTask);
    this.owned.add(nextTask.id);
    // Only successful keyed sends consume retention. Replaying never changes insertion order.
    if (cursor.replayLimit > 0 && messageId !== undefined) {
      cursor.accepted.set(messageId, {
        parts: structuredClone(message.parts),
        task: structuredClone(nextTask),
      });
      if (cursor.accepted.size > cursor.replayLimit) {
        cursor.accepted.delete(cursor.accepted.keys().next().value!);
      }
    }
    if (state === "TASK_STATE_INPUT_REQUIRED" || cursor.replayLimit > 0) {
      // Terminal/canceled tasks still expose retained historical responses.
      this.progress.set(nextTask.id, { ...cursor, next: cursor.next + 1 });
    } else {
      this.progress.delete(nextTask.id);
    }
    return { jsonrpc: "2.0", id, result: { task: structuredClone(nextTask) } };
  }
}
