import type { ChatCompletionRequest, ChatMessage, ContentPart, Fixture } from "./types.js";

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

    // userMessage — match against the last user message content
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

    // inputText — match against the embedding input text (used by embeddings endpoint)
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
