import { describe, it, expect } from "vitest";

/**
 * Unit tests for multimedia record/replay support in the recorder module.
 *
 * These test the internal detection logic by calling buildFixtureResponse
 * and buildFixtureMatch indirectly through proxyAndRecord integration,
 * as well as directly importing where possible.
 *
 * Since buildFixtureResponse and buildFixtureMatch are not exported,
 * we test them via a lightweight upstream mock that returns the expected
 * shapes, verifying the recorder produces correct fixture responses.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { proxyAndRecord } from "../recorder.js";
import type { Fixture, RecordConfig, ChatCompletionRequest } from "../types.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function createMockReqRes(
  urlPath: string,
  headers: Record<string, string> = {},
): { req: http.IncomingMessage; res: http.ServerResponse; getResponse: () => Promise<string> } {
  const chunks: Buffer[] = [];
  let statusCode = 200;

  const req = {
    method: "POST",
    url: urlPath,
    headers: { "content-type": "application/json", ...headers },
  } as unknown as http.IncomingMessage;

  const res = {
    statusCode,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    writeHead(status: number, hdrs?: Record<string, string>) {
      statusCode = status;
      res.statusCode = status;
    },
    end(data?: string | Buffer) {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
    setHeader() {},
  } as unknown as http.ServerResponse;

  return {
    req,
    res,
    getResponse: async () => Buffer.concat(chunks).toString(),
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-mm-record-"));
}

// ---------------------------------------------------------------------------
// Tests: buildFixtureResponse detection via proxyAndRecord
// ---------------------------------------------------------------------------

describe("multimedia record: image response detection", () => {
  it("detects OpenAI image generation response and saves image fixture", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/img.png", revised_prompt: "a pretty sunset" }],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "dall-e-3",
        messages: [{ role: "user", content: "sunset" }],
        _endpointType: "image",
      };

      const { req, res } = createMockReqRes("/v1/images/generations");
      const proxied = await proxyAndRecord(
        req,
        res,
        request,
        "openai",
        "/v1/images/generations",
        fixtures,
        { record, logger },
      );

      expect(proxied).toBe(true);
      expect(fixtures).toHaveLength(1);
      const fixture = fixtures[0];
      expect(fixture.match.endpoint).toBe("image");
      expect(fixture.match.userMessage).toBe("sunset");

      const response = fixture.response as { image?: { url?: string; revisedPrompt?: string } };
      expect(response.image).toBeDefined();
      expect(response.image!.url).toBe("https://example.com/img.png");
      expect(response.image!.revisedPrompt).toBe("a pretty sunset");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("detects multi-image response", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/1.png" }, { url: "https://example.com/2.png" }],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "dall-e-3",
        messages: [{ role: "user", content: "cats" }],
        _endpointType: "image",
      };

      const { req, res } = createMockReqRes("/v1/images/generations");
      await proxyAndRecord(req, res, request, "openai", "/v1/images/generations", fixtures, {
        record,
        logger,
      });

      const response = fixtures[0].response as { images?: Array<{ url?: string }> };
      expect(response.images).toHaveLength(2);
      expect(response.images![0].url).toBe("https://example.com/1.png");
      expect(response.images![1].url).toBe("https://example.com/2.png");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("detects Gemini Imagen response", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          predictions: [{ bytesBase64Encoded: "iVBORw0KGgo=", mimeType: "image/png" }],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "imagen",
        messages: [{ role: "user", content: "dog" }],
        _endpointType: "image",
      };

      const { req, res } = createMockReqRes("/v1beta/models/imagen:predict");
      await proxyAndRecord(req, res, request, "openai", "/v1beta/models/imagen:predict", fixtures, {
        record,
        logger,
      });

      const response = fixtures[0].response as { image?: { b64Json?: string } };
      expect(response.image).toBeDefined();
      expect(response.image!.b64Json).toBe("iVBORw0KGgo=");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("multimedia record: transcription response detection", () => {
  it("detects OpenAI transcription response", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          task: "transcribe",
          language: "english",
          duration: 5.2,
          text: "Hello world",
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "whisper-1",
        messages: [],
        _endpointType: "transcription",
      };

      const { req, res } = createMockReqRes("/v1/audio/transcriptions");
      await proxyAndRecord(req, res, request, "openai", "/v1/audio/transcriptions", fixtures, {
        record,
        logger,
      });

      expect(fixtures).toHaveLength(1);
      const response = fixtures[0].response as {
        transcription?: { text: string; language?: string; duration?: number };
      };
      expect(response.transcription).toBeDefined();
      expect(response.transcription!.text).toBe("Hello world");
      expect(response.transcription!.language).toBe("english");
      expect(response.transcription!.duration).toBe(5.2);
      expect(fixtures[0].match.endpoint).toBe("transcription");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("detects transcription with words and segments", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          task: "transcribe",
          language: "english",
          duration: 2.0,
          text: "Hi",
          words: [{ word: "Hi", start: 0, end: 0.5 }],
          segments: [{ id: 0, text: "Hi", start: 0, end: 2.0 }],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "whisper-1",
        messages: [],
        _endpointType: "transcription",
      };

      const { req, res } = createMockReqRes("/v1/audio/transcriptions");
      await proxyAndRecord(req, res, request, "openai", "/v1/audio/transcriptions", fixtures, {
        record,
        logger,
      });

      const response = fixtures[0].response as {
        transcription?: { text: string; words?: unknown[]; segments?: unknown[] };
      };
      expect(response.transcription!.words).toHaveLength(1);
      expect(response.transcription!.segments).toHaveLength(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("multimedia record: video response detection", () => {
  it("detects completed video response", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "vid_abc",
          status: "completed",
          url: "https://example.com/video.mp4",
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "sora-2",
        messages: [{ role: "user", content: "dancing cat" }],
        _endpointType: "video",
      };

      const { req, res } = createMockReqRes("/v1/videos");
      await proxyAndRecord(req, res, request, "openai", "/v1/videos", fixtures, { record, logger });

      expect(fixtures).toHaveLength(1);
      const response = fixtures[0].response as {
        video?: { id: string; status: string; url?: string };
      };
      expect(response.video).toBeDefined();
      expect(response.video!.id).toBe("vid_abc");
      expect(response.video!.status).toBe("completed");
      expect(response.video!.url).toBe("https://example.com/video.mp4");
      expect(fixtures[0].match.endpoint).toBe("video");
      expect(fixtures[0].match.userMessage).toBe("dancing cat");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("detects in-progress video response", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "vid_456", status: "in_progress" }));
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "sora-2",
        messages: [{ role: "user", content: "slow motion" }],
        _endpointType: "video",
      };

      const { req, res } = createMockReqRes("/v1/videos");
      await proxyAndRecord(req, res, request, "openai", "/v1/videos", fixtures, { record, logger });

      const response = fixtures[0].response as {
        video?: { id: string; status: string };
      };
      expect(response.video!.id).toBe("vid_456");
      expect(response.video!.status).toBe("processing");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("multimedia record: TTS audio response detection", () => {
  it("detects binary audio response and saves as base64", async () => {
    const fixturePath = makeTmpDir();
    const audioBytes = Buffer.from("fake-audio-content");
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(audioBytes);
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "tts-1",
        messages: [{ role: "user", content: "hello world" }],
        _endpointType: "speech",
      };

      const { req, res } = createMockReqRes("/v1/audio/speech");
      await proxyAndRecord(req, res, request, "openai", "/v1/audio/speech", fixtures, {
        record,
        logger,
      });

      expect(fixtures).toHaveLength(1);
      const response = fixtures[0].response as { audio?: string };
      expect(response.audio).toBe(audioBytes.toString("base64"));
      expect(fixtures[0].match.endpoint).toBe("speech");
      expect(fixtures[0].match.userMessage).toBe("hello world");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("multimedia record: buildFixtureMatch endpoint inclusion", () => {
  it("includes endpoint for image requests", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ created: 1, data: [{ url: "x.png" }] }));
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "dall-e-3",
        messages: [{ role: "user", content: "test" }],
        _endpointType: "image",
      };

      const { req, res } = createMockReqRes("/v1/images/generations");
      await proxyAndRecord(req, res, request, "openai", "/v1/images/generations", fixtures, {
        record,
        logger,
      });

      expect(fixtures[0].match.endpoint).toBe("image");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("does not include endpoint for chat requests", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "hi", role: "assistant" }, finish_reason: "stop" }],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        _endpointType: "chat",
      };

      const { req, res } = createMockReqRes("/v1/chat/completions");
      await proxyAndRecord(req, res, request, "openai", "/v1/chat/completions", fixtures, {
        record,
        logger,
      });

      expect(fixtures[0].match.endpoint).toBeUndefined();
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("does not include endpoint when _endpointType is absent", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "hi", role: "assistant" }, finish_reason: "stop" }],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { openai: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      };

      const { req, res } = createMockReqRes("/v1/chat/completions");
      await proxyAndRecord(req, res, request, "openai", "/v1/chat/completions", fixtures, {
        record,
        logger,
      });

      expect(fixtures[0].match.endpoint).toBeUndefined();
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});
