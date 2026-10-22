import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, startFromConfig } from "../config-loader.js";
import { Logger } from "../logger.js";
import { captureHttp } from "./golden/harness.js";

const root = resolve(__dirname, "../..");
const binaries = ["cli.js", "aimock-cli.js", "cli.cjs", "aimock-cli.cjs"];
const requiredBody =
  '{"type":"error","error":{"type":"invalid_request_error","message":"anthropic-version: header is required"},"request_id":"req-<#0>"}';
const body = JSON.stringify({
  model: "claude-test",
  messages: [{ role: "user", content: "hello" }],
});
let dir: string;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(() => {
  for (const binary of binaries) {
    const built = join(root, "dist", binary);
    const source = join(root, "src", binary.startsWith("aimock") ? "aimock-cli.ts" : "cli.ts");
    if (!existsSync(built) || statSync(built).mtimeMs < statSync(source).mtimeMs) {
      throw new Error(`Run pnpm build before testing the current ${binary} binary.`);
    }
  }
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "response-policy-cli-"));
  writeFileSync(
    join(dir, "fixtures.json"),
    JSON.stringify({
      fixtures: [{ match: { userMessage: "hello" }, response: { content: "ok" } }],
    }),
  );
});

afterEach(async () => {
  try {
    for (const stop of cleanup.splice(0).reverse()) await stop();
  } finally {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  }
});

function configFile(policy?: unknown, strict = false) {
  const file = join(dir, "aimock.json");
  writeFileSync(
    file,
    JSON.stringify({
      port: 0,
      strict,
      llm: { fixtures: join(dir, "fixtures.json"), policy, logLevel: "silent" },
    }),
  );
  return file;
}

async function configServer(
  policy?: unknown,
  overrides?: Parameters<typeof startFromConfig>[1],
  strict = false,
) {
  const server = await startFromConfig(loadConfig(configFile(policy, strict)), overrides);
  cleanup.push(() => server.llmock.stop());
  return server.url;
}

async function count(url: string, headers: Record<string, string> = {}) {
  const result = await captureHttp(`${url}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  console.log(
    JSON.stringify({
      surface: "count_tokens",
      headers,
      status: result.status,
      responseHeaders: result.headers,
      body: result.body,
    }),
  );
  return result;
}

function cli(
  binary: string,
  args: string[] = [],
  policy?: unknown,
  emptyFixtures = false,
  extraEnv: Record<string, string> = {},
) {
  const file = configFile(policy);
  if (emptyFixtures) writeFileSync(join(dir, "fixtures.json"), '{"fixtures":[]}');
  const base = binary.startsWith("aimock")
    ? ["--config", file]
    : ["--port", "0", "--fixtures", join(dir, "fixtures.json")];
  let stdout = "";
  let stderr = "";
  const env = { ...process.env };
  delete env.AIMOCK_API_KEYS;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [join(root, "dist", binary), ...base, ...args], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  let ready: (url: string) => void;
  const listening = new Promise<string>((resolve) => {
    ready = resolve;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const url = stdout.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
    if (url) ready(url);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  return {
    async start() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          listening,
          exited.then((exit) => {
            throw new Error(`${binary} exited ${JSON.stringify(exit)}: ${stderr}`);
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${binary} startup timed out: ${stdout} ${stderr}`)),
              10_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async exit() {
      const result = await exited;
      console.log(JSON.stringify({ binary, args, ...result, stdout, stderr }));
      return { ...result, stdout, stderr };
    },
  };
}

describe("policy config startup", () => {
  it("enforces the config policy on the real startup surface", async () => {
    const result = await count(await configServer({ requiredHeaders: "enforce" }));
    expect(result.status).toBe(400);
    expect(result.body).toBe(requiredBody);
    expect(result.headers["x-request-id"]).toBe("req-<#0>");
  });

  it("merges override keys and leaves request headers highest", async () => {
    // JSON exercises the same untyped config input as real config files.
    const overrides = JSON.parse('{"policy":{"requiredHeaders":"off"}}');
    const url = await configServer({ requiredHeaders: "enforce" }, overrides, true);
    expect((await count(url)).status).toBe(200);
    expect(
      (
        await count(url, {
          "x-aimock-policy": "requiredHeaders=enforce",
          "x-aimock-strict": "false",
        })
      ).status,
    ).toBe(400);
    const enforce = JSON.parse('{"policy":{"requiredHeaders":"enforce"}}');
    const enabled = await configServer({ requiredHeaders: "off" }, enforce);
    expect((await count(enabled)).status).toBe(400);
    expect((await count(enabled, { "x-aimock-policy": "requiredHeaders=off" })).status).toBe(200);
  });

  it.each([
    { policy: { requiredHeaders: "bad", unknown: "enforce" }, warnings: 2, status: 200 },
    { policy: { requiredHeaders: "ENFORCE", unknown: "off" }, warnings: 1, status: 400 },
    { policy: false, warnings: 1, status: 200 },
  ])("warns and ignores invalid config entries: $policy", async ({ policy, warnings, status }) => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const url = await configServer(policy);
    expect(warn).toHaveBeenCalledTimes(warnings);
    expect(warn.mock.calls.every(([message]) => String(message).includes("policy"))).toBe(true);
    expect((await count(url)).status).toBe(status);
  });

  it("preserves default and strict-only behavior", async () => {
    expect((await count(await configServer())).status).toBe(200);
    expect((await count(await configServer(undefined, undefined, true))).status).toBe(200);
  });
});

describe.each(binaries)("built %s policy", (binary) => {
  it("enforces a valid policy flag", async () => {
    const url = await cli(binary, ["--policy", "requiredHeaders=enforce"]).start();
    const result = await count(url);
    expect(result.status).toBe(400);
    expect(result.body).toBe(requiredBody);
    expect(result.headers["x-request-id"]).toBe("req-<#0>");
    expect((await count(url, { "anthropic-version": "2023-06-01" })).status).toBe(200);
  });

  it("accepts repeatable flags, case-insensitive values and last-wins", async () => {
    const url = await cli(
      binary,
      ["--policy", "requiredHeaders=ENFORCE", "--policy", "requiredHeaders=off"],
      { requiredHeaders: "enforce" },
    ).start();
    expect((await count(url)).status).toBe(200);
    expect(
      (
        await count(url, {
          "x-aimock-policy": "requiredHeaders=enforce",
          "x-aimock-strict": "false",
        })
      ).status,
    ).toBe(400);
  });

  it("lets a flag enable an off config and a header disable it", async () => {
    const url = await cli(binary, ["--policy", "requiredHeaders=enforce"], {
      requiredHeaders: "off",
    }).start();
    expect((await count(url)).status).toBe(400);
    expect((await count(url, { "x-aimock-policy": "requiredHeaders=off" })).status).toBe(200);
  });

  it.each([
    "unknown=off",
    "RequiredHeaders=enforce",
    "requiredHeaders=true",
    "requiredHeaders=",
    "requiredHeaders",
    "requiredHeaders=enforce=off",
    "authErrors=strict",
    "AuthErrors=native",
    "modelCatalog=anthropic",
  ])("rejects invalid CLI entry %s with usage exit 1", async (entry) => {
    const result = await cli(binary, ["--policy", entry]).exit();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--policy");
    expect(result.stderr).toContain("key=value");
    expect(result.stdout).not.toContain("server listening");
  });

  it("keeps the 1.45 inbound-auth body by default and opts into native bodies", async () => {
    const keys = { AIMOCK_API_KEYS: "accepted" };
    const legacyUrl = await cli(binary, [], undefined, false, keys).start();
    const nativeUrl = await cli(
      binary,
      ["--policy", "authErrors=native"],
      undefined,
      false,
      keys,
    ).start();
    const legacy =
      '{"error":{"message":"Invalid API key","type":"authentication_error","code":"invalid_api_key"}}';
    const cases = [
      {
        path: "/v1/messages/count_tokens",
        native:
          '{"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}',
      },
      {
        path: "/v1beta/models/gemini-test:countTokens",
        native: '{"error":{"code":401,"message":"Invalid API key","status":"UNAUTHENTICATED"}}',
      },
    ];
    for (const { path, native } of cases) {
      const init = { method: "POST", headers: { "x-api-key": "bad" }, body: "{}" };
      const byDefault = await captureHttp(legacyUrl + path, init);
      expect(byDefault.status).toBe(401);
      expect(byDefault.body).toBe(legacy);
      const optedIn = await captureHttp(nativeUrl + path, init);
      expect(optedIn.status).toBe(401);
      expect(optedIn.body).toBe(native);
    }
  });

  it("keeps the 1.45 OpenAI /v1/models list by default and opts into Anthropic", async () => {
    const legacyUrl = await cli(binary).start();
    const nativeUrl = await cli(binary, ["--policy", "modelCatalog=native"]).start();
    const model = "claude-3-5-sonnet-20241022";
    const cases = [
      { name: "x-api-key", headers: { "x-api-key": "k" }, native: "anthropic" },
      {
        name: "x-api-key + anthropic-version",
        headers: { "x-api-key": "k", "anthropic-version": "2023-06-01" },
        native: "anthropic",
      },
      { name: "bearer", headers: { authorization: "Bearer k" }, native: "openai" },
      { name: "no auth", headers: {}, native: "openai" },
      {
        name: "anthropic-version",
        headers: { "anthropic-version": "2023-06-01" },
        native: "anthropic",
      },
    ] as const;
    const format = (raw: string | undefined) => {
      const parsed: Record<string, unknown> = JSON.parse(raw ?? "null");
      if (parsed.object === "list" || parsed.object === "model") return "openai";
      if ("has_more" in parsed || parsed.type === "model") return "anthropic";
      return "unknown";
    };
    for (const { name, headers, native } of cases) {
      // The 1.45 list route is OpenAI-format for every header set unless opted in.
      const listDefault = await captureHttp(legacyUrl + "/v1/models", { headers });
      expect(listDefault.status, `${name} list`).toBe(200);
      expect(format(listDefault.body), `${name} list default`).toBe("openai");
      // 1.45 ignored list query parameters, so Anthropic cursors and limits never 400.
      const pagedDefault = await captureHttp(legacyUrl + "/v1/models?limit=0&after_id=missing", {
        headers,
      });
      expect(pagedDefault.status, `${name} paged list`).toBe(200);
      expect(format(pagedDefault.body), `${name} paged list default`).toBe("openai");
      const listNative = await captureHttp(nativeUrl + "/v1/models", { headers });
      expect(listNative.status, `${name} list`).toBe(200);
      expect(format(listNative.body), `${name} list native`).toBe(native);
      // The newer detail route selects by request headers under either policy.
      for (const url of [legacyUrl, nativeUrl]) {
        const detail = await captureHttp(`${url}/v1/models/${model}`, { headers });
        expect(detail.status, `${name} detail`).toBe(200);
        expect(format(detail.body), `${name} detail`).toBe(native);
      }
    }
  });

  it("preserves startup with no policy", async () => {
    expect((await count(await cli(binary).start())).status).toBe(200);
  });

  if (!binary.startsWith("aimock")) {
    it("preserves strict-only success and empty-fixture strict startup rejection", async () => {
      expect((await count(await cli(binary, ["--strict"]).start())).status).toBe(200);
      const rejected = await cli(binary, ["--strict"], undefined, true).exit();
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("No fixtures loaded and validation/strict mode is enabled");
    });
  }
});
