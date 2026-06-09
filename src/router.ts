import type { ChatCompletionRequest, ChatMessage, ContentPart, Fixture } from "./types.js";
import {
  isImageResponse,
  isAudioResponse,
  isTranscriptionResponse,
  isVideoResponse,
  isJSONResponse,
  isErrorResponse,
} from "./helpers.js";

export function getLastMessageByRole(messages: ChatMessage[], role: string): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return messages[i];
  }
  return null;
}

/**
 * Concatenate the text content of every `system` role message in order.
 * Hosts that build a system context from multiple sources (persona, agent
 * context entries, tool guidance) often emit several system messages in one
 * request; this joins them with newlines so a substring matcher sees the
 * whole context as one body.
 */
export function getSystemText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") continue;
    const text = getTextContent(m.content);
    if (text) parts.push(text);
  }
  return parts.join("\n");
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

/**
 * Result of {@link matchFixtureDiagnostic}: the matched fixture (or `null`) plus
 * the number of fixtures that matched the request SHAPE (every predicate above
 * the sequenceIndex/turnIndex gates) but were rejected ONLY by the
 * sequenceIndex/turnIndex count state.
 *
 * `skippedBySequenceOrTurn > 0` with `fixture === null` distinguishes a
 * "sequence/turn exhausted" miss (candidate fixtures existed but their count
 * gate had moved on) from a true "no fixture had a matching shape" miss — used
 * to disambiguate the strict-mode 503 message.
 */
export interface MatchFixtureDiagnostic {
  fixture: Fixture | null;
  skippedBySequenceOrTurn: number;
}

/**
 * Match a fixture against a request, additionally reporting WHY a `null` result
 * occurred. Shares the exact predicate loop with {@link matchFixture}; a fixture
 * that passes every shape predicate but fails ONLY the sequenceIndex or
 * turnIndex gate increments `skippedBySequenceOrTurn`. {@link matchFixture} is a
 * thin wrapper that returns the `.fixture` field, so existing callers are
 * unaffected.
 */
export function matchFixtureDiagnostic(
  fixtures: Fixture[],
  req: ChatCompletionRequest,
  matchCounts?: Map<Fixture, number>,
  requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest,
): MatchFixtureDiagnostic {
  // Apply transform once before matching — used for stripping dynamic data
  const effective = requestTransform ? requestTransform(req) : req;
  const useExactMatch = !!requestTransform;

  let skippedBySequenceOrTurn = 0;

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
    } else if (
      reqEndpoint &&
      reqEndpoint !== "chat" &&
      reqEndpoint !== "embedding" &&
      !reqEndpoint.startsWith("realtime")
    ) {
      // Fixture has no endpoint restriction but request is multimedia —
      // only match if the response type is compatible.
      // Function responses cannot be checked statically, so treat them as compatible.
      const r = fixture.response;
      if (typeof r !== "function") {
        const compatible =
          (reqEndpoint === "image" && isImageResponse(r)) ||
          (reqEndpoint === "speech" && isAudioResponse(r)) ||
          (reqEndpoint === "elevenlabs-tts" && isAudioResponse(r)) ||
          (reqEndpoint === "audio-gen" && isAudioResponse(r)) ||
          (reqEndpoint === "fal-audio" && isAudioResponse(r)) ||
          (reqEndpoint === "fal" && (isJSONResponse(r) || isErrorResponse(r))) ||
          (reqEndpoint === "transcription" && isTranscriptionResponse(r)) ||
          (reqEndpoint === "translation" && isTranscriptionResponse(r)) ||
          (reqEndpoint === "video" && isVideoResponse(r));
        if (!compatible) continue;
      }
    }

    // context — opt-in exact match against the request's _context field.
    // If fixture specifies a context, only match requests with that exact context.
    // If fixture omits context, match any request regardless of _context.
    if (match.context !== undefined) {
      if (effective._context !== match.context) continue;
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

    // systemMessage — case-sensitive substring, regexp, or array-of-substrings
    // match against the joined text of every system message in the request.
    // Use to gate a fixture on host-supplied context (e.g. agent-context
    // entries) so that when the calling app changes that context the fixture
    // stops matching and the request falls through to the next fixture or
    // upstream proxy.
    //
    // Array form (string[]) requires ALL substrings to be present — useful
    // when the gate must combine multiple non-adjacent tokens (e.g. a default
    // name AND a default activity list whose positions in the serialised
    // context JSON aren't stable).
    if (match.systemMessage !== undefined) {
      const text = getSystemText(effective.messages);
      if (!text) continue;
      const sm = match.systemMessage;
      if (Array.isArray(sm)) {
        // Empty array is treated as "no constraint" → effectively matches
        // unconditionally. Validation rejects this at load time for JSON
        // fixtures; programmatic callers that pass [] get the same
        // permissive behaviour as not setting systemMessage at all.
        let allPresent = true;
        for (const needle of sm) {
          if (!text.includes(needle)) {
            allPresent = false;
            break;
          }
        }
        if (!allPresent) continue;
      } else if (typeof sm === "string") {
        if (useExactMatch) {
          if (text !== sm) continue;
        } else {
          if (!text.includes(sm)) continue;
        }
      } else {
        sm.lastIndex = 0;
        if (!sm.test(text)) continue;
      }
    }

    // toolCallId — a toolCallId fixture answers the model's response to a tool
    // result, which by API contract only happens when the conversation's LAST
    // message is a tool result. If a newer user (or other) turn follows the
    // tool message, the stale tool_call_id must not shadow userMessage matchers.
    if (match.toolCallId !== undefined) {
      const last = effective.messages[effective.messages.length - 1];
      if (!last || last.role !== "tool" || last.tool_call_id !== match.toolCallId) continue;
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

    // model — exact match or prefix + dash-digit boundary for strings (so that
    // "claude-opus-4" matches "claude-opus-4-20250514" but "gpt-4" does NOT
    // match "gpt-4o" and "gpt-4o" does NOT match "gpt-4o-mini"), regexp unchanged
    if (match.model !== undefined) {
      if (typeof match.model === "string") {
        if (effective.model !== match.model) {
          if (!effective.model?.startsWith(match.model)) continue;
          const rest = effective.model.slice(match.model.length);
          if (!/^-\d/.test(rest)) continue;
        }
      } else {
        match.model.lastIndex = 0;
        if (!match.model.test(effective.model ?? "")) continue;
      }
    }

    // hasToolResult — request-SHAPE predicate: does the conversation contain a
    // tool result message? Must be evaluated with the other shape predicates
    // ABOVE the sequence/turn state gates so that a fixture whose shape never
    // matched is not miscounted as "skipped by sequence/turn state".
    if (match.hasToolResult !== undefined) {
      const hasTool = effective.messages.some((m) => m.role === "tool");
      if (hasTool !== match.hasToolResult) continue;
    }

    // At this point every SHAPE predicate above has passed. The sequenceIndex
    // and turnIndex gates below reject based on per-test count / turn STATE,
    // not request shape — a fixture that fails only these is a "candidate that
    // was skipped by sequence/turn state", which we count separately so callers
    // can disambiguate the strict-mode 503 message.
    let skippedByState = false;

    // sequenceIndex — check against the fixture's match count
    if (match.sequenceIndex !== undefined && matchCounts !== undefined) {
      const count = matchCounts.get(fixture) ?? 0;
      if (count !== match.sequenceIndex) skippedByState = true;
    }

    if (!skippedByState && match.turnIndex !== undefined) {
      const assistantCount = effective.messages.filter((m) => m.role === "assistant").length;
      if (assistantCount !== match.turnIndex) skippedByState = true;
    }

    if (skippedByState) {
      skippedBySequenceOrTurn++;
      continue;
    }

    return { fixture, skippedBySequenceOrTurn };
  }

  return { fixture: null, skippedBySequenceOrTurn };
}

/**
 * Match a fixture against a request, returning the fixture or `null`. Thin
 * wrapper over {@link matchFixtureDiagnostic} that discards the skip diagnostic
 * — preserves the historical signature for all existing callers.
 */
export function matchFixture(
  fixtures: Fixture[],
  req: ChatCompletionRequest,
  matchCounts?: Map<Fixture, number>,
  requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest,
): Fixture | null {
  return matchFixtureDiagnostic(fixtures, req, matchCounts, requestTransform).fixture;
}
