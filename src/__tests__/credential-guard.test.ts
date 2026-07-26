import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import {
  detectCredentialProvider,
  classifyUpstreamHost,
  checkCredentialUpstreamCompat,
} from "../provider-auth.js";

// ---------------------------------------------------------------------------
// Fail-safe proxy guard: aimock must never relay a caller credential to an
// upstream that belongs to a DIFFERENT provider (the showcase failure mode:
// a GitHub token forwarded to api.openai.com on a fixture miss). Any
// uncertainty fails OPEN so legitimate/self-hosted setups are never blocked.
// ---------------------------------------------------------------------------

describe("detectCredentialProvider", () => {
  it.each([
    ["github_pat_11ABCDEF0000abcdef", "github"],
    ["ghp_abc123", "github"],
    ["gho_abc123", "github"],
    ["ghs_abc123", "github"],
    ["sk-ant-api03-xyz", "anthropic"],
    ["sk-or-v1-abc", "openrouter"],
    ["xai-abc", "xai"],
    ["gsk_abc", "groq"],
    ["AIzaSyABC", "google"],
    ["sk-proj-abc", "openai"],
    ["sk-abc", "openai"],
  ])("identifies %s as %s", (cred, expected) => {
    expect(detectCredentialProvider(cred)).toBe(expected);
  });

  it("returns undefined for placeholder / custom / empty credentials", () => {
    expect(detectCredentialProvider("sk-aimock-dev-ci")).toBeUndefined(); // dummy marker
    expect(detectCredentialProvider("my-custom-gateway-key")).toBeUndefined();
    expect(detectCredentialProvider("")).toBeUndefined();
    expect(detectCredentialProvider(undefined)).toBeUndefined();
  });
});

describe("classifyUpstreamHost", () => {
  it.each([
    ["api.openai.com", "openai"],
    ["api.anthropic.com", "anthropic"],
    ["generativelanguage.googleapis.com", "google"],
    ["aiplatform.googleapis.com", "google"],
    ["api.x.ai", "xai"],
    ["api.groq.com", "groq"],
    ["openrouter.ai", "openrouter"],
    ["models.inference.ai.azure.com", "github"],
    ["models.github.ai", "github"],
  ])("classifies %s as %s", (host, expected) => {
    expect(classifyUpstreamHost(host)).toBe(expected);
  });

  it("returns undefined for unrecognized / self-hosted hosts", () => {
    expect(classifyUpstreamHost("127.0.0.1")).toBeUndefined();
    expect(classifyUpstreamHost("localhost")).toBeUndefined();
    expect(classifyUpstreamHost("my-gateway.internal")).toBeUndefined();
  });
});

describe("checkCredentialUpstreamCompat", () => {
  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
  const u = (s: string) => new URL(s);

  afterEach(() => {
    delete process.env.AIMOCK_ALLOW_CROSS_PROVIDER_PROXY;
  });

  it("REFUSES a GitHub token bound for api.openai.com (the showcase bug)", () => {
    const r = checkCredentialUpstreamCompat(
      bearer("github_pat_11ABCDEF"),
      u("https://api.openai.com/v1/chat/completions"),
      "openai",
    );
    expect(r.ok).toBe(false);
    expect(r.detectedProvider).toBe("github");
    expect(r.upstreamProvider).toBe("openai");
    expect(r.upstreamHost).toBe("api.openai.com");
  });

  it("ALLOWS a GitHub token bound for GitHub Models (legitimate)", () => {
    expect(
      checkCredentialUpstreamCompat(
        bearer("github_pat_11ABCDEF"),
        u("https://models.inference.ai.azure.com/chat/completions"),
        "openai",
      ).ok,
    ).toBe(true);
  });

  it("ALLOWS a matching OpenAI key to api.openai.com", () => {
    expect(
      checkCredentialUpstreamCompat(
        bearer("sk-proj-abc"),
        u("https://api.openai.com/v1/chat/completions"),
        "openai",
      ).ok,
    ).toBe(true);
  });

  it("fails OPEN for an unknown credential", () => {
    expect(
      checkCredentialUpstreamCompat(bearer("custom-key"), u("https://api.openai.com/x"), "openai")
        .ok,
    ).toBe(true);
  });

  it("fails OPEN for an unrecognized upstream host", () => {
    expect(
      checkCredentialUpstreamCompat(bearer("github_pat_x"), u("http://127.0.0.1:1234/x"), "openai")
        .ok,
    ).toBe(true);
  });

  it("fails OPEN for a dummy placeholder key", () => {
    expect(
      checkCredentialUpstreamCompat(bearer("sk-aimock-x"), u("https://api.openai.com/x"), "openai")
        .ok,
    ).toBe(true);
  });

  it("fails OPEN for a signed/OAuth provider with no static-key scheme (bedrock)", () => {
    expect(
      checkCredentialUpstreamCompat(
        bearer("github_pat_x"),
        u("https://api.openai.com/x"),
        "bedrock",
      ).ok,
    ).toBe(true);
  });

  it("reads non-bearer schemes: a GitHub token in x-api-key bound for api.anthropic.com is REFUSED", () => {
    const r = checkCredentialUpstreamCompat(
      { "x-api-key": "github_pat_11ABCDEF" },
      u("https://api.anthropic.com/v1/messages"),
      "anthropic",
    );
    expect(r.ok).toBe(false);
    expect(r.upstreamProvider).toBe("anthropic");
  });

  it("honors the AIMOCK_ALLOW_CROSS_PROVIDER_PROXY escape hatch", () => {
    process.env.AIMOCK_ALLOW_CROSS_PROVIDER_PROXY = "1";
    expect(
      checkCredentialUpstreamCompat(bearer("github_pat_x"), u("https://api.openai.com/x"), "openai")
        .ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: the guard is wired into the proxy-on-miss path.
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

interface FakeUpstream {
  server: http.Server;
  url: string;
  count: () => number;
}

function createFakeUpstream(): Promise<FakeUpstream> {
  return new Promise((resolve) => {
    let count = 0;
    const server = http.createServer((req, res) => {
      count++;
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion",
            created: 0,
            model: "gpt-4o-mini",
            choices: [
              { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, count: () => count });
    });
  });
}

const CHAT_PATH = "/v1/chat/completions";
const CHAT_BODY = { model: "gpt-4o-mini", messages: [{ role: "user", content: "unmatched-miss" }] };

describe("proxy-on-miss credential guard (integration)", () => {
  let recorder: ServerInstance | undefined;
  let upstream: FakeUpstream | undefined;

  afterEach(async () => {
    if (recorder) {
      await new Promise<void>((r) => recorder!.server.close(() => r()));
      recorder = undefined;
    }
    if (upstream) {
      await new Promise<void>((r) => upstream!.server.close(() => r()));
      upstream = undefined;
    }
  });

  it("REFUSES a GitHub token → api.openai.com with 502 proxy_refused (no upstream call)", async () => {
    // The guard short-circuits before any socket is opened, so this makes no
    // real network request to api.openai.com.
    recorder = await createServer([], {
      port: 0,
      metrics: true,
      record: {
        providers: { openai: "https://api.openai.com" },
        proxyOnly: true,
        upstreamTimeoutMs: 3000,
      },
    });
    const res = await httpPost(recorder.url + CHAT_PATH, CHAT_BODY, {
      Authorization: "Bearer github_pat_11ABCDEF0000",
    });
    expect(res.status).toBe(502);
    expect(res.body).toContain("proxy_refused");

    const metrics = await fetch(recorder.url + "/metrics").then((r) => r.text());
    expect(metrics).toContain("aimock_proxy_refused_total");
    expect(metrics).toContain('reason="credential_provider_mismatch"');
  });

  it("ALLOWS + forwards to an unrecognized (self-hosted) upstream and records the forwarded metric", async () => {
    upstream = await createFakeUpstream();
    recorder = await createServer([], {
      port: 0,
      metrics: true,
      record: { providers: { openai: upstream.url }, proxyOnly: true },
    });
    // Same GitHub token, but the upstream host is unrecognized → fail open →
    // forwarded (aimock does not second-guess a self-hosted / custom gateway).
    const res = await httpPost(recorder.url + CHAT_PATH, CHAT_BODY, {
      Authorization: "Bearer github_pat_11ABCDEF0000",
      "X-AIMock-Context": "demo",
    });
    expect(res.status).toBe(200);
    expect(upstream.count()).toBe(1);

    const metrics = await fetch(recorder.url + "/metrics").then((r) => r.text());
    expect(metrics).toContain("aimock_proxy_forwarded_total");
    expect(metrics).toContain('context_present="true"');
  });
});
