/**
 * Assistants Threads subset mock.
 *
 * Implements the thread/message/run flow agent harnesses need:
 * - `POST /v1/threads`, `GET /v1/threads/{id}`, `DELETE /v1/threads/{id}`
 * - `POST /v1/threads/{id}/messages`, `GET /v1/threads/{id}/messages`
 * - `POST /v1/threads/{id}/runs`, `GET /v1/threads/{id}/runs/{runId}`
 *
 * Runs progress deterministically `queued → in_progress → completed`
 * (first poll → in_progress, second+ → completed). State is in-memory,
 * cleared by the full reset path, journaled as `service: "threads"` and
 * chaos-gated. Responses include the `OpenAI-Beta: assistants=v2` header
 * so SDKs that assert it keep working.
 */

import type * as http from "node:http";
import { flattenHeaders, generateId, isJsonObject } from "./helpers.js";
import { applyChaos } from "./chaos.js";
import type { ChaosDefaults } from "./types.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

export interface ThreadObject {
  id: string;
  object: "thread";
  created_at: number;
  metadata?: Record<string, string>;
}

export interface ThreadMessage {
  id: string;
  object: "thread.message";
  thread_id: string;
  role: "user" | "assistant";
  content: { type: "text"; text: { value: string } }[];
  created_at: number;
}

export interface ThreadRun {
  id: string;
  object: "thread.run";
  thread_id: string;
  assistant_id: string;
  status: "queued" | "in_progress" | "completed" | "cancelled" | "failed";
  created_at: number;
  model?: string;
}

const threads = new Map<string, ThreadObject>();
const messages = new Map<string, ThreadMessage[]>();
const runs = new Map<string, ThreadRun>();
const runPolls = new Map<string, number>();

export function clearThreadsStore(): void {
  threads.clear();
  messages.clear();
  runs.clear();
  runPolls.clear();
}

type Defaults = { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry };

function journalThreads(
  journal: Journal,
  method: string,
  path: string,
  headers: Record<string, string>,
  status: number,
): void {
  journal.add({
    method,
    path,
    headers,
    body: null,
    service: "threads",
    response: { status, fixture: null },
  });
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  setCorsHeaders(res);
  res.setHeader("OpenAI-Beta", "assistants=v2");
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function invalid(message: string): { error: { message: string; type: string } } {
  return { error: { message, type: "invalid_request_error" } };
}

function chaosHit(
  req: http.IncomingMessage,
  journal: Journal,
  defaults: Defaults,
  method: string,
  path: string,
  res: http.ServerResponse,
): boolean {
  return applyChaos(
    res,
    null,
    defaults.chaos,
    req.headers,
    req.url,
    journal,
    { method, path, headers: flattenHeaders(req.headers), body: null },
    "internal",
    defaults.registry,
    defaults.logger,
  );
}

function parseJson(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isJsonObject(v)) return { ok: false, error: "Request body must be a JSON object" };
    return { ok: true, value: v as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: `Malformed JSON: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

export async function handleThreadsCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/threads";
  const method = req.method ?? "POST";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const parsed =
    raw.trim() === ""
      ? { ok: true as const, value: {} as Record<string, unknown> }
      : parseJson(raw);
  if (!parsed.ok) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(parsed.error), setCorsHeaders);
    return;
  }
  const thread: ThreadObject = {
    id: generateId("thread"),
    object: "thread",
    created_at: Math.floor(Date.now() / 1000),
  };
  const seed = parsed.value["messages"];
  threads.set(thread.id, thread);
  const initial: ThreadMessage[] = [];
  if (Array.isArray(seed)) {
    for (const m of seed) {
      if (
        m !== null &&
        typeof m === "object" &&
        typeof (m as Record<string, unknown>)["content"] === "string"
      ) {
        const mm = m as Record<string, unknown>;
        initial.push({
          id: generateId("msg"),
          object: "thread.message",
          thread_id: thread.id,
          role: mm["role"] === "assistant" ? "assistant" : "user",
          content: [{ type: "text", text: { value: mm["content"] as string } }],
          created_at: Math.floor(Date.now() / 1000),
        });
      }
    }
  }
  messages.set(thread.id, initial);
  journalThreads(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, thread, setCorsHeaders);
}

export async function handleThreadsRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/threads/${id}`;
  const method = req.method ?? "GET";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const t = threads.get(id);
  if (!t) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such thread: ${id}`), setCorsHeaders);
    return;
  }
  journalThreads(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, t, setCorsHeaders);
}

export async function handleThreadsDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/threads/${id}`;
  const method = req.method ?? "DELETE";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  if (!threads.get(id)) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such thread: ${id}`), setCorsHeaders);
    return;
  }
  threads.delete(id);
  messages.delete(id);
  journalThreads(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, { id, object: "thread.deleted", deleted: true }, setCorsHeaders);
}

export async function handleThreadMessagesCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  threadId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/threads/${threadId}/messages`;
  const method = req.method ?? "POST";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  if (!threads.get(threadId)) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such thread: ${threadId}`), setCorsHeaders);
    return;
  }
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(parsed.error), setCorsHeaders);
    return;
  }
  const content = parsed.value["content"];
  const role = parsed.value["role"];
  if (typeof content !== "string" || content.length === 0) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid("Invalid parameter: 'content' must be a non-empty string"),
      setCorsHeaders,
    );
    return;
  }
  const msg: ThreadMessage = {
    id: generateId("msg"),
    object: "thread.message",
    thread_id: threadId,
    role: role === "assistant" ? "assistant" : "user",
    content: [{ type: "text", text: { value: content } }],
    created_at: Math.floor(Date.now() / 1000),
  };
  messages.get(threadId)?.push(msg);
  journalThreads(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, msg, setCorsHeaders);
}

export async function handleThreadMessagesList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  threadId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/threads/${threadId}/messages`;
  const method = req.method ?? "GET";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  if (!threads.get(threadId)) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such thread: ${threadId}`), setCorsHeaders);
    return;
  }
  journalThreads(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, { object: "list", data: messages.get(threadId) ?? [] }, setCorsHeaders);
}

export async function handleThreadRunsCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  threadId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/threads/${threadId}/runs`;
  const method = req.method ?? "POST";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  if (!threads.get(threadId)) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such thread: ${threadId}`), setCorsHeaders);
    return;
  }
  const parsed =
    raw.trim() === ""
      ? { ok: true as const, value: {} as Record<string, unknown> }
      : parseJson(raw);
  if (!parsed.ok) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(parsed.error), setCorsHeaders);
    return;
  }
  const assistantId = parsed.value["assistant_id"];
  if (typeof assistantId !== "string" || assistantId.length === 0) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid("Invalid parameter: 'assistant_id' must be a non-empty string"),
      setCorsHeaders,
    );
    return;
  }
  const run: ThreadRun = {
    id: generateId("run"),
    object: "thread.run",
    thread_id: threadId,
    assistant_id: assistantId,
    status: "queued",
    created_at: Math.floor(Date.now() / 1000),
  };
  if (typeof parsed.value["model"] === "string") run.model = parsed.value["model"] as string;
  runs.set(`${threadId}:${run.id}`, run);
  runPolls.set(`${threadId}:${run.id}`, 0);
  journalThreads(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, run, setCorsHeaders);
}

export async function handleThreadRunsRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  threadId: string,
  runId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/threads/${threadId}/runs/${runId}`;
  const method = req.method ?? "GET";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const run = runs.get(`${threadId}:${runId}`);
  if (!run) {
    journalThreads(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such run: ${runId}`), setCorsHeaders);
    return;
  }
  if (run.status === "queued" || run.status === "in_progress") {
    const n = (runPolls.get(`${threadId}:${runId}`) ?? 0) + 1;
    runPolls.set(`${threadId}:${runId}`, n);
    run.status = n >= 2 ? "completed" : "in_progress";
  }
  journalThreads(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, run, setCorsHeaders);
}
