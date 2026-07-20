import type {
  ChatCompletionRequest,
  ChatMessage,
  ContentPart,
  Fixture,
  FixtureMatch,
} from "./types.js";
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
 * request; this joins SEPARATE system messages with newlines so a substring
 * matcher sees the whole context as one body.
 *
 * Empty handling is symmetric with {@link getTextContent}: a system message
 * with no extractable text (`null`) contributes nothing, while a message that
 * extracts to an empty string is a present-but-empty body. We skip only the
 * `null` (no-text) case so a genuinely empty system message does not inject a
 * stray newline; this matches getTextContent treating "no text" and "empty
 * text" consistently.
 */
export function getSystemText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") continue;
    const text = getTextContent(m.content);
    if (text === null) continue;
    parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Extract the text content from a message's content field.
 * Handles both plain string content and array-of-parts content
 * (e.g. `[{type: "text", text: "..."}]` as sent by some SDKs).
 *
 * Multi-part text is joined with `""` (the parts form one logical body split
 * across segments). Empty handling is symmetric with the string path: a string
 * `""` returns `""`, and an array containing at least one text part whose
 * combined text is empty likewise returns `""` (NOT `null`). `null` is reserved
 * for "no text content at all" — null content, or an array with no text parts —
 * so callers can distinguish "absent" from "present but empty" the same way for
 * both content shapes.
 */
export function getTextContent(content: string | ContentPart[] | null): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);
    return texts.length > 0 ? texts.join("") : null;
  }
  return null;
}

/**
 * Text of the last user message, for `userMessage` fixture matching. Normally
 * this is the text of the final `user` message. But some SDKs serialise a
 * single multimodal user turn (prompt text + attachment) into TWO consecutive
 * user messages — a text-only one FOLLOWED by an attachment-only one, e.g.
 * `[{role:"user", content:"describe this"}, {role:"user", content:[{type:"image_url",...}]}]`
 * (observed with Microsoft Agent Framework's `agent_framework_openai` image
 * path). The trailing attachment-only message has NO extractable text, so the
 * naive "last user message" lookup returns `null` and — because no fixture can
 * key on empty text — every such multimodal fixture misses. We therefore skip
 * trailing user messages that carry no text and use the nearest preceding user
 * message that does. This is deliberately narrow: it only skips text-LESS
 * (`null`) user messages — a message whose text extracts to an explicit empty
 * string `""` is a present-but-empty body and IS returned (so a fixture can key
 * on it), while a genuine multi-message user turn (each message HAS text) is
 * unaffected and still matched on its final message. Returns the nearest
 * preceding user message whose text is non-null (including `""`); returns `null`
 * only when no user message carries any text part at all.
 */
export function getLastUserText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = getTextContent(messages[i].content);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Test a matcher RegExp against a string WITHOUT mutating the caller-supplied
 * regex. `RegExp.prototype.test` advances `lastIndex` as a side effect on
 * `/g` and `/y` regexes; fixtures hold caller-owned RegExp objects, so testing
 * them in place would clobber the caller's positional state (and a `/g` regex
 * reused across match calls would match intermittently). We test a fresh clone
 * (same source + flags) so the caller's object is never touched and every test
 * starts from index 0.
 */
function regexTest(re: RegExp, text: string): boolean {
  return new RegExp(re.source, re.flags).test(text);
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
  /**
   * `true` when the served fixture was selected by relaxed content-anchored
   * matching even though its `turnIndex` is defined and does NOT equal the
   * request's assistant-message count — i.e. the legacy strict turnIndex gate
   * (now opt-in via `AIMOCK_STRICT_TURN_INDEX`) WOULD HAVE rejected it. Absent /
   * falsy on canonical-position matches, non-turnIndexed matches, and misses.
   * Additive optional field — existing handler destructures are unaffected.
   */
  turnIndexRelaxed?: boolean;
  /**
   * How the served fixture was selected: `"turnIndex"` when its `turnIndex`
   * sits exactly at the current assistant count (canonical position),
   * `"content"` otherwise (a non-turnIndexed match or a relaxed off-by-N
   * match). Absent on misses. Additive optional field.
   */
  matchedBy?: "content" | "turnIndex";
}

/**
 * Optional matcher tuning.
 *
 * `strictTurnIndex` restores the legacy behaviour where `turnIndex` must equal
 * the request's assistant-message count exactly (a hard reject gate). It is set
 * by the record path, where a miss proxies upstream to capture a fresh turn; an
 * earlier-turn fixture must not shadow a longer request or the new turn would
 * never be recorded. Replay (the default, `false`) treats `turnIndex` as a
 * non-fatal disambiguator instead — see {@link selectByTurnIndex}.
 */
export interface MatchOptions {
  strictTurnIndex?: boolean;
  /**
   * Optional sink for the one-shot relaxed-turnIndex divergence warning. Handlers
   * pass their `defaults.logger`; the structural `{ warn }` shape avoids an
   * import cycle with logger.ts and keeps the matcher decoupled. When omitted no
   * warning is emitted (the diagnostic fields are still populated). The Logger's
   * own level gate keeps a passing programmatic run (silent default) quiet.
   */
  logger?: { warn(...args: unknown[]): void };
}

/**
 * Process-level opt-out: when `AIMOCK_STRICT_TURN_INDEX=1` (or `true`) is set,
 * REPLAY selection restores the legacy hard turnIndex gate — a content-matching
 * fixture whose `turnIndex` is defined and `!== assistantCount` is rejected,
 * reproducing origin/main semantics. Follows the `AIMOCK_ALLOW_PRIVATE_URLS`
 * precedent for parsing/precedence. Read per-call (not cached) so tests can flip
 * it. Does NOT affect the record path, which is already strict regardless.
 */
function strictTurnIndexEnv(): boolean {
  const v = process.env.AIMOCK_STRICT_TURN_INDEX;
  return v === "1" || v === "true";
}

/**
 * Process-level set of fixtures for which the relaxed-turnIndex divergence
 * warning has already fired, so each divergent fixture warns at most ONCE per
 * process (throttle). Keyed by the selected fixture's OBJECT IDENTITY: the
 * `Fixture` references in the server's fixtures array are stable across replays
 * (the array is held by reference and only fully replaced on a fixtures reset),
 * so identity uniquely distinguishes divergent fixtures and warns each exactly
 * once. A `WeakSet` was chosen over the previous `JSON.stringify(match)` key for
 * two reasons: (1) stringifying the match DROPS `predicate` functions and
 * serialises any RegExp matcher to `{}`, so two distinct fixtures differing only
 * by a predicate/regex collided to one key and the second's warning was silently
 * suppressed; and (2) a string `Set` only grows, accumulating an entry per
 * divergent shape on a long-lived server, whereas a `WeakSet` auto-evicts when a
 * fixture object is released (e.g. after a fixtures reset drops the references).
 * `let` because `WeakSet` has no `.clear()`, so the test hook reassigns a fresh
 * one.
 */
let warnedRelaxedFixtures = new WeakSet<Fixture>();

/**
 * Test-only hook to clear the throttle state between cases. Not part of the
 * public contract. `WeakSet` has no `.clear()`, so reassign a fresh instance.
 */
export function _resetTurnIndexRelaxWarnings(): void {
  warnedRelaxedFixtures = new WeakSet<Fixture>();
}

/**
 * Build the {@link MatchOptions} a request handler must pass to
 * {@link matchFixtureDiagnostic} / {@link matchFixture}, derived from whether
 * the handler is about to record on a miss.
 *
 * EVERY record-capable handler (OpenAI chat, Anthropic messages, Responses,
 * Gemini, Bedrock, Bedrock-Converse, Cohere, Ollama, …) must build its match
 * options through THIS helper rather than hand-rolling `{ strictTurnIndex }` at
 * the call site. Recording proxies upstream on a miss to capture a fresh turn;
 * if `strictTurnIndex` is left false during recording, an earlier-turn fixture
 * can content-shadow a longer request, the `if (!fixture)` record branch never
 * fires, and the new turn is SILENTLY never recorded. Funnelling the decision
 * through one helper makes that wiring impossible for a future handler to miss:
 * pass `recording = true` whenever the handler's own record gate is satisfied
 * (i.e. it will call `proxyAndRecord` on a miss), `false` otherwise.
 */
export function recordMatchOptions(
  recording: boolean,
  logger?: { warn(...args: unknown[]): void },
): MatchOptions {
  return { strictTurnIndex: recording, logger };
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
  options?: MatchOptions,
): MatchFixtureDiagnostic {
  // Apply transform once before matching — used for stripping dynamic data
  const effective = requestTransform ? requestTransform(req) : req;
  const useExactMatch = !!requestTransform;
  // In record mode the server proxies to the upstream on a miss, so a fixture
  // already captured for an EARLIER turn must NOT shadow a longer (later-turn)
  // request — otherwise the new turn would never be proxied and recorded.
  // There turnIndex stays a strict hard gate. Replay (the default) instead
  // treats turnIndex as a non-fatal disambiguator so a canonical multi-bubble
  // run isn't falsely rejected for an off-by-N assistant count.
  // Strict turnIndex is in force when the record path requests it OR the
  // process-level AIMOCK_STRICT_TURN_INDEX opt-out is set (which restores the
  // legacy hard gate for replay too). Record mode passes `true` explicitly; the
  // env only matters when the caller left it `false`/unset (replay).
  const strictTurnIndex = (options?.strictTurnIndex ?? false) || strictTurnIndexEnv();

  let skippedBySequenceOrTurn = 0;
  // Every fixture whose content / shape predicates (and sequenceIndex gate)
  // pass. turnIndex is applied afterwards as a non-fatal disambiguator.
  const contentMatches: Fixture[] = [];

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
      // Use the last user message that actually carries text — see
      // getLastUserText for why a trailing attachment-only user message
      // (multimodal serialisation split) must not shadow the real prompt.
      const text = getLastUserText(effective.messages);
      // `text === null` means no user message carried any text (e.g. a pure
      // attachment turn) — skip. An explicit empty-string body (`""`) is a
      // present-but-empty user message and must be allowed through so a fixture
      // keyed on empty text can match it (see getLastUserText).
      if (text === null) continue;
      if (typeof match.userMessage === "string") {
        if (useExactMatch) {
          if (text !== match.userMessage) continue;
        } else {
          if (!text.includes(match.userMessage)) continue;
        }
      } else {
        if (!regexTest(match.userMessage, text)) continue;
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
      const sm = match.systemMessage;
      // Empty array is treated as "no constraint" → matches unconditionally,
      // INCLUDING requests with no system text at all. This is the documented
      // contract (same permissive behaviour as not setting systemMessage), so
      // it must be honored BEFORE the no-system-text guard below — otherwise a
      // request without a system message would be wrongly skipped. Validation
      // rejects [] at load time for JSON fixtures; programmatic callers that
      // pass [] get this permissive behaviour.
      if (Array.isArray(sm) && sm.length === 0) {
        // no constraint — fall through to the next predicate
      } else {
        const text = getSystemText(effective.messages);
        // Deliberately `!text` (not `text === null`): unlike userMessage/inputText,
        // getSystemText returns `""` for BOTH "a present but empty system message"
        // AND "no system message at all", so it exposes no absent-vs-empty
        // distinction at the request level. Allowing `""` through would make a
        // `systemMessage: ""` / `/^$/` fixture a catch-all firing on every
        // no-system-message request. There is no shipped-fixture demand for
        // matching an empty system prompt, so we keep the falsy guard here. If a
        // real need arises, add a getSystemText sibling that returns `null` when
        // absent and `""` when present-empty, then switch to `text === null`.
        if (!text) continue;
        if (Array.isArray(sm)) {
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
          if (!regexTest(sm, text)) continue;
        }
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

    // toolResultContains — substring gate on the LAST message's text content
    // when that message is a tool result. Same last-message rule as toolCallId
    // (a tool-result fixture answers the model's next call after a tool round),
    // but discriminates on the result PAYLOAD instead of the call id — needed
    // when approve/cancel resumes share the same toolCallId and differ only
    // inside the tool-result JSON.
    if (match.toolResultContains !== undefined) {
      const last = effective.messages[effective.messages.length - 1];
      if (!last || last.role !== "tool") continue;
      const text = getTextContent(last.content);
      if (text === null || !text.includes(match.toolResultContains)) continue;
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
      // `undefined` means the request carried no embedding input (a non-embedding
      // request) — skip. An explicit empty string (`""`) is a genuinely-empty
      // embedding input and must be allowed through so `inputText: ""` can match.
      if (embeddingInput === undefined) continue;
      if (typeof match.inputText === "string") {
        if (useExactMatch) {
          if (embeddingInput !== match.inputText) continue;
        } else {
          if (!embeddingInput.includes(match.inputText)) continue;
        }
      } else {
        if (!regexTest(match.inputText, embeddingInput)) continue;
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
        if (!regexTest(match.model, effective.model ?? "")) continue;
      }
    }

    // hasToolResult — request-SHAPE predicate: does the CURRENT turn contain a
    // tool result message? "Current turn" = messages after the last user
    // message, so this is scoped to the turn being matched rather than the
    // whole conversation. This is what makes leg-1 (tool call, hasToolResult
    // false) vs leg-2 (narration, hasToolResult true) fixtures keep working
    // across MULTI-TURN sessions: on the 2nd+ user turn the request still
    // carries earlier turns' tool results, and a whole-conversation check would
    // force hasToolResult=true forever, so the turn's leg-1 fixture (false)
    // could never match again ("No fixture matched" on every pill after the
    // first). For a single-turn request this is identical to the old
    // whole-conversation check. Must be evaluated with the other shape
    // predicates ABOVE the sequence/turn state gates so that a fixture whose
    // shape never matched is not miscounted as "skipped by sequence/turn state".
    if (match.hasToolResult !== undefined) {
      let lastUserIdx = -1;
      for (let i = effective.messages.length - 1; i >= 0; i--) {
        if (effective.messages[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const hasTool = effective.messages.slice(lastUserIdx + 1).some((m) => m.role === "tool");
      if (hasTool !== match.hasToolResult) continue;
    }

    // At this point every SHAPE / CONTENT predicate above has passed, so this
    // fixture is a genuine CONTENT match for the request. The sequenceIndex and
    // turnIndex constraints below are POSITION state, not request shape.
    //
    // sequenceIndex remains a hard, stateful gate: it consumes sequenced
    // siblings one call at a time (and an exhausted index intentionally falls
    // through to a later fixture). A fixture that matched the shape but fails
    // ONLY the sequenceIndex gate is a "candidate skipped by sequence/turn
    // state", counted separately so callers can disambiguate the strict-mode
    // 503 message.
    if (match.sequenceIndex !== undefined && matchCounts !== undefined) {
      const count = matchCounts.get(fixture) ?? 0;
      if (count !== match.sequenceIndex) {
        skippedBySequenceOrTurn++;
        continue;
      }
    }

    // turnIndex is normally NOT a hard gate (replay). Multi-step agents emit
    // several assistant bubbles per logical turn, so a canonical run's assistant
    // count routinely differs from a fixture's hardcoded turnIndex even when the
    // request content matches exactly. Rejecting a uniquely content-matching
    // fixture on absolute position produced false "empty assistant response"
    // misses. Instead we collect every content match and use turnIndex only as a
    // non-fatal DISAMBIGUATOR to choose AMONG several content-matching fixtures
    // (see selectByTurnIndex below). Content that does not match any fixture
    // still matches nothing — only the position gate is relaxed.
    //
    // Under strictTurnIndex (record mode) turnIndex stays a hard, exact gate so
    // an earlier-turn capture can't shadow a longer request; the miss then
    // proxies upstream and records the new turn.
    if (strictTurnIndex && match.turnIndex !== undefined) {
      const assistantCount = effective.messages.filter((m) => m.role === "assistant").length;
      if (assistantCount !== match.turnIndex) {
        skippedBySequenceOrTurn++;
        continue;
      }
    }

    contentMatches.push(fixture);
  }

  if (contentMatches.length === 0) {
    return { fixture: null, skippedBySequenceOrTurn };
  }

  const assistantCount = effective.messages.filter((m) => m.role === "assistant").length;
  const { fixture: selected, byUniquePosition } = selectByTurnIndex(contentMatches, assistantCount);

  // Divergence predicate: the served fixture carries a turnIndex that does NOT
  // sit at the current assistant position. Under strict matching this fixture
  // would have been rejected at the gate above, so serving it here is the (rare,
  // off-by-N) relaxed behaviour change PR #276 introduced. Computed from values
  // already in hand — no second matching pass.
  const selectedTurn = selected.match.turnIndex;
  const turnIndexRelaxed = selectedTurn !== undefined && selectedTurn !== assistantCount;
  // `matchedBy` reports "turnIndex" ONLY when the selection was genuinely decided
  // by a UNIQUE positional criterion (a single candidate whose turnIndex sits
  // exactly at the current assistant count). A canonical-position fixture that
  // tied with another at-position candidate, or that lost the exact-turn
  // tie-break to an earlier fallback, was decided by REGISTRATION ORDER, not by
  // position — those are "content". `selectByTurnIndex` reports which it was.
  const matchedBy: "content" | "turnIndex" = byUniquePosition ? "turnIndex" : "content";

  if (turnIndexRelaxed && options?.logger) {
    // Throttle: warn at most once per divergent fixture per process. Keyed by
    // the fixture's OBJECT IDENTITY so distinct fixtures whose match serialises
    // identically (predicate/regex collisions) each warn, and entries auto-evict
    // when the fixture is released (see warnedRelaxedFixtures above).
    if (!warnedRelaxedFixtures.has(selected)) {
      warnedRelaxedFixtures.add(selected);
      // Human-readable description for the message only (NOT the throttle key,
      // which is the fixture's object identity). `JSON.stringify(match)` is
      // unfit here: it DROPS `predicate` functions entirely and collapses any
      // RegExp matcher to `{}`, so a predicate/regex fixture's warning read
      // "served fixture {}" / "{"userMessage":{}}". `describeMatch` instead
      // summarizes the present matcher KEYS (annotating predicate/regex values)
      // so the warned fixture is identifiable.
      const idx = fixtures.indexOf(selected);
      const desc = describeMatch(selected.match, idx);
      options.logger.warn(
        `turnIndex relaxed: served fixture ${desc} at assistantCount=${assistantCount} ` +
          `(scripted turnIndex=${selectedTurn}); set AIMOCK_STRICT_TURN_INDEX=1 to restore strict matching`,
      );
    }
  }

  return { fixture: selected, skippedBySequenceOrTurn, turnIndexRelaxed, matchedBy };
}

/**
 * Build a stable, human-readable identifier for a fixture's match shape for the
 * relaxed-turnIndex warning. The previous `JSON.stringify(match)` was unfit: it
 * DROPS `predicate` functions (non-serialisable) and serialises any RegExp
 * matcher to `{}`, so a predicate- or regex-gated fixture's warning collapsed to
 * an uninformative "served fixture {}" / `{"userMessage":{}}` blob.
 *
 * Instead we list the PRESENT matcher keys in declaration order, annotating each
 * by VALUE KIND so predicates and regexes survive: `predicate(fn)`,
 * `userMessage(regex)`, `userMessage("hello")`, `turnIndex=0`, etc. The
 * fixture's array `index` (when known, i.e. `>= 0`) is prefixed as the stable
 * positional identifier — the `Fixture` type carries no `id`/`name`, so its
 * registration index is the only stable handle. String/number values are shown
 * inline (truncated) so a content match remains recognisable; the whole string
 * is capped to keep the log line bounded.
 */
function describeMatch(match: FixtureMatch, index: number): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(match)) {
    if (value === undefined) continue;
    if (typeof value === "function") {
      parts.push(`${key}(fn)`);
    } else if (value instanceof RegExp) {
      parts.push(`${key}(${value})`);
    } else if (typeof value === "string") {
      const v = value.length > 40 ? `${value.slice(0, 40)}…` : value;
      parts.push(`${key}(${JSON.stringify(v)})`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}(${value.length} item${value.length === 1 ? "" : "s"})`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  const keys = parts.length > 0 ? parts.join(", ") : "no matchers";
  const prefix = index >= 0 ? `#${index} ` : "";
  return `${prefix}{ ${keys} }`.slice(0, 160);
}

/**
 * Choose one fixture from a set that all CONTENT-matched the same request,
 * using `turnIndex` purely as a position disambiguator (never as a reject
 * gate).
 *
 * The selection rule is applied UNIFORMLY regardless of candidate count (a
 * single candidate is NOT special-cased), so the same request never flips its
 * answer just because an unrelated content-matching fixture was registered.
 * Within every tier ties are broken by REGISTRATION ORDER — the
 * earliest-registered eligible candidate wins — preserving the historical
 * greedy "first matching fixture wins" contract.
 *
 *  1. Prefer the turnIndexed candidate whose `turnIndex` is closest to
 *     `assistantCount` WITHOUT exceeding it (the highest `turnIndex <=
 *     assistantCount`). A behind-the-count scripted turn (turnIndex <
 *     assistantCount) beats a plain fallback — an explicit position is a
 *     stronger signal than an unpositioned default. A negative `turnIndex` such
 *     as -1 is a valid at/behind position (the seed is `-Infinity`, never a `-1`
 *     sentinel that would mis-skip it). Earlier registration breaks ties among
 *     equal turnIndexes.
 *  2. EXACT-turn tie-break: when the best at/behind scripted turn sits at the
 *     EXACT current position (`turnIndex === assistantCount`) a plain fallback
 *     also answers "right now", so the two are equally eligible and REGISTRATION
 *     ORDER decides — a later-registered `turnIndex:0` does NOT override an
 *     earlier-registered fallback, and vice-versa.
 *  3. Otherwise every turnIndexed candidate is still AHEAD of the conversation.
 *     An explicit future turn must NOT answer an earlier point, so a plain
 *     fallback (eligible at every position) is the better answer — applied
 *     uniformly, INCLUDING when the fallback is the sole partner of a single
 *     future-turn fixture (the single/multi asymmetry this fixes).
 *  4. Otherwise (pure script, every candidate turnIndexed and all ahead) the
 *     script genuinely has no earlier answer, so serve the lowest `turnIndex`
 *     candidate — the false-red-kill for a lone scripted turn whose run has
 *     FEWER assistant bubbles than its `turnIndex`; registration order breaks
 *     ties.
 *
 * A future-turn fixture therefore NEVER answers an earlier-point request when an
 * eligible alternative (a fallback, or an at/behind scripted turn) exists — the
 * future-turn guard is enforced uniformly for single and multiple candidates.
 *
 * Returns the selected fixture alongside `byUniquePosition`: `true` ONLY when the
 * choice was decided by a UNIQUE positional criterion — the served fixture's
 * `turnIndex` sits EXACTLY at `assistantCount`, no earlier fallback overrode it
 * (tier 2), and no other candidate shared that exact position (so registration
 * order did not break a tie). `matchFixtureDiagnostic` maps this to
 * `matchedBy === "turnIndex"`; every other selection path (tie-break,
 * registration order, behind/ahead scripted turn, fallback) is `"content"`.
 */
function selectByTurnIndex(
  candidates: Fixture[],
  assistantCount: number,
): { fixture: Fixture; byUniquePosition: boolean } {
  // The first non-turnIndexed candidate is the registration-order-first plain
  // fallback (eligible at every position). Tracked by index so the exact-turn
  // tie-break can compare registration order against the chosen scripted turn.
  const fallbackIdx = candidates.findIndex((f) => f.match.turnIndex === undefined);

  // Tier 1: closest scripted turn at/before the current count. Strict `>`
  // preserves registration order on equal turnIndexes; `-Infinity` seed so a
  // negative turnIndex is a legitimate at/behind candidate, not a sentinel skip.
  let bestIdx = -1;
  let bestTurn = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i].match.turnIndex;
    if (t === undefined) continue;
    if (t <= assistantCount && t > bestTurn) {
      bestIdx = i;
      bestTurn = t;
    }
  }

  if (bestIdx !== -1) {
    // Tier 2: exact-turn tie with a fallback → earlier registration wins. A
    // fallback won the tie, so position did NOT uniquely decide → content.
    if (bestTurn === assistantCount && fallbackIdx !== -1 && fallbackIdx < bestIdx) {
      return { fixture: candidates[fallbackIdx], byUniquePosition: false };
    }
    // A UNIQUE positional decision requires the chosen turn to sit EXACTLY at
    // the current count AND to be the only candidate at that exact position —
    // otherwise registration order, not position, broke the tie.
    const atExactPosition =
      bestTurn === assistantCount &&
      candidates.filter((f) => f.match.turnIndex === assistantCount).length === 1;
    return { fixture: candidates[bestIdx], byUniquePosition: atExactPosition };
  }

  // Tier 3: every scripted turn is ahead. A plain fallback answers this earlier
  // point; first-registered fallback wins.
  if (fallbackIdx !== -1) return { fixture: candidates[fallbackIdx], byUniquePosition: false };

  // Tier 4: pure script, all turnIndexed and all ahead. Serve the lowest
  // scripted turn; registration order breaks ties (first of the lowest wins).
  let lowest = candidates[0];
  for (const f of candidates) {
    if ((f.match.turnIndex as number) < (lowest.match.turnIndex as number)) lowest = f;
  }
  return { fixture: lowest, byUniquePosition: false };
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
  options?: MatchOptions,
): Fixture | null {
  return matchFixtureDiagnostic(fixtures, req, matchCounts, requestTransform, options).fixture;
}
