/**
 * OpenAI harmony channel parsing for open-weight gpt-oss models.
 *
 * Hosted api.openai.com pre-parses harmony output into structured
 * `tool_calls` / `message.content`, but open-weight gpt-oss models served via
 * Ollama / vLLM / OpenRouter (i.e. whenever OPENAI_BASE_URL points at a
 * local/open-weights backend) stream tool calls as RAW harmony channel tokens
 * INSIDE `delta.content`. Without parsing, the recorded fixture leaks the
 * tool-call routing marker (`to=functions.NAME`) and its args JSON as plain
 * text content instead of capturing a structured tool call.
 *
 * Harmony grammar (authoritative, from OpenAI's harmony spec):
 *   Special tokens: <|start|> <|end|> <|message|> <|channel|> <|constrain|>
 *                   <|return|> <|call|>
 *   A message is laid out as:
 *     <|start|>{role/recipient header}<|channel|>{channel header}<|message|>{body}{terminator}
 *   where the leading <|start|> and/or <|channel|> may be absent on the very
 *   first message of a stream, and the channel header carries the channel name
 *   plus optional `to=functions.NAME` routing and `<|constrain|>json`.
 *   Channels:
 *     - analysis    chain-of-thought  -> reasoning
 *     - commentary  function/tool calls + preambles
 *     - final       user-facing answer -> content
 *   A tool call is a `commentary`-channel message whose header (role segment OR
 *   channel header) carries recipient routing `to=functions.NAME`; its args are
 *   the JSON body after `<|message|>`, terminated by `<|call|>`. Example:
 *     <|channel|>analysis<|message|>Need to call the tool.<|end|>
 *     <|start|>assistant<|channel|>commentary to=functions.generate_a2ui
 *       <|constrain|>json<|message|>{"component":"card","props":{}}<|call|>
 *     <|start|>assistant<|channel|>final<|message|>Here you go.<|return|>
 *
 * Implementation: a TWO-PHASE parser, NOT an indexOf scanner.
 *
 *   Phase 1 — LEXER ({@link lex}). One left-to-right pass over the accumulated
 *   content producing an ordered {@link Token}[]: each element is either a
 *   CONTROL token (matched by exact prefix at the cursor) or a TEXT span (the
 *   literal run between control tokens). Once bytes are consumed into a TEXT
 *   span they are NEVER re-scanned for control tokens — so a literal
 *   "<|call|>"/"<|channel|>" substring inside a JSON string or prose can never
 *   be mistaken for structure. The lexer NEVER throws; it always returns a
 *   complete token stream.
 *
 *   Phase 2 — STATE MACHINE ({@link parseTokens}). Walks the token stream
 *   against the harmony grammar:
 *     Stream      := TEXT? Message+ TEXT?
 *     Message     := START? Header? MESSAGE Body Terminator
 *     Header      := role-TEXT? CHANNEL header-TEXT?
 *     Body        := the token span following MESSAGE up to its real Terminator
 *     Terminator  := END | RETURN | CALL | (lookahead START) | EOF (final only)
 *   The Terminator is located over the TOKEN STREAM, never via indexOf: a body
 *   may re-materialize embedded control-token literals as prose (e.g. a final
 *   answer that quotes "`<|end|>`"), so the real terminator is the first
 *   END/RETURN/CALL (or a START that begins a well-formed next message) whose
 *   follower is a real message boundary — EOF or a parseable next header. A
 *   commentary tool body additionally requires Terminator==CALL AND a body that
 *   parses as JSON; the "first CALL whose preceding TEXT parses as valid JSON,
 *   else fail-safe" rule is preserved but operates over the token stream. A
 *   CHANNEL header must name a known channel (analysis/commentary/final) and a
 *   dangling CHANNEL/MESSAGE inside a body is a grammar deviation (fail-safe).
 *
 * Fail-safe contract: parsing is UNIFORM all-or-nothing. {@link
 * parseHarmonyContent} returns `failed:true` with `content` set to the ORIGINAL
 * raw input VERBATIM on ANY grammar deviation (TEXT-only / prose mention with
 * no Message, CHANNEL with no following MESSAGE, a tool body that is not valid
 * JSON or not CALL-terminated, an unterminated non-final body, a body
 * terminator followed by trailing non-message junk, or any leftover unexpected
 * token). There is EXACTLY ONE success path that strips tokens; it never
 * partial-strips and never leaks a control token into content/reasoning.
 * Harmony-present-but-unparseable is NOT transport loss — the caller preserves
 * the bytes verbatim and surfaces a distinct `harmonyUnparsed` signal rather
 * than `droppedChunks`/`truncated`.
 *
 * KNOWN LIMITATION — quoted whole-message ambiguity. Harmony tokens arrive as
 * detokenized TEXT, so a body that QUOTES a COMPLETE, well-formed harmony
 * message is structurally indistinguishable from two real messages. Example:
 *   <|channel|>final<|message|>To emit write <|start|>assistant<|channel|>
 *     final<|message|>hello<|return|>
 * The lexer cannot know the inner `<|start|>...<|message|>hello<|return|>` is a
 * quotation rather than a real second message, so this parses as TWO final
 * messages and the quoted control tokens are stripped (content "To emit write
 * hello"). This is the irreducible quoted-vs-real ambiguity; the parser does
 * NOT over-engineer a guess. The fail-safe contract still holds at its edges:
 * the split is only accepted when it yields cleanly well-formed messages — if
 * any resulting message is malformed (e.g. the quoted message is followed by
 * trailing junk, "...hello<|return|> and then stop"), the body terminator /
 * trailing-junk rule fails the WHOLE input safe (verbatim) rather than emit a
 * mangled middle. So the behavior is always verbatim-or-clean, never mangled.
 */

import type { ToolCall } from "./types.js";

// Harmony special tokens.
const START_TOKEN = "<|start|>";
const END_TOKEN = "<|end|>";
const RETURN_TOKEN = "<|return|>";
const CALL_TOKEN = "<|call|>";
const CHANNEL_TOKEN = "<|channel|>";
const MESSAGE_TOKEN = "<|message|>";
const CONSTRAIN_TOKEN = "<|constrain|>";

/** The seven harmony control-token kinds. */
type ControlType = "START" | "END" | "RETURN" | "CALL" | "CHANNEL" | "MESSAGE" | "CONSTRAIN";

// Control tokens ordered for prefix matching at the cursor. All seven literals
// are distinct prefixes, so match order is irrelevant for correctness; the
// array simply drives the single cursor scan in the lexer.
const CONTROL_TOKENS: ReadonlyArray<{ type: ControlType; literal: string }> = [
  { type: "START", literal: START_TOKEN },
  { type: "END", literal: END_TOKEN },
  { type: "RETURN", literal: RETURN_TOKEN },
  { type: "CALL", literal: CALL_TOKEN },
  { type: "CHANNEL", literal: CHANNEL_TOKEN },
  { type: "MESSAGE", literal: MESSAGE_TOKEN },
  { type: "CONSTRAIN", literal: CONSTRAIN_TOKEN },
];

// Reverse map: control-token kind -> its literal. Used by the state machine to
// re-materialize a control token's literal text when reconstructing a JSON
// tool-call body that legitimately contains "<|call|>"-shaped substrings.
const CONTROL_LITERAL: Record<ControlType, string> = {
  START: START_TOKEN,
  END: END_TOKEN,
  RETURN: RETURN_TOKEN,
  CALL: CALL_TOKEN,
  CHANNEL: CHANNEL_TOKEN,
  MESSAGE: MESSAGE_TOKEN,
  CONSTRAIN: CONSTRAIN_TOKEN,
};

// Recipient routing marker carried by the role segment or the channel header.
// Requires a valid identifier after `to=functions.` — must START with a letter
// or underscore (so `to=functions.-` / `to=functions.` are NOT recipients),
// then allow word chars, dots, and dashes.
const RECIPIENT_RE = /to=functions\.([A-Za-z_][\w.-]*)/;

/**
 * Cheap detection guard — only ATTEMPT a parse when a harmony structure looks
 * present, i.e. a `<|channel|>` followed (anywhere after it) by a `<|message|>`,
 * OR a `<|message|>` appearing after a `<|start|>`.
 *
 * This is a fast-path gate, NOT the authority on well-formedness: the state
 * machine in {@link parseHarmonyContent} makes the real decision and is itself
 * fully fail-safe. Requiring the token pairing keeps hosted/structured answers
 * that merely MENTION a single token as prose out of the parser entirely.
 */
export function isHarmonyContent(content: string): boolean {
  const channelIdx = content.indexOf(CHANNEL_TOKEN);
  if (channelIdx !== -1) {
    if (content.indexOf(MESSAGE_TOKEN, channelIdx + CHANNEL_TOKEN.length) !== -1) {
      return true;
    }
  }
  const startIdx = content.indexOf(START_TOKEN);
  if (startIdx !== -1) {
    if (content.indexOf(MESSAGE_TOKEN, startIdx + START_TOKEN.length) !== -1) {
      return true;
    }
  }
  return false;
}

export interface HarmonyParseResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  /**
   * True when the input could NOT be parsed as a complete, valid harmony
   * structure and the ORIGINAL content was returned VERBATIM (fail-safe). The
   * bytes are preserved, so this is NOT transport loss — the caller surfaces it
   * via a distinct `harmonyUnparsed` signal, not `droppedChunks`/`truncated`.
   */
  failed: boolean;
}

// ---------------------------------------------------------------------------
// Phase 1: Lexer
// ---------------------------------------------------------------------------

/** A control token (one of the seven harmony special tokens). */
interface ControlToken {
  kind: "control";
  type: ControlType;
}

/** A literal text span between control tokens. Never empty. */
interface TextToken {
  kind: "text";
  value: string;
}

type Token = ControlToken | TextToken;

/**
 * Lex the accumulated content into an ordered token stream via a single
 * left-to-right cursor walk. At each position, match a control token by exact
 * prefix; otherwise accumulate bytes into the current TEXT run until the next
 * control token or EOF.
 *
 * Bytes consumed into a TEXT span are NEVER re-scanned for control tokens, so
 * an embedded literal "<|call|>"/"<|channel|>" inside a JSON string or prose is
 * inert. The lexer NEVER throws; it always returns a complete token stream.
 */
function lex(raw: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  let textStart = 0;

  const flushText = (end: number): void => {
    if (end > textStart) {
      tokens.push({ kind: "text", value: raw.slice(textStart, end) });
    }
  };

  while (cursor < raw.length) {
    let matched: { type: ControlType; literal: string } | undefined;
    // A control token only begins at "<|"; cheap reject avoids scanning the
    // literal list on every plain character.
    if (raw.startsWith("<|", cursor)) {
      for (const tok of CONTROL_TOKENS) {
        if (raw.startsWith(tok.literal, cursor)) {
          matched = tok;
          break;
        }
      }
    }
    if (matched) {
      flushText(cursor);
      tokens.push({ kind: "control", type: matched.type });
      cursor += matched.literal.length;
      textStart = cursor;
    } else {
      cursor += 1;
    }
  }
  flushText(raw.length);

  return tokens;
}

// ---------------------------------------------------------------------------
// Phase 2: State machine
// ---------------------------------------------------------------------------

/** True when `s` is empty or only whitespace. */
function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

/**
 * True when `s` parses as a JSON OBJECT — a non-null, non-array `{...}` value.
 *
 * Harmony tool-call arguments are JSON OBJECTS. A bare JSON SCALAR (number /
 * boolean / string / null) or ARRAY parses as valid JSON but is NOT a valid
 * tool-call argument, so it must not terminate a tool call (fail-safe verbatim
 * per the uniform contract). The object check (and ONLY the object check) is
 * what makes a commentary `<|call|>` body a tool call; embedded token-shaped
 * substrings INSIDE the object's string values remain valid data (matrix 13/14).
 */
function isToolArgsObject(s: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(s);
  } catch {
    return false;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the channel name from the header text that follows `<|channel|>`. The
 * channel name is the leading token, delimited by whitespace (the rest of the
 * header carries optional `to=functions.NAME` routing). A `<|constrain|>` token
 * is lexed separately, so it never appears inside this text.
 */
function headerChannel(headerText: string): string {
  return headerText.trim().split(/\s+/)[0] ?? "";
}

/** The harmony channels a real `<|channel|>` header may name. */
const KNOWN_CHANNELS = new Set(["analysis", "commentary", "final"]);

/**
 * True when token index `idx` begins a well-formed harmony message header —
 * used as lookahead to decide whether a `<|start|>` is a real message boundary
 * (terminating the current body) or a literal `<|start|>` quoted inside a prose
 * body. A real message header reaches a `<|message|>` token via the optional
 * `START? role-TEXT? CHANNEL? header-TEXT? CONSTRAIN? constraint-TEXT?` prefix
 * WITHOUT first crossing a body terminator (END/RETURN/CALL) or EOF.
 *
 * When the lookahead carries a `<|channel|>` header, the channel name it names
 * must be a KNOWN harmony channel (analysis/commentary/final). A lookahead like
 * `<|start|>...<|channel|>X<|message|>` whose X is unknown is NOT a real
 * boundary — it narrows the quoted-message ambiguity so a body quoting a
 * bogus-channel pseudo-message is not split on it. A channel-LESS header
 * (`<|start|>role<|message|>...`) is unaffected (KNOWN_CHANNELS only gates a
 * present `<|channel|>` name).
 */
function looksLikeMessageStart(tokens: Token[], idx: number): boolean {
  let k = idx;
  if (tokens[k]?.kind === "control" && (tokens[k] as ControlToken).type === "START") {
    k += 1;
    if (tokens[k]?.kind === "text") k += 1; // optional role-TEXT
  }
  if (tokens[k]?.kind === "control" && (tokens[k] as ControlToken).type === "CHANNEL") {
    k += 1;
    if (tokens[k]?.kind === "text") {
      // The channel name must be a known harmony channel for this to be a real
      // message boundary; an unknown channel header is not a true boundary.
      if (!KNOWN_CHANNELS.has(headerChannel((tokens[k] as TextToken).value))) return false;
      k += 1; // header-TEXT
    }
    if (tokens[k]?.kind === "control" && (tokens[k] as ControlToken).type === "CONSTRAIN") {
      k += 1;
      if (tokens[k]?.kind === "text") k += 1; // optional constraint-name TEXT
    }
  }
  return tokens[k]?.kind === "control" && (tokens[k] as ControlToken).type === "MESSAGE";
}

/**
 * True when the position right after a body terminator candidate (END/RETURN/
 * CALL at the token before `idx`) is a REAL message boundary: either EOF
 * (optionally preceded by whitespace-only TEXT spans) or the start of a
 * well-formed next message. When false, the terminator candidate is a literal
 * control token embedded in a prose body.
 */
function isRealBoundaryAfter(tokens: Token[], idx: number): boolean {
  let k = idx;
  // Skip whitespace-only TEXT spans (inter-message / trailing whitespace).
  while (tokens[k]?.kind === "text" && (tokens[k] as TextToken).value.trim().length === 0) {
    k += 1;
  }
  if (k >= tokens.length) return true; // EOF (final message)
  return looksLikeMessageStart(tokens, k);
}

/**
 * True when the token at index `idx` is a NON-BLANK TEXT span — i.e. real prose
 * follows. A control-token literal embedded in a non-tool body is only
 * LEGITIMATELY prose when it is bracketed by real text (e.g. a final answer that
 * quotes "the `<|end|>` token"); the lexer will have tokenized the quoted
 * literal, and its immediate follower being non-blank prose is what makes it
 * inert body text rather than structure. When the follower is instead another
 * control token or EOF (or only whitespace), the literal is NOT embedded prose —
 * it is a control token that would leak into routed content/reasoning, so the
 * body must fail safe. This is the STRUCTURAL fail-safe invariant: it fires at
 * absorption time on EVERY exit path, not per-exit, so a leak-shaped body can
 * never reach the routing step regardless of how its loop terminates.
 */
function hasProseFollower(tokens: Token[], idx: number): boolean {
  const next = tokens[idx];
  return next !== undefined && next.kind === "text" && next.value.trim().length > 0;
}

/** Sentinel thrown internally to unwind to the uniform fail-safe path. */
const FAIL = Symbol("harmony-fail");

/**
 * Walk the token stream against the harmony grammar and route each message by
 * channel. Throws {@link FAIL} on ANY grammar deviation so {@link
 * parseHarmonyContent} returns the original bytes verbatim (uniform
 * all-or-nothing fail-safe). On success returns fully-routed channels.
 */
function parseTokens(tokens: Token[]): {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
} {
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];

  let i = 0;
  const peek = (): Token | undefined => tokens[i];
  const fail = (): never => {
    throw FAIL;
  };

  // ----- Leading channel-less TEXT (before the first Message) -----
  // Whitespace-only leading text is absorbed; non-whitespace leading text is
  // channel-less content (a pre-channel preamble).
  if (peek()?.kind === "text") {
    const t = tokens[i] as TextToken;
    // Only treat this as leading content when a real Message header actually
    // follows (START / CHANNEL). A bare MESSAGE is NOT a message header — a
    // legitimate message always opens with START or CHANNEL before MESSAGE — so
    // leading text followed by a bare <|message|> is a grammar deviation, left
    // for the main loop to fail safe (verbatim) rather than glued to the body.
    // Otherwise the text is handled by the trailing / no-message rules below
    // (which fail-safe when no message exists).
    const next = tokens[i + 1];
    const nextStartsMessage =
      next !== undefined &&
      next.kind === "control" &&
      (next.type === "START" || next.type === "CHANNEL");
    if (nextStartsMessage) {
      if (!isBlank(t.value)) content += t.value;
      i += 1;
    }
  }

  // A well-formed stream has at least one Message.
  let sawMessage = false;

  // Set when the PREVIOUS body terminated on a START-lookahead — i.e. a body
  // ran (without an intervening real terminator) into a `<|start|>...` that
  // looks like a message header, so the parser SPLIT it off as a separate
  // message. This is the irreducible quoted-whole-message ambiguity: in
  // detokenized TEXT a body that QUOTES a complete well-formed message is
  // indistinguishable from two real messages. The split is only accepted when
  // BOTH resulting messages are cleanly well-formed (matrix-doc "verbatim-or-
  // clean, never mangled"). A quoted-split message whose OWN body would have to
  // absorb an embedded control literal (e.g. the quoted body
  // "hello<|return|> and then stop") is NOT clean — absorbing it would leak the
  // token into routed content/reasoning — so it fails the WHOLE input safe.
  let nextIsQuotedSplit = false;

  while (i < tokens.length) {
    const tok = peek();
    if (tok === undefined) break;

    // Absorb whitespace-only inter-message / trailing TEXT spans. A non-blank
    // stray TEXT span at message position is a grammar deviation.
    if (tok.kind === "text") {
      if (isBlank(tok.value)) {
        i += 1;
        continue;
      }
      // Non-blank text where a message (or EOF) was expected: this is leftover,
      // unexpected token content — fail safe.
      fail();
    }

    // Capture-and-reset the quoted-split marker for THIS message.
    const fromQuotedSplit = nextIsQuotedSplit;
    nextIsQuotedSplit = false;

    // tok is a control token: the start of a Message.
    let recipient: string | undefined;
    let channel = "";
    // A well-formed message ALWAYS opens with a real header (START and/or
    // CHANNEL) before <|message|>. Track whether such a header was seen so a
    // bare <|message|> at message position (no preceding START/CHANNEL) fails
    // safe instead of being silently accepted as a channel-less message (which
    // would strip control tokens and glue bodies together).
    let sawHeader = false;

    // ----- optional START + role-TEXT -----
    if (tok.kind === "control" && tok.type === "START") {
      sawHeader = true;
      i += 1;
      // Optional role header text carrying `to=functions.NAME`.
      if (peek()?.kind === "text") {
        const roleText = (tokens[i] as TextToken).value;
        recipient = roleText.match(RECIPIENT_RE)?.[1];
        i += 1;
      }
    }

    // ----- optional CHANNEL + header-TEXT (+ optional CONSTRAIN) -----
    if (peek()?.kind === "control" && (peek() as ControlToken).type === "CHANNEL") {
      sawHeader = true;
      i += 1;
      // Optional header text carrying the channel name + optional routing.
      if (peek()?.kind === "text") {
        const headerText = (tokens[i] as TextToken).value;
        channel = headerChannel(headerText);
        const headerRecipient = headerText.match(RECIPIENT_RE)?.[1];
        if (headerRecipient !== undefined) recipient = headerRecipient;
        i += 1;
      }
      // An optional <|constrain|> token (e.g. <|constrain|>json) may sit
      // between the channel header and <|message|>. It carries a constraint
      // hint only — consume it and any following constraint-name text. It does
      // NOT make a body <|call|>-terminated on its own (only a commentary
      // recipient does).
      if (peek()?.kind === "control" && (peek() as ControlToken).type === "CONSTRAIN") {
        i += 1;
        if (peek()?.kind === "text") {
          // e.g. "json" — discard; it is a constraint hint, not body content.
          i += 1;
        }
      }
      // A real <|channel|> header names a KNOWN channel (analysis / commentary
      // / final). If it does not, this is not harmony structure — it is a prose
      // mention of the literal token (e.g. "use `<|channel|>` to pick a
      // channel"). Fail safe so the original bytes are preserved verbatim.
      if (!KNOWN_CHANNELS.has(channel)) fail();
    }

    // ----- mandatory MESSAGE -----
    // A message must be introduced by a real header (START and/or CHANNEL)
    // before <|message|> is consumed. A bare <|message|> at message position
    // — with no preceding START/CHANNEL in this message — is a grammar
    // deviation (not a channel-less message): accepting it would silently strip
    // control tokens and glue bodies together. Fail safe (uniform verbatim),
    // mirroring the bare CHANNEL/MESSAGE-inside-a-non-tool-body rule below.
    if (!sawHeader) fail();
    if (!(peek()?.kind === "control" && (peek() as ControlToken).type === "MESSAGE")) {
      // A header (START and/or CHANNEL) with no following <|message|> is an
      // incomplete message — fail safe.
      fail();
    }
    i += 1; // consume MESSAGE
    const bodyStart = i; // token index of the first body token

    const isCommentaryToolCall = recipient !== undefined && channel === "commentary";

    if (isCommentaryToolCall) {
      // A commentary tool-call body is a JSON value terminated by <|call|>. The
      // literal substring "<|call|>" can legitimately appear INSIDE a JSON
      // string, and the lexer will have tokenized it as a CALL control token.
      // So scan CALL tokens left-to-right, re-materializing the body text from
      // tokens between <|message|> and each CALL, and pick the FIRST CALL whose
      // accumulated preceding text parses as a COMPLETE JSON OBJECT (A2). A bare
      // JSON SCALAR/array (e.g. `123`, `true`, `[1,2]`, `null`) is valid JSON but
      // is NOT a valid tool-call argument, so it does NOT terminate the call.
      // If no CALL closes a valid JSON object, fail safe.
      let acc = "";
      let j = bodyStart;
      let parsed: string | undefined;
      for (; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.kind === "control" && t.type === "CALL") {
          // Canonicalize the captured args: leading/trailing whitespace around
          // the JSON value is not part of the value (e.g. "<|message|> {...} ")
          // — trim it so the recorded arguments are the canonical JSON. Interior
          // whitespace inside the JSON is preserved. JSON.parse already tolerates
          // surrounding whitespace, so validate the TRIMMED form to pick the
          // terminator correctly.
          const candidate = acc.trim();
          if (isToolArgsObject(candidate)) {
            parsed = candidate;
            break;
          }
          // Not a complete JSON object yet (incomplete, or a scalar/array that is
          // not a valid tool-call argument) — the embedded "<|call|>" is part of
          // the JSON string; keep accumulating.
          acc += CONTROL_LITERAL.CALL;
          continue;
        }
        if (t.kind === "control") {
          acc += CONTROL_LITERAL[t.type];
        } else {
          acc += t.value;
        }
      }
      if (parsed === undefined) fail();
      i = j + 1; // consume body tokens + the terminating CALL
      toolCalls.push({ name: recipient!, arguments: parsed! });
      sawMessage = true;
      continue;
    }

    // ----- Non-tool Body + Terminator -----
    // The body runs from MESSAGE to its REAL terminator. A literal control
    // token can legitimately appear in a prose body (e.g. "the `<|end|>`
    // token"), and the lexer will have tokenized it. So scan forward,
    // re-materializing control literals into the body text, and stop at the
    // FIRST END/RETURN/CALL whose follower is a real message boundary — i.e.
    // EOF (optionally preceded by whitespace-only TEXT) or the start of a
    // well-formed next message ({@link looksLikeMessageStart}). A bare START
    // that begins a parseable message is also a (lookahead) terminator.
    //
    // STRUCTURAL FAIL-SAFE INVARIANT. A control-token literal may only be
    // ABSORBED into a routed (content/reasoning) body when it is genuinely
    // embedded prose — i.e. its immediate follower is real text ({@link
    // hasProseFollower}), as in a final answer quoting "the `<|end|>` token"
    // (matrix 10-12). When an embedded terminator-shaped literal (END/RETURN/
    // CALL), a non-boundary START, or a stray CONSTRAIN is followed by another
    // control token or by EOF (i.e. NOT bracketed by prose), it is not embedded
    // prose — it is a control token that would LEAK into routed output. Rather
    // than a per-exit guard (which the old code only applied on the EOF exit,
    // leaking on the `terminated` exit), the check fires HERE, at absorption
    // time, so a leak-shaped body fails safe uniformly no matter how its loop
    // ends. This single invariant subsumes the terminated-exit leak
    // (`A<|return|><|return|>`), the trailing `<|start|>` absorption leak
    // (`answer <|start|>`), and the stray-CONSTRAIN re-materialization. Tool
    // (commentary+recipient) bodies are handled separately above and are NOT
    // subject to this rule (embedded tokens inside a JSON string arg are valid
    // data validated by JSON.parse). `absorbedControlLiteral` records that a
    // literal was legitimately absorbed mid-prose so the EOF branch can reject a
    // body that runs past such a token straight to EOF with no real terminator.
    let body = "";
    let terminated = false;
    let reachedEof = false;
    let absorbedControlLiteral = false;
    let j = i;
    for (; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.kind === "control" && (t.type === "END" || t.type === "RETURN" || t.type === "CALL")) {
        if (isRealBoundaryAfter(tokens, j + 1)) {
          terminated = true;
          break;
        }
        // Embedded terminator-shaped literal. It is inert body prose ONLY when
        // bracketed by real text AND this message is not itself a quoted split
        // (a quoted-split body that must absorb a literal is not clean — it
        // would leak the token); otherwise fail safe.
        if (fromQuotedSplit || !hasProseFollower(tokens, j + 1)) fail();
        absorbedControlLiteral = true;
        body += CONTROL_LITERAL[t.type];
        continue;
      }
      if (t.kind === "control" && t.type === "START") {
        if (looksLikeMessageStart(tokens, j)) {
          // Lookahead terminator: the NEXT message begins here. Do NOT consume.
          // The next message is a quoted-message split (see nextIsQuotedSplit).
          terminated = true;
          break;
        }
        // Embedded <|start|> inside prose — inert body text ONLY when bracketed
        // by real text and not a quoted split; a START with no prose after it
        // (e.g. trailing "answer <|start|>" or "<|start|>" before another
        // control token) would leak — fail safe.
        if (fromQuotedSplit || !hasProseFollower(tokens, j + 1)) fail();
        absorbedControlLiteral = true;
        body += CONTROL_LITERAL.START;
        continue;
      }
      if (t.kind === "control" && (t.type === "CHANNEL" || t.type === "MESSAGE")) {
        // A bare CHANNEL / MESSAGE inside a non-tool body is structural, not
        // prose: in a well-formed stream the next message's CHANNEL is always
        // introduced by a START (caught above as a real boundary), so a
        // dangling CHANNEL/MESSAGE here means the structure is malformed (e.g.
        // "<|message|>body<|channel|>analysis"). Fail safe.
        fail();
      }
      if (t.kind === "control") {
        // A stray CONSTRAIN inside a body is an inert hint, but its literal
        // would leak unless it is bracketed by prose (and not a quoted split) —
        // fail safe otherwise.
        if (fromQuotedSplit || !hasProseFollower(tokens, j + 1)) fail();
        absorbedControlLiteral = true;
        body += CONTROL_LITERAL[t.type];
        continue;
      }
      // TEXT span — part of the body.
      body += t.value;
    }
    if (j >= tokens.length) reachedEof = true;

    if (terminated) {
      const term = tokens[j] as ControlToken;
      if (term.type === "START") {
        // Lookahead: leave START in place for the next loop iteration, and flag
        // that the next message is a quoted-message split (the current body ran
        // into a START without a real terminator of its own).
        i = j;
        nextIsQuotedSplit = true;
      } else {
        i = j + 1; // consume END/RETURN/CALL
      }
      routeBody(channel, body);
      sawMessage = true;
      continue;
    }
    if (reachedEof) {
      // EOF terminates the FINAL message only. A content-routing channel
      // (final / commentary-preamble-without-recipient / channel-less) may
      // legitimately run to EOF with no explicit terminator, so it is accepted
      // verbatim. But:
      //   - An `analysis` body is a terminator-expecting reasoning body
      //     (closed by <|end|>); an UNTERMINATED analysis body at EOF is a
      //     grammar deviation (B-A3) — fail safe rather than surface dangling
      //     reasoning.
      //   - If the body legitimately absorbed a mid-prose control literal and
      //     then ran to EOF, the message was never properly terminated and the
      //     control token would leak into the output (B-A1) — fail safe rather
      //     than mangle.
      if (channel === "analysis" || absorbedControlLiteral) fail();
      i = j;
      routeBody(channel, body);
      sawMessage = true;
      break;
    }
    // Unreachable in practice (loop only exits via terminator or EOF), but keep
    // the uniform fail-safe for any unexpected fallthrough.
    fail();
  }

  if (!sawMessage) fail();

  return { content, reasoning, toolCalls };

  // Route a non-tool body by channel. Only two channel shapes reach this
  // function: `analysis` (-> reasoning) and `final` / commentary-without-
  // recipient (preamble) / channel-less (-> content). An UNKNOWN <|channel|>
  // name never reaches here — it fail-safes upstream at the
  // `if (!KNOWN_CHANNELS.has(channel)) fail()` guard during header parsing — so
  // there is no unknown-channel case to route.
  function routeBody(ch: string, body: string): void {
    if (ch === "analysis") {
      reasoning += body;
    } else {
      // final, commentary-without-recipient (preamble), and channel-less bodies
      // all surface as user-facing content.
      content += body;
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse harmony channel tokens out of an accumulated assistant `content`
 * string, splitting them into final-channel content, analysis-channel
 * reasoning, and commentary-channel tool calls. Pure function — no I/O.
 *
 * Callers should gate this behind {@link isHarmonyContent} so ordinary
 * (already-structured) streams are never touched. Even so, this function is
 * itself UNIFORM all-or-nothing fail-safe: on ANY structural/validation failure
 * it returns `{ content: raw, reasoning: "", toolCalls: [], failed: true }` so
 * the original content is preserved VERBATIM and the caller can surface a
 * distinct `harmonyUnparsed` signal (NOT a dropped/truncated chunk).
 */
export function parseHarmonyContent(raw: string): HarmonyParseResult {
  const tokens = lex(raw);
  try {
    const { content, reasoning, toolCalls } = parseTokens(tokens);
    return { content, reasoning, toolCalls, failed: false };
  } catch (err) {
    if (err === FAIL) {
      return { content: raw, reasoning: "", toolCalls: [], failed: true };
    }
    // Unexpected error — still fail safe rather than throw to the caller.
    return { content: raw, reasoning: "", toolCalls: [], failed: true };
  }
}
