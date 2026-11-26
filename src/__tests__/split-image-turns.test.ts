import { afterEach, describe, expect, it } from "vitest";
import type { ChatCompletionRequest, Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { claudeToCompletionRequest } from "../messages.js";
import { geminiToCompletionRequest } from "../gemini.js";
import { geminiInteractionsToCompletionRequest } from "../gemini-interactions.js";
import { bedrockToCompletionRequest } from "../bedrock.js";
import { converseToCompletionRequest } from "../bedrock-converse.js";
import { cohereToCompletionRequest } from "../cohere.js";

const PROMPT = "what is in this image";
const PNG = "iVBORw0KGgo=";
const DATA_URL = `data:image/png;base64,${PNG}`;
const claudeImage = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: PNG },
};
const interactionsImage = { type: "image", data: PNG, mime_type: "image/png" };

interface Wire {
  name: string;
  path: string;
  body: (...messages: unknown[]) => Record<string, unknown>;
  text: (text: string) => unknown;
  image: unknown;
  convert: (body: never) => ChatCompletionRequest;
}

const anthropicMessages = (...messages: unknown[]) => ({
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  messages,
});
const claudeText = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

const wires: Wire[] = [
  {
    name: "Anthropic Messages",
    path: "/v1/messages",
    body: anthropicMessages,
    text: claudeText,
    image: { role: "user", content: [claudeImage] },
    convert: claudeToCompletionRequest,
  },
  {
    name: "Gemini generateContent",
    path: "/v1beta/models/gemini-2.5-flash:generateContent",
    body: (...contents) => ({ contents }),
    text: (text) => ({ role: "user", parts: [{ text }] }),
    image: { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] },
    convert: (b) => geminiToCompletionRequest(b, "gemini-2.5-flash", false),
  },
  {
    name: "Gemini Interactions steps",
    path: "/v1beta/interactions",
    body: (...input) => ({ model: "gemini-2.5-flash", stream: false, input }),
    text: (text) => ({ type: "user_input", content: [{ type: "text", text }] }),
    image: { type: "user_input", content: [interactionsImage] },
    convert: geminiInteractionsToCompletionRequest,
  },
  {
    name: "Gemini Interactions turns",
    path: "/v1beta/interactions",
    body: (...input) => ({ model: "gemini-2.5-flash", stream: false, input }),
    text: (text) => ({ role: "user", content: [{ type: "text", text }] }),
    image: { role: "user", content: [interactionsImage] },
    convert: geminiInteractionsToCompletionRequest,
  },
  {
    name: "Bedrock invoke",
    path: "/model/claude/invoke",
    body: (...messages) => ({ anthropic_version: "bedrock-2023-05-31", max_tokens: 64, messages }),
    text: claudeText,
    image: { role: "user", content: [claudeImage] },
    convert: (b) => bedrockToCompletionRequest(b, "claude"),
  },
  {
    name: "Bedrock Converse",
    path: "/model/claude/converse",
    body: (...messages) => ({ messages }),
    text: (text) => ({ role: "user", content: [{ text }] }),
    image: { role: "user", content: [{ image: { format: "png", source: { bytes: PNG } } }] },
    convert: (b) => converseToCompletionRequest(b, "claude"),
  },
  {
    name: "Cohere v2",
    path: "/v2/chat",
    body: (...messages) => ({ model: "command-a-vision", messages }),
    text: (text) => ({ role: "user", content: [{ type: "text", text }] }),
    image: { role: "user", content: [{ type: "image_url", image_url: { url: DATA_URL } }] },
    convert: cohereToCompletionRequest,
  },
];

const fixtures: Fixture[] = [{ match: { userMessage: PROMPT }, response: { content: "A logo." } }];

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

describe.each(wires)("$name: prompt split from its image", (wire) => {
  it("matches the prompt when an image only user message follows it", async () => {
    instance = await createServer(fixtures, { strict: true });
    const res = await fetch(`${instance.url}${wire.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wire.body(wire.text(PROMPT), wire.image)),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("A logo.");
  });

  it("leaves an image only user message text less (null)", () => {
    const { messages } = wire.convert(wire.body(wire.text(PROMPT), wire.image) as never);
    expect(messages.map((m) => m.content)).toEqual([PROMPT, null]);
  });

  it("keeps an explicit empty text part as an empty string", () => {
    const { messages } = wire.convert(wire.body(wire.text(""), wire.image) as never);
    expect(messages.at(0)?.content).toBe("");
  });
});
