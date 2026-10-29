import { isDeepStrictEqual } from "node:util";
import type {
  A2AConversationOptions,
  A2AConversationTurn,
  A2AMessage,
  A2APart,
  A2ATask,
} from "./a2a-types.js";
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

function validParts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((part: unknown) => {
      if (!isObject(part)) return false;
      if (
        ("text" in part && typeof part.text !== "string") ||
        ("url" in part && typeof part.url !== "string") ||
        (part.mediaType !== undefined && typeof part.mediaType !== "string")
      ) {
        return false;
      }
      return "text" in part || "data" in part || "url" in part;
    })
  );
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

export function conversationPattern(
  agentName: string,
  turns: A2AConversationTurn[],
  options: A2AConversationOptions = {},
): ConversationPatternEntry {
  const replayLimit = options.replayLimit === undefined ? 0 : options.replayLimit;
  if (!Number.isSafeInteger(replayLimit) || replayLimit < 0) {
    throw new Error("A conversation replay limit must be a nonnegative safe integer");
  }
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new Error("A conversation needs at least one turn");
  }
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
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
      index < turns.length - 1
        ? state === "TASK_STATE_INPUT_REQUIRED"
        : state === "TASK_STATE_COMPLETED" || state === "TASK_STATE_FAILED";
    if (!valid) throw new Error(`Invalid conversation state at index ${index}`);
  }
  return { kind: "conversation", agentName, pattern: turns[0].pattern, turns, replayLimit };
}

interface Progress {
  turns: A2AConversationTurn[];
  next: number;
  replayLimit: number;
  accepted: Map<string, { parts: A2APart[]; task: A2ATask }>;
}

export class ConversationStore {
  private progress = new Map<string, Progress>();
  // Tasks created by a conversation. Only these are continued by task ID;
  // every other task ID keeps the legacy fixture behavior.
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
    const fail = (code: number, message: string): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
    const message = (params as { message?: A2AMessage } | undefined)?.message;
    if (!message || !Array.isArray(message.parts)) {
      return fail(-32602, "A conversation send requires message parts");
    }
    if (message.contextId !== undefined && typeof message.contextId !== "string") {
      return fail(-32602, "Invalid context ID");
    }

    let task: A2ATask | undefined;
    let cursor: Progress;
    if (message.taskId !== undefined) {
      task = this.tasks.get(message.taskId);
      if (!task) return fail(-32001, "Task not found");
      const existing = this.progress.get(task.id);
      if (message.contextId !== undefined && message.contextId !== task.contextId) {
        return fail(-32602, "Context does not belong to task");
      }
      const accepted = existing?.accepted.get(message.messageId);
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
    const user: A2AMessage = {
      ...structuredClone(message),
      messageId: message.messageId ?? generateId("msg"),
      role: "ROLE_USER",
    };
    const reply: A2AMessage = {
      messageId: generateId("msg"),
      role: "ROLE_AGENT",
      parts: structuredClone(turn.response.parts ?? []),
    };
    const nextTask: A2ATask = {
      id: task?.id ?? generateId("task"),
      contextId: task?.contextId ?? message.contextId ?? generateId("ctx"),
      status: { state: turn.response.state, timestamp: new Date().toISOString() },
      history: [...(task?.history ?? []), user, reply],
      artifacts: [...(task?.artifacts ?? []), ...structuredClone(turn.response.artifacts ?? [])],
    };
    this.tasks.set(nextTask.id, nextTask);
    this.owned.add(nextTask.id);
    // Only successful keyed sends consume retention. Replaying never changes insertion order.
    if (
      cursor.replayLimit > 0 &&
      typeof message.messageId === "string" &&
      message.messageId !== ""
    ) {
      cursor.accepted.set(message.messageId, {
        parts: structuredClone(message.parts),
        task: structuredClone(nextTask),
      });
      if (cursor.accepted.size > cursor.replayLimit) {
        cursor.accepted.delete(cursor.accepted.keys().next().value!);
      }
    }
    if (turn.response.state === "TASK_STATE_INPUT_REQUIRED" || cursor.replayLimit > 0) {
      // Terminal/canceled tasks still expose retained historical responses.
      this.progress.set(nextTask.id, { ...cursor, next: cursor.next + 1 });
    } else {
      this.progress.delete(nextTask.id);
    }
    return { jsonrpc: "2.0", id, result: { task: structuredClone(nextTask) } };
  }
}
