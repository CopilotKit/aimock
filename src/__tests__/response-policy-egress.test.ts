import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  captureHttp,
  startGoldenServer,
  startStubUpstream,
  type GoldenServer,
} from "./golden/harness.js";

const request = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "record policy egress" }],
};
const upstreamBody = JSON.stringify({
  id: "chatcmpl-upstream-policy-egress",
  object: "chat.completion",
  created: 1700000000,
  model: request.model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Recorded unchanged" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
});
const expectedFixture = {
  fixtures: [
    {
      match: {
        userMessage: "record policy egress",
        model: request.model,
        turnIndex: 0,
        hasToolResult: false,
      },
      response: {
        content: "Recorded unchanged",
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      },
    },
  ],
};

async function recordRequest(policy?: string) {
  const fixturePath = mkdtempSync(join(tmpdir(), "aimock-policy-egress-"));
  let server: GoldenServer | undefined;
  const upstream = await startStubUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(upstreamBody);
  });
  try {
    server = await startGoldenServer([], {
      record: { providers: { openai: upstream.url }, fixturePath },
    });
    const relay = await captureHttp(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local-egress-control",
        "x-client-trace": "ordinary-forward-control",
        "x-request-id": "caller-trace-control",
        "x-aimock-strict": "false",
        ...(policy === undefined ? {} : { "X-AIMock-Policy": policy }),
      },
      body: JSON.stringify(request),
    });
    let files: string[] = [];
    await expect
      .poll(() => {
        files = readdirSync(fixturePath).filter((file) => file.endsWith(".json"));
        return files.length;
      })
      .toBe(1);
    const fixtureText = readFileSync(join(fixturePath, files[0]), "utf8");
    const fixture: unknown = JSON.parse(fixtureText);
    expect(upstream.requests).toHaveLength(1);
    const forwarded = upstream.requests[0];
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe("/v1/chat/completions");
    expect(forwarded.body).toBe(JSON.stringify(request));
    expect(forwarded.headers["content-type"]).toBe("application/json");
    expect(forwarded.headers.authorization).toBe("Bearer local-egress-control");
    expect(forwarded.headers["x-client-trace"]).toBe("ordinary-forward-control");
    expect(forwarded.headers["x-request-id"]).toBe("caller-trace-control");
    expect(forwarded.headers["x-aimock-strict"]).toBeUndefined();
    expect(relay.status).toBe(200);
    expect(relay.headers["content-type"]).toBe("application/json");
    expect(relay.body).toBe(upstreamBody);
    expect(fixture).toEqual(expectedFixture);
    if (process.env.F5D_PROOF === "1") {
      console.log(
        JSON.stringify({
          case: policy === undefined ? "ordinary-record-control" : "policy-record-egress",
          upstreamPolicy: forwarded.headers["x-aimock-policy"] ?? null,
          upstreamStrict: forwarded.headers["x-aimock-strict"] ?? null,
          forwardedHeaders: forwarded.headers,
          forwardedBody: forwarded.body,
          relay,
          fixture,
          controls: "PASS",
        }),
      );
    }
    return { forwarded, fixtureText, relay };
  } finally {
    try {
      await server?.close();
    } finally {
      try {
        await upstream.close();
      } finally {
        rmSync(fixturePath, { recursive: true, force: true });
      }
    }
  }
}

it("strips policy on real recording egress and preserves forwarding, relay and fixtures", async () => {
  const ordinary = await recordRequest();
  const policy = await recordRequest("requiredHeaders=off");
  expect(policy.fixtureText).toBe(ordinary.fixtureText);
  expect(policy.relay.body).toBe(ordinary.relay.body);
  expect(ordinary.forwarded.headers["x-aimock-policy"]).toBeUndefined();
  expect(policy.forwarded.headers["x-aimock-policy"]).toBeUndefined();
});
