import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { A2AMock } from "../a2a-mock.js";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";

// ---- Helpers ----

function get(
  url: string,
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function post(
  url: string,
  path: string,
  body: object,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, data }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function postSSE(
  url: string,
  path: string,
  body: object,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; events: string[] }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk));
        res.on("end", () => {
          const events = raw
            .split("\n\n")
            .filter((e) => e.startsWith("data: "))
            .map((e) => e.replace("data: ", ""));
          resolve({ status: res.statusCode!, headers: res.headers, events });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function jsonRpc(method: string, params: unknown, id: number | string = 1): object {
  return { jsonrpc: "2.0", method, params, id };
}

// ---- Tests ----

describe("A2AMock", () => {
  let a2a: A2AMock | null = null;
  let llm: LLMock | null = null;

  afterEach(async () => {
    if (a2a) {
      try {
        await a2a.stop();
      } catch (err) {
        if (!(err instanceof Error && err.message === "A2AMock server not started")) {
          throw err;
        }
      }
      a2a = null;
    }
    if (llm) {
      try {
        await llm.stop();
      } catch (err) {
        if (!(err instanceof Error && err.message === "Server not started")) {
          throw err;
        }
      }
      llm = null;
    }
  });

  describe("standalone start/stop", () => {
    it("starts and stops without error", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "test-agent" });
      const url = await a2a.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      await a2a.stop();
      a2a = null;
    });
  });

  describe("mounted mode via llm.mount", () => {
    it("routes requests through LLMock mount", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({
        name: "mounted-agent",
        skills: [{ id: "s1", name: "greet" }],
      });
      a2a.onMessage("mounted-agent", "hello", [{ text: "hi from mount" }]);

      llm = new LLMock();
      llm.mount("/a2a", a2a);
      await llm.start();

      const res = await post(
        llm.url,
        "/a2a",
        jsonRpc("SendMessage", { message: { parts: [{ text: "hello" }] } }),
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.data);
      expect(body.result.message.role).toBe("ROLE_AGENT");
      expect(body.result.message.parts[0].text).toBe("hi from mount");

      // Clean up - a2a doesn't have its own server in mounted mode
      a2a = null;
    });
  });

  describe("GET /.well-known/agent-card.json", () => {
    it("returns agent card with skills", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({
        name: "skill-agent",
        description: "An agent with skills",
        version: "2.0.0",
        skills: [{ id: "s1", name: "translate", description: "Translates text", tags: ["i18n"] }],
        capabilities: { streaming: true },
      });
      const url = await a2a.start();

      const res = await get(url, "/.well-known/agent-card.json");
      expect(res.status).toBe(200);
      const card = JSON.parse(res.body);
      expect(card.name).toBe("skill-agent");
      expect(card.description).toBe("An agent with skills");
      expect(card.version).toBe("2.0.0");
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0].id).toBe("s1");
      expect(card.skills[0].name).toBe("translate");
      expect(card.supportedInterfaces).toHaveLength(1);
      expect(card.supportedInterfaces[0].protocolBinding).toBe("JSONRPC");
      expect(card.capabilities.streaming).toBe(true);
    });

    it("includes A2A-Version header", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "header-agent" });
      const url = await a2a.start();

      const res = await get(url, "/.well-known/agent-card.json");
      expect(res.headers["a2a-version"]).toBe("1.0");
    });
  });

  describe("SendMessage", () => {
    it("returns message response matched by string substring", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "echo" });
      a2a.onMessage("echo", "greet", [{ text: "Hello there!" }]);
      const url = await a2a.start();

      const res = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "please greet me" }] } }),
      );
      const body = JSON.parse(res.data);
      expect(body.result.message.role).toBe("ROLE_AGENT");
      expect(body.result.message.parts).toEqual([{ text: "Hello there!" }]);
      expect(body.result.message.messageId).toBeDefined();
    });

    it("returns message response matched by RegExp", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "regex-agent" });
      a2a.onMessage("regex-agent", /^hello\s+world$/i, [{ text: "matched regex" }]);
      const url = await a2a.start();

      const res = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "Hello World" }] } }),
      );
      const body = JSON.parse(res.data);
      expect(body.result.message.parts[0].text).toBe("matched regex");
    });

    it("returns task response with artifacts", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "task-agent" });
      a2a.onTask("task-agent", "compute", [
        { parts: [{ text: "result: 42" }], name: "computation" },
      ]);
      const url = await a2a.start();

      const res = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "compute something" }] } }),
      );
      const body = JSON.parse(res.data);
      expect(body.result.task).toBeDefined();
      expect(body.result.task.id).toBeDefined();
      expect(body.result.task.contextId).toBeDefined();
      expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
      expect(body.result.task.artifacts).toHaveLength(1);
      expect(body.result.task.artifacts[0].parts[0].text).toBe("result: 42");
    });

    it("returns error when no pattern matches", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "strict" });
      a2a.onMessage("strict", "specific-phrase", [{ text: "ok" }]);
      const url = await a2a.start();

      const res = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "something else entirely" }] } }),
      );
      const body = JSON.parse(res.data);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32000);
      expect(body.error.message).toContain("No matching pattern");
    });

    it("includes A2A-Version header on response", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "hdr" });
      a2a.onMessage("hdr", "ping", [{ text: "pong" }]);
      const url = await a2a.start();

      const res = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "ping" }] } }),
      );
      expect(res.headers["a2a-version"]).toBe("1.0");
    });
  });

  describe("SendStreamingMessage", () => {
    it("returns SSE stream with status and artifact events", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "stream-agent" });
      a2a.onStreamingTask("stream-agent", "stream", [
        { type: "status", state: "TASK_STATE_WORKING" },
        { type: "artifact", parts: [{ text: "chunk1" }], name: "out" },
        { type: "artifact", parts: [{ text: "chunk2" }], lastChunk: true, name: "out" },
      ]);
      const url = await a2a.start();

      const res = await postSSE(
        url,
        "/",
        jsonRpc("SendStreamingMessage", { message: { parts: [{ text: "stream this" }] } }),
      );

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/event-stream");
      expect(res.headers["a2a-version"]).toBe("1.0");
      expect(res.events.length).toBe(3);

      const evt0 = JSON.parse(res.events[0]);
      expect(evt0.jsonrpc).toBe("2.0");
      expect(evt0.result.task.status.state).toBe("TASK_STATE_WORKING");

      const evt1 = JSON.parse(res.events[1]);
      expect(evt1.result.artifact.parts[0].text).toBe("chunk1");

      const evt2 = JSON.parse(res.events[2]);
      expect(evt2.result.artifact.parts[0].text).toBe("chunk2");
      expect(evt2.result.artifact.lastChunk).toBe(true);
    });

    it("preserves TASK_STATE_FAILED terminal state after streaming", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "fail-agent" });
      a2a.onStreamingTask("fail-agent", "fail-task", [
        { type: "status", state: "TASK_STATE_WORKING" },
        { type: "artifact", parts: [{ text: "partial" }], name: "out" },
        { type: "status", state: "TASK_STATE_FAILED" },
      ]);
      const url = await a2a.start();

      // Send streaming message — stream ends with TASK_STATE_FAILED
      const streamRes = await postSSE(
        url,
        "/",
        jsonRpc("SendStreamingMessage", { message: { parts: [{ text: "fail-task" }] } }),
      );
      expect(streamRes.status).toBe(200);

      // Extract the task ID from the first SSE event
      const firstEvent = JSON.parse(streamRes.events[0]);
      const taskId = firstEvent.result.task.id;

      // Verify via GetTask that the terminal state is preserved (not overwritten to COMPLETED)
      const getRes = await post(url, "/", jsonRpc("GetTask", { id: taskId }, 2));
      const body = JSON.parse(getRes.data);
      expect(body.result.task.status.state).toBe("TASK_STATE_FAILED");
    });
  });

  describe("GetTask", () => {
    it("returns stored task", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      a2a.onTask("ta", "do-work", [{ parts: [{ text: "done" }] }]);
      const url = await a2a.start();

      // Create a task via SendMessage
      const createRes = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "do-work" }] } }, 1),
      );
      const taskId = JSON.parse(createRes.data).result.task.id;

      // Retrieve it
      const getRes = await post(url, "/", jsonRpc("GetTask", { id: taskId }, 2));
      const body = JSON.parse(getRes.data);
      expect(body.result.task.id).toBe(taskId);
      expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    });

    it("returns -32001 for unknown task", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      const url = await a2a.start();

      const res = await post(url, "/", jsonRpc("GetTask", { id: "nonexistent" }));
      const body = JSON.parse(res.data);
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toBe("Task not found");
    });
  });

  describe("ListTasks", () => {
    it("filters by contextId", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      a2a.onTask("ta", "job", [{ parts: [{ text: "r" }] }]);
      const url = await a2a.start();

      // Create two tasks
      const r1 = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "job 1" }] } }, 1),
      );
      const task1 = JSON.parse(r1.data).result.task;

      await post(url, "/", jsonRpc("SendMessage", { message: { parts: [{ text: "job 2" }] } }, 2));

      // List by contextId of task1
      const listRes = await post(url, "/", jsonRpc("ListTasks", { contextId: task1.contextId }, 3));
      const body = JSON.parse(listRes.data);
      expect(body.result.tasks).toHaveLength(1);
      expect(body.result.tasks[0].id).toBe(task1.id);
    });
  });

  describe("CancelTask", () => {
    it("transitions task to CANCELED", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      // Use streaming to create a working task (non-terminal)
      a2a.onTask("ta", "cancel-me", [{ parts: [{ text: "partial" }] }]);
      const url = await a2a.start();

      // Create task
      const createRes = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "cancel-me" }] } }, 1),
      );
      const taskId = JSON.parse(createRes.data).result.task.id;

      // Task is COMPLETED, but let's test with a working task.
      // We need to modify the task state to WORKING first for a meaningful test.
      // Actually, per spec: CancelTask on completed → -32002. Let's test both paths.

      // CancelTask on a completed task should return -32002
      const cancelRes = await post(url, "/", jsonRpc("CancelTask", { id: taskId }, 2));
      const body = JSON.parse(cancelRes.data);
      expect(body.error.code).toBe(-32002);
      expect(body.error.message).toBe("Task already in terminal state");
    });

    it("returns -32001 for unknown task", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      const url = await a2a.start();

      const cancelRes = await post(url, "/", jsonRpc("CancelTask", { id: "no-such" }, 2));
      const body = JSON.parse(cancelRes.data);
      expect(body.error.code).toBe(-32001);
    });

    it("cancels a non-terminal task", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      a2a.onTask("ta", "cancel-target", [{ parts: [{ text: "partial" }] }]);
      const url = await a2a.start();

      // Create a task via SendMessage (created as COMPLETED by default)
      const createRes = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "cancel-target" }] } }, 1),
      );
      const taskId = JSON.parse(createRes.data).result.task.id;

      // Patch the task to WORKING state so we can test the cancel path.
      // Tasks map is private but accessible at runtime for testing purposes.
      const tasksMap = (
        a2a as unknown as { tasks: Map<string, { status: { state: string; timestamp: string } }> }
      ).tasks;
      const task = tasksMap.get(taskId)!;
      task.status = { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() };

      // Now cancel should succeed
      const cancelRes = await post(url, "/", jsonRpc("CancelTask", { id: taskId }, 2));
      const body = JSON.parse(cancelRes.data);
      expect(body.result.task).toBeDefined();
      expect(body.result.task.status.state).toBe("TASK_STATE_CANCELED");

      // Verify via GetTask
      const getRes = await post(url, "/", jsonRpc("GetTask", { id: taskId }, 3));
      const getBody = JSON.parse(getRes.data);
      expect(getBody.result.task.status.state).toBe("TASK_STATE_CANCELED");
    });
  });

  describe("multiple agents", () => {
    it("routes messages to the correct agent", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "agent-a" });
      a2a.registerAgent({ name: "agent-b" });
      a2a.onMessage("agent-a", "alpha", [{ text: "from A" }]);
      a2a.onMessage("agent-b", "beta", [{ text: "from B" }]);
      const url = await a2a.start();

      const resA = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "alpha request" }] } }, 1),
      );
      expect(JSON.parse(resA.data).result.message.parts[0].text).toBe("from A");

      const resB = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "beta request" }] } }, 2),
      );
      expect(JSON.parse(resB.data).result.message.parts[0].text).toBe("from B");
    });
  });

  describe("reset()", () => {
    it("clears agents and tasks", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "resettable" });
      a2a.onTask("resettable", "work", [{ parts: [{ text: "r" }] }]);
      const url = await a2a.start();

      // Create a task
      await post(url, "/", jsonRpc("SendMessage", { message: { parts: [{ text: "work" }] } }));

      const healthBefore = a2a.health();
      expect(healthBefore.agents).toBe(1);
      expect(healthBefore.tasks).toBe(1);

      a2a.reset();

      const healthAfter = a2a.health();
      expect(healthAfter.agents).toBe(0);
      expect(healthAfter.tasks).toBe(0);
    });
  });

  describe("health()", () => {
    it("returns agent and task counts", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "h1" });
      a2a.registerAgent({ name: "h2" });

      const h = a2a.health();
      expect(h.status).toBe("ok");
      expect(h.agents).toBe(2);
      expect(h.tasks).toBe(0);
    });
  });

  describe("setJournal", () => {
    it("journal entries have service: a2a", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "journaled" });
      a2a.onMessage("journaled", "log-me", [{ text: "logged" }]);

      const journal = new Journal();
      a2a.setJournal(journal);

      const url = await a2a.start();

      await post(url, "/", jsonRpc("SendMessage", { message: { parts: [{ text: "log-me" }] } }));

      const entries = journal.getAll();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].service).toBe("a2a");
    });

    it("journals streaming messages", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "jstream" });
      a2a.onStreamingTask("jstream", "log-stream", [
        { type: "status", state: "TASK_STATE_WORKING" },
        { type: "artifact", parts: [{ text: "streamed" }], name: "out" },
      ]);

      const journal = new Journal();
      a2a.setJournal(journal);

      const url = await a2a.start();

      await postSSE(
        url,
        "/",
        jsonRpc("SendStreamingMessage", { message: { parts: [{ text: "log-stream" }] } }),
      );

      const entries = journal.getAll();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].service).toBe("a2a");
    });
  });

  describe("ListTasks", () => {
    it("filters by status", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      a2a.onTask("ta", "status-filter", [{ parts: [{ text: "r" }] }]);
      const url = await a2a.start();

      // Create two tasks
      await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "status-filter 1" }] } }, 1),
      );
      const r2 = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "status-filter 2" }] } }, 2),
      );
      const task2Id = JSON.parse(r2.data).result.task.id;

      // Patch task2 to WORKING so we can filter
      const tasksMap = (
        a2a as unknown as { tasks: Map<string, { status: { state: string; timestamp: string } }> }
      ).tasks;
      tasksMap.get(task2Id)!.status = {
        state: "TASK_STATE_WORKING",
        timestamp: new Date().toISOString(),
      };

      // Filter by COMPLETED — should only return task1
      const listRes = await post(
        url,
        "/",
        jsonRpc("ListTasks", { status: "TASK_STATE_COMPLETED" }, 3),
      );
      const body = JSON.parse(listRes.data);
      expect(body.result.tasks).toHaveLength(1);
      expect(body.result.tasks[0].status.state).toBe("TASK_STATE_COMPLETED");
    });

    it("returns all tasks when no filters provided", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      a2a.onTask("ta", "all-tasks", [{ parts: [{ text: "r" }] }]);
      const url = await a2a.start();

      await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "all-tasks a" }] } }, 1),
      );
      await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "all-tasks b" }] } }, 2),
      );

      const listRes = await post(url, "/", jsonRpc("ListTasks", {}, 3));
      const body = JSON.parse(listRes.data);
      expect(body.result.tasks).toHaveLength(2);
    });
  });

  describe("SendStreamingMessage", () => {
    it("returns error when no streaming pattern matches", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "no-stream" });
      a2a.onMessage("no-stream", "only-message", [{ text: "msg" }]);
      const url = await a2a.start();

      const res = await post(
        url,
        "/",
        jsonRpc("SendStreamingMessage", { message: { parts: [{ text: "no match" }] } }),
      );
      const body = JSON.parse(res.data);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32000);
      expect(body.error.message).toContain("No matching pattern");
    });

    it("supports delayMs between events", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "delayed" });
      a2a.onStreamingTask(
        "delayed",
        "slow-stream",
        [
          { type: "status", state: "TASK_STATE_WORKING" },
          { type: "artifact", parts: [{ text: "delayed-chunk" }], name: "out" },
        ],
        10, // 10ms delay between events
      );
      const url = await a2a.start();

      const start = Date.now();
      const res = await postSSE(
        url,
        "/",
        jsonRpc("SendStreamingMessage", { message: { parts: [{ text: "slow-stream" }] } }),
      );
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      expect(res.events.length).toBe(2);
      // With 2 events and 10ms delay each, at least ~20ms total
      expect(elapsed).toBeGreaterThanOrEqual(15);
    });
  });

  describe("SendMessage with streamingTask pattern", () => {
    it("returns task response collapsing streaming events", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "hybrid" });
      a2a.onStreamingTask("hybrid", "hybrid-task", [
        { type: "status", state: "TASK_STATE_WORKING" },
        { type: "artifact", parts: [{ text: "piece1" }], name: "result" },
        { type: "artifact", parts: [{ text: "piece2" }], name: "result" },
      ]);
      const url = await a2a.start();

      // Send via SendMessage (non-streaming) — should collapse artifacts
      const res = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "hybrid-task" }] } }),
      );
      const body = JSON.parse(res.data);
      expect(body.result.task).toBeDefined();
      expect(body.result.task.artifacts).toHaveLength(2);
      expect(body.result.task.artifacts[0].parts[0].text).toBe("piece1");
      expect(body.result.task.artifacts[1].parts[0].text).toBe("piece2");
      expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    });
  });

  describe("agent card defaults", () => {
    it("uses fallback defaults for missing agent fields", async () => {
      a2a = new A2AMock();
      // Register one minimal agent (no description/version/skills/capabilities)
      a2a.registerAgent({ name: "minimal" });
      const url = await a2a.start();

      const res = await get(url, "/.well-known/agent-card.json");
      const card = JSON.parse(res.body);
      expect(card.name).toBe("minimal");
      // buildAgentCard falls back to defaults for missing fields
      expect(card.description).toBe("A2A mock agent");
      expect(card.version).toBe("1.0.0");
      expect(card.skills).toEqual([]);
      expect(card.capabilities).toEqual({ streaming: true });
    });
  });

  describe("error handling", () => {
    it("returns parse error for invalid JSON body", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "err" });
      const url = await a2a.start();

      const res = await new Promise<{ status: number; data: string }>((resolve, reject) => {
        const parsed = new URL(url);
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: "/",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (r) => {
            let data = "";
            r.on("data", (chunk: Buffer) => (data += chunk));
            r.on("end", () => resolve({ status: r.statusCode!, data }));
          },
        );
        req.on("error", reject);
        req.write("not json{{{");
        req.end();
      });

      const body = JSON.parse(res.data);
      expect(body.error.code).toBe(-32700);
      expect(body.error.message).toBe("Parse error");
    });

    it("throws when registering patterns for unregistered agent", () => {
      a2a = new A2AMock();
      expect(() => a2a!.onMessage("ghost", "x", [{ text: "y" }])).toThrow(
        'Agent "ghost" not registered',
      );
      expect(() => a2a!.onTask("ghost", "x", [{ parts: [{ text: "y" }] }])).toThrow(
        'Agent "ghost" not registered',
      );
      expect(() => a2a!.onStreamingTask("ghost", "x", [])).toThrow('Agent "ghost" not registered');
    });

    it("throws when starting an already-started server", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "double-start" });
      await a2a.start();

      await expect(a2a.start()).rejects.toThrow("A2AMock server already started");
    });

    it("throws when stopping a non-started server", async () => {
      a2a = new A2AMock();
      await expect(a2a.stop()).rejects.toThrow("A2AMock server not started");
      a2a = null; // prevent afterEach from trying to stop
    });

    it("throws when accessing url before start", () => {
      a2a = new A2AMock();
      expect(() => a2a!.url).toThrow("A2AMock server not started");
      a2a = null;
    });
  });

  describe("handleRequest routing", () => {
    it("returns false for unrecognized methods/paths", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "route-test" });

      // Test GET on / returns false
      const fakeReq = {
        method: "GET",
        url: "/",
        headers: {},
      } as http.IncomingMessage;
      const fakeRes = {
        writeHead: () => {},
        end: () => {},
        setHeader: () => {},
        headersSent: false,
        statusCode: 200,
      } as unknown as http.ServerResponse;

      const result = await a2a.handleRequest(fakeReq, fakeRes, "/some-random-path");
      expect(result).toBe(false);
    });
  });

  describe("reset() chaining", () => {
    it("returns this for method chaining", () => {
      a2a = new A2AMock();
      const returned = a2a.reset();
      expect(returned).toBe(a2a);
      a2a = null;
    });
  });

  describe("setBaseUrl", () => {
    it("sets the base URL used by agent card", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "base-url-agent" });
      a2a.setBaseUrl("http://example.com:1234");

      // The base URL is used in agent card
      const url = await a2a.start();

      const res = await get(url, "/.well-known/agent-card.json");
      const card = JSON.parse(res.body);
      // After start(), baseUrl is overwritten with the actual URL
      expect(card.supportedInterfaces[0].url).toBe(url);
    });
  });

  describe("SendStreamingMessage without message field", () => {
    it("uses text fallback for parts when message field is absent", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "nomsg" });
      // Pattern matches empty string (extractText returns "" when no message field)
      a2a.onStreamingTask("nomsg", "", [{ type: "status", state: "TASK_STATE_WORKING" }]);
      const url = await a2a.start();

      // Send streaming request where params has no "message" field — hits the else branch (line 263)
      const res = await postSSE(
        url,
        "/",
        jsonRpc("SendStreamingMessage", { notMessage: "something" }),
      );

      expect(res.status).toBe(200);
      expect(res.events.length).toBe(1);
    });
  });

  describe("constructor with custom options", () => {
    it("accepts host and port options", async () => {
      a2a = new A2AMock({ host: "127.0.0.1", port: 0 });
      a2a.registerAgent({ name: "opts-agent" });
      const url = await a2a.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  describe("streaming message with no message.parts", () => {
    it("falls back to text extraction from message without parts", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "noparts" });
      // Pattern that matches empty string
      a2a.onStreamingTask("noparts", "", [
        { type: "artifact", parts: [{ text: "found" }], name: "out" },
      ]);
      const url = await a2a.start();

      // Send streaming request where message exists but has no parts
      const res = await postSSE(url, "/", jsonRpc("SendStreamingMessage", { message: {} }));
      expect(res.status).toBe(200);
      expect(res.events.length).toBe(1);
      const evt = JSON.parse(res.events[0]);
      expect(evt.result.artifact.parts[0].text).toBe("found");
    });
  });

  describe("GetTask with missing params", () => {
    it("returns -32001 when params is undefined", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      const url = await a2a.start();

      const res = await post(url, "/", jsonRpc("GetTask", undefined));
      const body = JSON.parse(res.data);
      expect(body.error.code).toBe(-32001);
    });
  });

  describe("CancelTask with missing params", () => {
    it("returns -32001 when params is undefined", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      const url = await a2a.start();

      const res = await post(url, "/", jsonRpc("CancelTask", undefined));
      const body = JSON.parse(res.data);
      expect(body.error.code).toBe(-32001);
    });
  });

  describe("url getter", () => {
    it("returns the base URL after start", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "url-test" });
      await a2a.start();

      // Access via getter, not the start() return value
      expect(a2a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  describe("extractText edge cases", () => {
    it("handles message with non-text parts gracefully", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "et" });
      // Pattern matches empty string since non-text parts are filtered out
      a2a.onMessage("et", "", [{ text: "found-non-text" }]);
      const url = await a2a.start();

      // Send a message with data part only (no text fields)
      const res = await post(
        url,
        "/",
        jsonRpc("SendMessage", {
          message: { parts: [{ data: { foo: "bar" }, mediaType: "application/json" }] },
        }),
      );
      const body = JSON.parse(res.data);
      expect(body.result.message.parts[0].text).toBe("found-non-text");
    });

    it("handles message with mixed text and non-text parts", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "mixed" });
      a2a.onMessage("mixed", "hello", [{ text: "matched-mixed" }]);
      const url = await a2a.start();

      const res = await post(
        url,
        "/",
        jsonRpc("SendMessage", {
          message: {
            parts: [{ data: { x: 1 }, mediaType: "application/json" }, { text: "hello" }],
          },
        }),
      );
      const body = JSON.parse(res.data);
      expect(body.result.message.parts[0].text).toBe("matched-mixed");
    });

    it("handles empty parts array", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "empty" });
      a2a.onMessage("empty", "", [{ text: "empty-match" }]);
      const url = await a2a.start();

      const res = await post(url, "/", jsonRpc("SendMessage", { message: { parts: [] } }));
      const body = JSON.parse(res.data);
      expect(body.result.message.parts[0].text).toBe("empty-match");
    });

    it("handles missing message field entirely", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "nomsg" });
      a2a.onMessage("nomsg", "", [{ text: "no-msg-match" }]);
      const url = await a2a.start();

      const res = await post(url, "/", jsonRpc("SendMessage", {}));
      const body = JSON.parse(res.data);
      expect(body.result.message.parts[0].text).toBe("no-msg-match");
    });

    it("handles undefined params", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "undef" });
      a2a.onMessage("undef", "", [{ text: "undef-match" }]);
      const url = await a2a.start();

      const res = await post(url, "/", jsonRpc("SendMessage", undefined));
      const body = JSON.parse(res.data);
      expect(body.result.message.parts[0].text).toBe("undef-match");
    });
  });

  describe("streaming task stored in tasks map", () => {
    it("task created by streaming is retrievable via GetTask", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "stored" });
      a2a.onStreamingTask("stored", "store-test", [
        { type: "status", state: "TASK_STATE_WORKING" },
        { type: "artifact", parts: [{ text: "streamed-data" }], name: "out" },
      ]);
      const url = await a2a.start();

      const res = await postSSE(
        url,
        "/",
        jsonRpc("SendStreamingMessage", { message: { parts: [{ text: "store-test" }] } }),
      );

      // Extract task ID from the first event
      const evt0 = JSON.parse(res.events[0]);
      const taskId = evt0.result.task.id;

      // Retrieve task via GetTask
      const getRes = await post(url, "/", jsonRpc("GetTask", { id: taskId }, 2));
      const body = JSON.parse(getRes.data);
      expect(body.result.task.id).toBe(taskId);
      // After streaming completes, task should be COMPLETED
      expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
      expect(body.result.task.artifacts).toHaveLength(1);
    });
  });

  describe("ListTasks combined filters", () => {
    it("filters by both contextId and status", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      a2a.onTask("ta", "combo-filter", [{ parts: [{ text: "r" }] }]);
      const url = await a2a.start();

      // Create task
      const r1 = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "combo-filter 1" }] } }, 1),
      );
      const task1 = JSON.parse(r1.data).result.task;

      // Filter with matching contextId and status
      const listRes = await post(
        url,
        "/",
        jsonRpc("ListTasks", { contextId: task1.contextId, status: "TASK_STATE_COMPLETED" }, 2),
      );
      const body = JSON.parse(listRes.data);
      expect(body.result.tasks).toHaveLength(1);
      expect(body.result.tasks[0].id).toBe(task1.id);

      // Filter with matching contextId but wrong status
      const listRes2 = await post(
        url,
        "/",
        jsonRpc("ListTasks", { contextId: task1.contextId, status: "TASK_STATE_WORKING" }, 3),
      );
      const body2 = JSON.parse(listRes2.data);
      expect(body2.result.tasks).toHaveLength(0);
    });
  });

  describe("registerAgent chaining", () => {
    it("returns this for method chaining", () => {
      a2a = new A2AMock();
      const returned = a2a.registerAgent({ name: "chain1" });
      expect(returned).toBe(a2a);
      a2a = null;
    });
  });

  describe("onMessage/onTask/onStreamingTask chaining", () => {
    it("all return this for method chaining", () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "chain" });

      const r1 = a2a.onMessage("chain", "x", [{ text: "y" }]);
      expect(r1).toBe(a2a);

      const r2 = a2a.onTask("chain", "x", [{ parts: [{ text: "y" }] }]);
      expect(r2).toBe(a2a);

      const r3 = a2a.onStreamingTask("chain", "x", []);
      expect(r3).toBe(a2a);

      a2a = null;
    });
  });

  describe("streaming event append flag", () => {
    it("includes append flag on artifact events", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "appender" });
      a2a.onStreamingTask("appender", "append-test", [
        { type: "artifact", parts: [{ text: "chunk1" }], name: "out", append: true },
        {
          type: "artifact",
          parts: [{ text: "chunk2" }],
          name: "out",
          append: true,
          lastChunk: true,
        },
      ]);
      const url = await a2a.start();

      const res = await postSSE(
        url,
        "/",
        jsonRpc("SendStreamingMessage", { message: { parts: [{ text: "append-test" }] } }),
      );

      expect(res.events.length).toBe(2);
      const evt0 = JSON.parse(res.events[0]);
      expect(evt0.result.artifact.append).toBe(true);
      const evt1 = JSON.parse(res.events[1]);
      expect(evt1.result.artifact.append).toBe(true);
      expect(evt1.result.artifact.lastChunk).toBe(true);
    });
  });

  describe("agent card with no agents registered", () => {
    it("returns defaults when no agents are registered", async () => {
      a2a = new A2AMock();
      // Don't register any agent — buildAgentCard should use fallback defaults
      const url = await a2a.start();

      const res = await get(url, "/.well-known/agent-card.json");
      const card = JSON.parse(res.body);
      expect(card.name).toBe("a2a-mock");
      expect(card.description).toBe("A2A mock agent");
      expect(card.version).toBe("1.0.0");
      expect(card.skills).toEqual([]);
      expect(card.capabilities).toEqual({ streaming: true });
    });
  });

  describe("CancelTask on FAILED task", () => {
    it("returns -32002 for FAILED terminal state", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      a2a.onTask("ta", "fail-cancel", [{ parts: [{ text: "r" }] }]);
      const url = await a2a.start();

      const createRes = await post(
        url,
        "/",
        jsonRpc("SendMessage", { message: { parts: [{ text: "fail-cancel" }] } }, 1),
      );
      const taskId = JSON.parse(createRes.data).result.task.id;

      // Patch task to FAILED state
      const tasksMap = (
        a2a as unknown as { tasks: Map<string, { status: { state: string; timestamp: string } }> }
      ).tasks;
      tasksMap.get(taskId)!.status = {
        state: "TASK_STATE_FAILED",
        timestamp: new Date().toISOString(),
      };

      const cancelRes = await post(url, "/", jsonRpc("CancelTask", { id: taskId }, 2));
      const body = JSON.parse(cancelRes.data);
      expect(body.error.code).toBe(-32002);
    });
  });

  describe("unknown JSON-RPC method", () => {
    it("returns method not found error", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "ta" });
      const url = await a2a.start();

      const res = await post(url, "/", jsonRpc("NonExistentMethod", {}));
      const body = JSON.parse(res.data);
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toBe("Method not found");
    });
  });

  describe("findStreamingMatch", () => {
    it("returns null when no streaming patterns exist", async () => {
      a2a = new A2AMock();
      a2a.registerAgent({ name: "msg-only" });
      a2a.onMessage("msg-only", "hello", [{ text: "hi" }]);
      const url = await a2a.start();

      // SendStreamingMessage with text that only matches a message pattern (not streaming)
      const res = await post(
        url,
        "/",
        jsonRpc("SendStreamingMessage", { message: { parts: [{ text: "hello" }] } }),
      );
      const body = JSON.parse(res.data);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32000);
    });
  });
});
