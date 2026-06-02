import { describe, it, expect } from "vitest";
import { parseHarmonyContent } from "../harmony.js";
import { collapseOpenAISSE } from "../stream-collapse.js";

// ===========================================================================
// Harmony body fail-safe — STRUCTURAL (not per-token/per-exit) regressions.
//
// A 7-agent review found the per-branch guard (`absorbedTerminatorLiteral`,
// checked only on the EOF exit) leaked control tokens on OTHER exit paths. The
// fix makes the non-tool-body fail-safe STRUCTURAL: a terminator-shaped literal
// (END/RETURN/CALL) or a START/CONSTRAIN may only be absorbed as embedded prose
// when its immediate follower is real prose text; a literal immediately
// followed by another control token or by EOF is NOT legitimately embedded and
// fails the WHOLE input safe (verbatim + harmonyUnparsed). This pins the
// verified-bad leak shapes the review found, and proves legitimate harmony
// (including bodies that quote tokens as prose, multi-message streams, and tool
// calls with whitespace-padded args) still parses.
//
// SSE-body idiom mirrors stream-collapse.test.ts:
//   data: ${JSON.stringify({ choices: [{ delta: { content: "..." } }] })}
// joined by "\n".
// ===========================================================================

/** Build an OpenAI SSE body whose content chunks carry harmony tokens. */
function openAIHarmonyBody(chunks: string[], id = "chatcmpl-hb"): string {
  return [
    ...chunks.flatMap((content) => [
      `data: ${JSON.stringify({ id, choices: [{ delta: { content } }] })}`,
      "",
    ]),
    "data: [DONE]",
    "",
  ].join("\n");
}

describe("harmony body fail-safe — structural (no control-token literal reaches routed output)", () => {
  // RED 1: a final body terminated by <|return|> immediately followed by a
  // SECOND <|return|> (then EOF). The first <|return|> is a terminator-shaped
  // literal whose follower is a control token (not prose) — NOT legitimately
  // embedded. The OLD code absorbed it and routed "A<|return|>" to content via
  // the `terminated` exit. Correct: uniform fail-safe (verbatim + signal).
  it("RED1: final<|message|>A<|return|><|return|> fails safe (no <|return|> leak via terminated exit)", () => {
    const raw = "<|channel|>final<|message|>A<|return|><|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    // On failure the ORIGINAL bytes are preserved verbatim (the tokens are NOT
    // stripped) — the no-leak guarantee is that a token never reaches a
    // SUCCESSFUL routed body. Here the OLD code routed "A<|return|>"; now it
    // fails safe, so nothing is routed at all.
    expect(direct.content).toBe(raw);
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);

    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  // RED 2: an analysis body terminated by <|end|> immediately followed by a
  // SECOND <|end|> (then EOF). The OLD code absorbed the first <|end|> and
  // routed "A<|end|>" to reasoning via the `terminated` exit (the EOF-only
  // guard never fired because the loop exited via `terminated`). Correct:
  // uniform fail-safe — no <|end|> may reach reasoning.
  it("RED2: analysis<|message|>A<|end|><|end|> fails safe (no <|end|> leak into reasoning)", () => {
    const raw = "<|channel|>analysis<|message|>A<|end|><|end|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.reasoning).toBe("");
    expect(direct.reasoning).not.toContain("<|end|>");
    expect(direct.toolCalls).toEqual([]);
  });

  // RED 3: a final body whose trailing text absorbs a <|start|> that runs
  // straight to EOF (no following message, no terminator). The OLD code did not
  // track START absorption, so "answer <|start|>" leaked into content via the
  // EOF exit. Correct: a START absorbed with no real boundary after it fails.
  it("RED3: final<|message|>answer <|start|> fails safe (absorbed <|start|> at EOF does not leak)", () => {
    const raw = "<|channel|>final<|message|>answer <|start|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    // Verbatim on failure (nothing routed); the OLD code leaked "answer <|start|>".
    expect(direct.content).toBe(raw);
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);

    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.harmonyUnparsed).toBe(true);
  });

  // A terminator-shaped literal immediately followed by EOF (no second token)
  // is also not legitimately embedded.
  it("RED1b: final<|message|>A<|return|> followed only by a control token fails safe", () => {
    // <|return|> then <|call|> then EOF — first terminator's follower is a
    // control token, so it cannot be absorbed as prose.
    const raw = "<|channel|>final<|message|>A<|return|><|call|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    // Verbatim on failure; the embedded <|return|> is never routed to content.
    expect(direct.content).toBe(raw);
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);
  });

  // RED 4: a final body that QUOTES a complete well-formed message which is then
  // followed by trailing prose + a final terminator
  // (`...hello<|return|> and then stop<|return|>`). The OLD code split it into
  // two final messages and routed the quoted body "hello<|return|> and then
  // stop" — MANGLED, leaking <|return|>. The quoted-split message's body must
  // not absorb an embedded control literal, so the WHOLE input fails safe
  // verbatim (never mangled). This is the harmony.ts "verbatim-or-clean, never
  // mangled" contract at the quoted-message edge.
  it("RED4: quoted message + trailing junk + final terminator fails safe (no <|return|> mangle)", () => {
    const raw =
      "<|channel|>final<|message|>To emit write " +
      "<|start|>assistant<|channel|>final<|message|>hello<|return|> and then stop<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.content).not.toBe("To emit write hello<|return|> and then stop");
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);

    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  // GENERIC SAFETY INVARIANT across all four verified-bad inputs: whatever the
  // outcome, the parse must NEVER leak a raw control-token literal — a success
  // carries zero literals in routed output; a failure preserves bytes verbatim.
  it("never leaks a raw control token: clean-or-verbatim across all four RED inputs", () => {
    const inputs = [
      "<|channel|>final<|message|>A<|return|><|return|>",
      "<|channel|>analysis<|message|>A<|end|><|end|>",
      "<|channel|>final<|message|>answer <|start|>",
      "<|channel|>final<|message|>To emit write <|start|>assistant<|channel|>final<|message|>hello<|return|> and then stop<|return|>",
    ];
    for (const raw of inputs) {
      const r = parseHarmonyContent(raw);
      if (!r.failed) {
        // A clean success must carry zero control-token literals in output.
        expect(r.content).not.toMatch(/<\|(start|end|return|call|channel|message|constrain)\|>/);
        expect(r.reasoning).not.toMatch(/<\|(start|end|return|call|channel|message|constrain)\|>/);
      } else {
        // A failure preserves the original bytes verbatim.
        expect(r.content).toBe(raw);
      }
    }
  });
});

describe("harmony bare-<|message|>-at-message-position fail-safe (silent-corruption gap)", () => {
  // A bare <|message|> token at MESSAGE POSITION — with no preceding <|start|>
  // or <|channel|> introducing it — is a grammar deviation, not a channel-less
  // message. The OLD code accepted it, silently stripping control tokens and
  // gluing bodies together. Correct: uniform fail-safe (verbatim +
  // harmonyUnparsed), matching the parser's all-or-nothing contract and the
  // isHarmonyContent gate. A legitimate message ALWAYS has START or CHANNEL
  // before MESSAGE, so these failures cannot touch any valid harmony.

  // BARE-RED 1: a valid final message followed by a SECOND message that begins
  // with a bare <|message|> (no <|start|>/<|channel|>). The OLD code consumed
  // the bare <|message|> as a channel-less message and glued the two bodies
  // -> content "realinjected". Correct: fail safe verbatim.
  it("BARE-RED1: final<|message|>real<|return|><|message|>injected<|return|> fails safe (no body glue)", () => {
    const raw = "<|channel|>final<|message|>real<|return|><|message|>injected<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.content).not.toBe("realinjected");
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);

    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  // BARE-RED 2: the FIRST message itself begins with a bare <|message|> (no
  // <|start|>/<|channel|>), followed by another bare <|message|>. The OLD code
  // glued both bare bodies -> content "onetwo". Correct: parseHarmonyContent
  // fails safe verbatim. At the collapse layer the content has NO real header
  // (no <|channel|>/<|start|> before <|message|>), so it does not even trip the
  // cheap `isHarmonyContent` gate (which requires channel-then-message or
  // start-then-message ordering): the collapser leaves it VERBATIM with no glue
  // and does not flag harmonyUnparsed. The corruption (body glue) is fixed
  // either way; the bytes are preserved untouched.
  it("BARE-RED2: <|message|>one<|end|><|message|>two<|return|> fails safe (no body glue)", () => {
    const raw = "<|message|>one<|end|><|message|>two<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.content).not.toBe("onetwo");
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);

    // Verbatim no-op at the collapse layer (no channel/start header -> not
    // recognized as harmony structure, so content is preserved untouched).
    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.content).not.toBe("onetwo");
    expect(result.harmonyUnparsed).toBeUndefined();
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  // BARE-RED 3: leading prose text followed immediately by a bare <|message|>
  // (no <|start|>/<|channel|>). The OLD code treated the leading text as a
  // channel-less preamble and consumed the bare <|message|>, gluing them ->
  // content "preamblebody". Correct: parseHarmonyContent fails safe verbatim. At
  // the collapse layer there is again no real header before <|message|>, so it
  // does not trip the `isHarmonyContent` gate and is left VERBATIM with no glue.
  it("BARE-RED3: preamble<|message|>body<|return|> fails safe (no leading-text glue)", () => {
    const raw = "preamble<|message|>body<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.content).not.toBe("preamblebody");
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);

    // Verbatim no-op at the collapse layer (no channel/start header).
    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.content).not.toBe("preamblebody");
    expect(result.harmonyUnparsed).toBeUndefined();
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  // POSITIVE pin: leading channel-less TEXT that IS followed by a real
  // <|channel|>-introduced message stays a valid preamble (the leading-text
  // branch must still fire for START/CHANNEL, only MESSAGE is removed).
  it("leading text followed by a real <|channel|> message still parses (preamble preserved)", () => {
    const raw = "preamble <|channel|>final<|message|>body<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe("preamble body");
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);
  });

  // POSITIVE pin: leading channel-less TEXT followed by a real <|start|> message
  // stays a valid preamble likewise.
  it("leading text followed by a real <|start|> message still parses (preamble preserved)", () => {
    const raw = "preamble <|start|>assistant<|channel|>final<|message|>body<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe("preamble body");
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);
  });
});

describe("harmony body fail-safe — legitimate prose-quoted tokens still parse (guard against over-failing)", () => {
  // A final body that QUOTES <|end|>/<|return|> as inline-code prose, each
  // followed by real text and closed by a REAL <|return|> at EOF, is the
  // documented "embedded literal" case. It must still parse cleanly (the literal
  // is bracketed by prose on both sides — its follower is real text).
  it("final body quoting <|end|>/<|return|> as prose keeps the full sentence", () => {
    const body = "See `<|end|>` for the end token and `<|return|>` too.";
    const raw = `<|channel|>final<|message|>${body}<|return|>`;
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe(body);
    expect(direct.toolCalls).toEqual([]);
  });

  // An analysis body quoting <|call|>/<|start|> as prose, closed by a real
  // <|end|> before a real next message, must keep the full reasoning body.
  it("analysis body quoting <|call|>/<|start|> as prose keeps the full body", () => {
    const body = "Consider the `<|call|>` and `<|start|>` markers carefully.";
    const raw = `<|channel|>analysis<|message|>${body}<|end|><|start|>assistant<|channel|>final<|message|>Done.<|return|>`;
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.reasoning).toBe(body);
    expect(direct.content).toBe("Done.");
  });
});

describe("harmony boundary — KNOWN_CHANNELS tightening of looksLikeMessageStart", () => {
  // A lookahead <|start|>...<|channel|>X<|message|> whose channel X is NOT a
  // known harmony channel (analysis/commentary/final) is NOT a real message
  // boundary. Inside a final body, such a <|start|> is therefore embedded prose
  // — but here it is immediately followed by control tokens / runs without real
  // prose bracketing, so the structural body rule fails it safe rather than
  // splitting on a bogus channel. The key assertion: it does NOT split into a
  // second message routed on an unknown channel, and no token leaks.
  it("a <|start|>...<|channel|>UNKNOWN<|message|> lookahead is not treated as a real boundary", () => {
    const raw =
      "<|channel|>final<|message|>body <|start|>assistant<|channel|>bogus<|message|>x<|return|>";
    const direct = parseHarmonyContent(raw);
    // Not split on the bogus channel; whatever the outcome, no leak on success.
    if (!direct.failed) {
      expect(direct.content).not.toMatch(/<\|(start|channel|message|return)\|>/);
    } else {
      expect(direct.content).toBe(raw);
    }
  });

  // Positive: a KNOWN-channel lookahead still terminates the body and starts the
  // next message (no regression to legitimate multi-message splitting).
  it("a KNOWN-channel <|start|> lookahead still terminates the current body", () => {
    const raw =
      "<|channel|>final<|message|>first answer<|start|>assistant<|channel|>final<|message|>second answer<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    // Two final messages concatenate into content; zero leaked tokens.
    expect(direct.content).toBe("first answersecond answer");
    expect(direct.content).not.toMatch(/<\|/);
  });

  // A directly-channel-less trailing message (<|start|>assistant<|message|>...,
  // NO <|channel|>) is still a valid boundary — KNOWN_CHANNELS only gates a
  // lookahead that actually carries a <|channel|> header.
  it("a channel-less <|start|>...<|message|> trailing message is still a valid boundary", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.lookup<|constrain|>json<|message|>{"q":"x"}<|call|>' +
      "<|start|>assistant<|message|>The answer.<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toHaveLength(1);
    expect(direct.toolCalls[0]).toEqual({ name: "lookup", arguments: '{"q":"x"}' });
    expect(direct.content).toBe("The answer.");
  });

  // MULTI-CALL: the commentary tool-body scan picks the FIRST <|call|> whose
  // accumulated preceding text is a COMPLETE JSON OBJECT and terminates the
  // args there — it must NOT over-consume into a second trailing <|call|>. The
  // body `{"a":1}` is already a complete object at the first CALL, so the args
  // are exactly `{"a":1}` and the parser does not greedily swallow the second
  // CALL. A clean trailing final message proves the first CALL was selected as
  // the boundary (over-consumption would have mangled this into a single body).
  it("MULTI-CALL: first valid-object <|call|> terminates the args (no over-consume)", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.t<|constrain|>json<|message|>{"a":1}<|call|>' +
      "<|start|>assistant<|message|>done<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toHaveLength(1);
    // Args terminated at the FIRST CALL — exactly the first complete object.
    expect(direct.toolCalls[0]).toEqual({ name: "t", arguments: '{"a":1}' });
    expect(direct.content).toBe("done");
  });

  // MULTI-CALL fail-safe: the same first-CALL selection holds when a bare second
  // <|call|> immediately follows. The first CALL closes `{"a":1}` and is chosen
  // as the terminator (not over-consumed across the second CALL); the stray
  // trailing CALL then has no owning message, so the WHOLE parse fails safe
  // verbatim rather than fabricating an over-consumed tool call.
  it("MULTI-CALL: a stray trailing <|call|> after the first object fails safe verbatim", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.t<|constrain|>json<|message|>{"a":1}<|call|><|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);
  });
});

describe("harmony tool-arg whitespace canonicalization", () => {
  // Leading whitespace in the captured JSON args (e.g. "<|message|> {\"a\":1}")
  // must be trimmed so the recorded arguments are the canonical JSON value.
  it("trims leading whitespace from tool-call JSON args", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.t<|constrain|>json<|message|> {"a":1}<|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toHaveLength(1);
    expect(direct.toolCalls[0]).toEqual({ name: "t", arguments: '{"a":1}' });
    expect(() => JSON.parse(direct.toolCalls[0].arguments)).not.toThrow();
  });

  // Trailing whitespace is likewise trimmed.
  it("trims trailing whitespace from tool-call JSON args", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.t<|constrain|>json<|message|>{"a":1} <|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toHaveLength(1);
    expect(direct.toolCalls[0].arguments).toBe('{"a":1}');
  });

  // Both-sides whitespace (including newlines) is trimmed to the canonical JSON.
  it("trims surrounding whitespace/newlines from tool-call JSON args", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.t<|constrain|>json<|message|>\n  {"a":1}\n  <|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls[0].arguments).toBe('{"a":1}');
  });

  // Interior whitespace inside the JSON value is preserved (only leading/
  // trailing is trimmed).
  it("preserves interior whitespace inside the JSON args", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.t<|constrain|>json<|message|> {"a": 1, "b": 2} <|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls[0].arguments).toBe('{"a": 1, "b": 2}');
  });
});

describe("harmony tool-arg must be a JSON OBJECT (scalar/array/null are malformed)", () => {
  // Harmony tool-call arguments are JSON OBJECTS. A commentary tool body that is
  // a bare JSON SCALAR (number / boolean / string) parses as valid JSON but is
  // NOT a valid tool-call argument object. The OLD code accepted it as a tool
  // call with the scalar text as `arguments` (e.g. arguments "123"). Correct:
  // the body does NOT terminate a valid tool call -> uniform fail-safe (verbatim
  // + harmonyUnparsed), no fabricated tool call.
  it("a bare numeric scalar body (123) is NOT a tool call (fail-safe verbatim)", () => {
    const raw = "<|channel|>commentary to=functions.f<|message|>123<|call|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);

    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  it("a bare boolean scalar body (true) is NOT a tool call (fail-safe verbatim)", () => {
    const raw = "<|channel|>commentary to=functions.f<|message|>true<|call|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.toolCalls).toEqual([]);
  });

  it('a bare string scalar body ("str") is NOT a tool call (fail-safe verbatim)', () => {
    const raw = '<|channel|>commentary to=functions.f<|message|>"str"<|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.toolCalls).toEqual([]);
  });

  it("a JSON array body ([1,2]) is NOT a tool call (arguments must be an object)", () => {
    const raw = "<|channel|>commentary to=functions.f<|message|>[1,2]<|call|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.toolCalls).toEqual([]);
  });

  it("a JSON null body is NOT a tool call (arguments must be a non-null object)", () => {
    const raw = "<|channel|>commentary to=functions.f<|message|>null<|call|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.toolCalls).toEqual([]);
  });

  // POSITIVE pin: a genuine JSON OBJECT body still parses as a tool call — the
  // object requirement must not regress the happy path, including an empty {}.
  it("an empty object body ({}) IS a valid tool call", () => {
    const raw = "<|channel|>commentary to=functions.f<|message|>{}<|call|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toEqual([{ name: "f", arguments: "{}" }]);
  });

  // POSITIVE pin: matrix 13/14 — embedded control-token literals INSIDE a JSON
  // OBJECT arg remain valid (the object requirement only rejects scalars/arrays,
  // not objects whose string values happen to contain token-shaped substrings).
  it("an object arg containing embedded <|call|> substrings stays a valid tool call (matrix 13)", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.say<|constrain|>json<|message|>{"text":"say <|call|> now"}<|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toEqual([{ name: "say", arguments: '{"text":"say <|call|> now"}' }]);
  });
});

describe("harmony — recipient does NOT carry over across messages", () => {
  // A prior analysis message carries `to=functions.x` (matrix 23: analysis +
  // recipient is NOT a tool call). The NEXT message is a plain commentary
  // message with NO recipient of its own. The recipient must NOT carry over —
  // commentary-without-recipient is a preamble that routes to CONTENT, and no
  // tool call named `x` may be fabricated.
  it("analysis to=functions.x then plain commentary does not fabricate tool x", () => {
    const raw =
      "<|channel|>analysis to=functions.x<|message|>thinking<|end|>" +
      "<|start|>assistant<|channel|>commentary<|message|>plain<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    // analysis body -> reasoning; commentary-without-recipient -> content.
    expect(direct.reasoning).toBe("thinking");
    expect(direct.content).toBe("plain");
    // No tool call fabricated from the carried-over recipient.
    expect(direct.toolCalls).toEqual([]);
  });
});

describe("harmony — cross-channel quoted-split routing (KNOWN LIMITATION)", () => {
  // The quoted-whole-message ambiguity is channel-agnostic: a body that QUOTES a
  // complete well-formed message of a DIFFERENT channel is structurally
  // indistinguishable from two real messages, so it splits and routes each half
  // by its (quoted) channel. We PIN the documented imperfect behavior so a future
  // change to the split logic is a conscious decision, not an accident.

  // (a) An analysis body that quotes a complete FINAL message: splits into an
  // analysis half (-> reasoning) and a final half (-> content). The quoted
  // control tokens are stripped (the known limitation), never leaked.
  it("analysis body quoting a complete final message splits reasoning|content", () => {
    const raw =
      "<|channel|>analysis<|message|>note " +
      "<|start|>assistant<|channel|>final<|message|>answer<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.reasoning).toBe("note ");
    expect(direct.content).toBe("answer");
    // Whatever the split, no raw control token leaks into routed output.
    expect(direct.reasoning).not.toMatch(/<\|/);
    expect(direct.content).not.toMatch(/<\|/);
  });

  // (b) A final body that quotes a complete commentary TOOL message: the quoted
  // <|start|>...commentary to=functions.X...<|call|> is a well-formed message
  // boundary, so it splits — the final half routes to content and the quoted
  // commentary-tool half materializes as a real tool call (the known limitation:
  // a quoted tool message is indistinguishable from a real one). No leak.
  it("final body quoting a complete commentary-tool message splits content|toolCall", () => {
    const raw =
      "<|channel|>final<|message|>see " +
      '<|start|>assistant<|channel|>commentary to=functions.t<|constrain|>json<|message|>{"a":1}<|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe("see ");
    expect(direct.toolCalls).toEqual([{ name: "t", arguments: '{"a":1}' }]);
    expect(direct.content).not.toMatch(/<\|/);
  });
});

describe("harmony — legitimate multi-message + tool calls (positive end-to-end)", () => {
  // analysis -> reasoning, commentary tool call (whitespace-padded args), final
  // -> content, with inter-message whitespace. Proves the structural fail-safe
  // does not regress the realistic happy path.
  it("parses analysis + commentary tool (padded args) + final with separators", () => {
    const chunks = [
      "<|channel|>analysis<|message|>Plan the call.<|end|>",
      "\n",
      '<|start|>assistant<|channel|>commentary to=functions.lookup<|constrain|>json<|message|> {"q":"x"} <|call|>',
      "\n",
      "<|start|>assistant<|channel|>final<|message|>Here is the result.<|return|>",
    ];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.reasoning).toBe("Plan the call.");
    expect(result.content).toBe("Here is the result.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({ name: "lookup", arguments: '{"q":"x"}' });
    expect(result.content).not.toMatch(/<\|/);
    expect(result.content).not.toContain("\n");
  });
});
