import type { ChatCompletionRequest, ChatMessage, ContentPart, Fixture } from "./types.js";
import {
  isImageResponse,
  isAudioResponse,
  isTranscriptionResponse,
  isVideoResponse,
} from "./helpers.js";

export function getLastMessageByRole(messages: ChatMessage[], role: string): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return messages[i];
  }
  return null;
}

/**
 * Extract the text content from a message's content field.
 * Handles both plain string content and array-of-parts content
 * (e.g. `[{type: "text", text: "..."}]` as sent by some SDKs).
 */
export function getTextContent(content: string | ContentPart[] | null): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((p) => p.type === "text" && typeof p.text === "string" && p.text !== "")
      .map((p) => p.text as string);
    return texts.length > 0 ? texts.join("") : null;
  }
  return null;
}

export function matchFixture(
  fixtures: Fixture[],
  req: ChatCompletionRequest,
  matchCounts?: Map<Fixture, number>,
  requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest,
): Fixture | null {
  // Apply transform once before matching — used for stripping dynamic data
  const effective = requestTransform ? requestTransform(req) : req;
  const useExactMatch = !!requestTransform;

  for (const fixture of fixtures) {
    const { match } = fixture;

    // predicate — if present, must return true (receives original request)
    if (match.predicate !== undefined) {
      if (!match.predicate(req)) continue;
    }

    // endpoint — bidirectional filtering:
    // 1. If fixture has endpoint set, only match requests of that type
    // 2. If request has _endpointType but fixture doesn't, skip fixtures
    //    whose response type is incompatible (prevents generic chat fixtures
    //    from matching image/speech/video requests and causing 500s)
    const reqEndpoint = effective._endpointType as string | undefined;
    if (match.endpoint !== undefined) {
      if (match.endpoint !== reqEndpoint) continue;
    } else if (reqEndpoint && reqEndpoint !== "chat" && reqEndpoint !== "embedding") {
      // Fixture has no endpoint restriction but request is multimedia —
      // only match if the response type is compatible
      const r = fixture.response;
      const compatible =
        (reqEndpoint === "image" && isImageResponse(r)) ||
        (reqEndpoint === "speech" && isAudioResponse(r)) ||
        (reqEndpoint === "transcription" && isTranscriptionResponse(r)) ||
        (reqEndpoint === "video" && isVideoResponse(r));
      if (!compatible) continue;
    }

    // userMessage — case-sensitive match against the last user message content.
    // String matching is intentionally case-sensitive so fixture authors can
    // rely on exact string values. This differs from the case-insensitive
    // matchesPattern() in helpers.ts, which is used for search/rerank/moderation
    // where exact casing rarely matters.
    if (match.userMessage !== undefined) {
      const msg = getLastMessageByRole(effective.messages, "user");
      const text = msg ? getTextContent(msg.content) : null;
      if (!text) continue;
      if (typeof match.userMessage === "string") {
        if (useExactMatch) {
          if (text !== match.userMessage) continue;
        } else {
          if (!text.includes(match.userMessage)) continue;
        }
      } else {
        match.userMessage.lastIndex = 0;
        if (!match.userMessage.test(text)) continue;
      }
    }

    // toolCallId — match against the last tool message's tool_call_id
    if (match.toolCallId !== undefined) {
      const msg = getLastMessageByRole(effective.messages, "tool");
      if (!msg || msg.tool_call_id !== match.toolCallId) continue;
    }

    // toolName — match against any tool definition by function.name
    if (match.toolName !== undefined) {
      const tools = effective.tools ?? [];
      const found = tools.some((t) => t.function.name === match.toolName);
      if (!found) continue;
    }

    // inputText — case-sensitive match against the embedding input text.
    // Same rationale as userMessage above: fixture authors specify exact strings.
    if (match.inputText !== undefined) {
      const embeddingInput = effective.embeddingInput;
      if (!embeddingInput) continue;
      if (typeof match.inputText === "string") {
        if (useExactMatch) {
          if (embeddingInput !== match.inputText) continue;
        } else {
          if (!embeddingInput.includes(match.inputText)) continue;
        }
      } else {
        match.inputText.lastIndex = 0;
        if (!match.inputText.test(embeddingInput)) continue;
      }
    }

    // responseFormat — exact string match against request response_format.type
    if (match.responseFormat !== undefined) {
      const reqType = effective.response_format?.type;
      if (reqType !== match.responseFormat) continue;
    }

    // model — exact string or regexp
    if (match.model !== undefined) {
      if (typeof match.model === "string") {
        if (effective.model !== match.model) continue;
      } else {
        match.model.lastIndex = 0;
        if (!match.model.test(effective.model)) continue;
      }
    }

    // sequenceIndex — check against the fixture's match count
    if (match.sequenceIndex !== undefined && matchCounts !== undefined) {
      const count = matchCounts.get(fixture) ?? 0;
      if (count !== match.sequenceIndex) continue;
    }

    return fixture;
  }

  return null;
}
