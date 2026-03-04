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

export function matchFixture(fixtures: Fixture[], req: ChatCompletionRequest): Fixture | null {
  for (const fixture of fixtures) {
    const { match } = fixture;

    // predicate — if present, must return true
    if (match.predicate !== undefined) {
      if (!match.predicate(req)) continue;
    }

    // userMessage — match against the last user message content
    if (match.userMessage !== undefined) {
      const msg = getLastMessageByRole(req.messages, "user");
      const text = msg ? getTextContent(msg.content) : null;
      if (!text) continue;
      if (typeof match.userMessage === "string") {
        if (!text.includes(match.userMessage)) continue;
      } else {
        if (!match.userMessage.test(text)) continue;
      }
    }

    // toolCallId — match against the last tool message's tool_call_id
    if (match.toolCallId !== undefined) {
      const msg = getLastMessageByRole(req.messages, "tool");
      if (!msg || msg.tool_call_id !== match.toolCallId) continue;
    }

    // toolName — match against any tool definition by function.name
    if (match.toolName !== undefined) {
      const tools = req.tools ?? [];
      const found = tools.some((t) => t.function.name === match.toolName);
      if (!found) continue;
    }

    // model — exact string or regexp
    if (match.model !== undefined) {
      if (typeof match.model === "string") {
        if (req.model !== match.model) continue;
      } else {
        if (!match.model.test(req.model)) continue;
      }
    }

    return fixture;
  }

  return null;
}
