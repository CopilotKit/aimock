import { describe, it, expect } from "vitest";
import { StreamingFrameDecoder } from "../recorder.js";
import { collapseOpenAISSE } from "../stream-collapse.js";

// ---------------------------------------------------------------------------
// Multibyte UTF-8 streaming decode — regression for fixture garbling.
//
// When aimock proxies a streamed upstream LLM response, makeUpstreamRequest
// decodes each TCP chunk to text so it can split the byte stream into SSE /
// NDJSON frames. A multibyte UTF-8 character (CJK, emoji, ...) can have its
// bytes split across a TCP chunk boundary. Decoding each chunk independently
// with Buffer#toString() turns the partial sequence into U+FFFD replacement
// characters, corrupting the decoded frame text (a user reported garbage like
// "官网群" in a recorded fixture).
//
// There are TWO decode paths and this file covers BOTH:
//   1. The frame-TIMING path (StreamingFrameDecoder) — used when capturing
//      per-frame arrival timestamps; it decodes incrementally as TCP chunks
//      arrive, so it must buffer partial multibyte sequences across chunk
//      boundaries itself. The first describe-block drives that decoder
//      directly (the exact code makeUpstreamRequest uses), not a reimpl.
//   2. The recorded-BODY path — the full upstream byte stream is buffered via
//      Buffer.concat and decoded ONCE with rawBuffer.toString() before being
//      handed to the collapse functions. The final describe-block drives that
//      path end-to-end (split-chunk bytes -> concat -> toString -> collapse)
//      to pin that the body a fixture is built from is also U+FFFD-free.
// ---------------------------------------------------------------------------

/**
 * Split a UTF-8 buffer at an arbitrary byte offset, guaranteeing the cut lands
 * inside a multibyte sequence (so naive per-chunk decode would mangle it).
 */
function splitMidCharacter(text: string): { first: Buffer; second: Buffer } {
  const full = Buffer.from(text, "utf8");
  // Locate the first non-ASCII (multibyte lead) byte and cut one byte past it,
  // so the split lands inside the multibyte sequence.
  let i = 0;
  while (i < full.length && full[i] < 0x80) i++;
  // Guard against ASCII-only misuse: without a multibyte lead byte the cut
  // would not straddle a character and the test would be a degenerate no-op.
  if (i >= full.length) {
    throw new Error("splitMidCharacter: no multibyte lead byte found (ASCII-only input)");
  }
  const cut = i + 1; // one byte into the multibyte sequence
  return { first: full.subarray(0, cut), second: full.subarray(cut) };
}

describe("StreamingFrameDecoder", () => {
  it("reassembles a CJK character split across two chunks without U+FFFD", () => {
    const original = 'data: {"delta":"官网群"}\n\n';
    const { first, second } = splitMidCharacter(original);

    // Sanity: the split really does straddle a multibyte boundary, so a naive
    // per-chunk decode would corrupt it. This pins WHY the test is meaningful.
    expect(first.toString() + second.toString()).toContain("�");

    const decoder = new StreamingFrameDecoder();
    let out = "";
    out += decoder.write(first);
    out += decoder.write(second);
    out += decoder.end();

    expect(out).toBe(original);
    expect(out).not.toContain("�");
  });

  it("reassembles a 4-byte emoji split across two chunks without U+FFFD", () => {
    const original = "data: 🎉🎉\n\n";
    const { first, second } = splitMidCharacter(original);

    expect(first.toString() + second.toString()).toContain("�");

    const decoder = new StreamingFrameDecoder();
    let out = "";
    out += decoder.write(first);
    out += decoder.write(second);
    out += decoder.end();

    expect(out).toBe(original);
    expect(out).not.toContain("�");
  });

  it("handles a multibyte character split byte-by-byte across many chunks", () => {
    const original = "官"; // 3 bytes: E5 AE 98
    const full = Buffer.from(original, "utf8");
    const decoder = new StreamingFrameDecoder();
    let out = "";
    for (const byte of full) {
      out += decoder.write(Buffer.from([byte]));
    }
    out += decoder.end();
    expect(out).toBe(original);
    expect(out).not.toContain("�");
  });

  it("passes ASCII-only frames through unchanged", () => {
    const decoder = new StreamingFrameDecoder();
    let out = "";
    out += decoder.write(Buffer.from("data: hello\n\n", "utf8"));
    out += decoder.end();
    expect(out).toBe("data: hello\n\n");
  });
});

// ---------------------------------------------------------------------------
// Recorded-BODY multibyte path — regression for fixture garbling on the
// collapse path (NOT the frame-timing decoder above).
//
// On the non-timing capture path, makeUpstreamRequest accumulates the raw
// upstream bytes and decodes the COMPLETE buffer once (Buffer.concat then
// rawBuffer.toString()) before handing the text to a collapse function. Even
// when a multibyte UTF-8 character is split across TCP chunk boundaries, the
// concat-then-decode order means the body the fixture is built from must be
// U+FFFD-free. This test drives that exact order through collapseOpenAISSE.
// ---------------------------------------------------------------------------

describe("recorded-body multibyte decode (Buffer.concat -> toString -> collapse)", () => {
  /**
   * Build an OpenAI SSE body containing the given content, then return its raw
   * UTF-8 bytes split into two chunks at an offset that lands INSIDE a
   * multibyte sequence (so a naive per-chunk decode would mangle it).
   */
  function sseBytesSplitMidCharacter(content: string): { first: Buffer; second: Buffer } {
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-mb", choices: [{ delta: { content } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const full = Buffer.from(body, "utf8");
    // Cut one byte into the first multibyte (non-ASCII) sequence.
    let i = 0;
    while (i < full.length && full[i] < 0x80) i++;
    // Guard against ASCII-only misuse: without a multibyte lead byte the cut
    // would not straddle a character and the test would be a degenerate no-op.
    if (i >= full.length) {
      throw new Error(
        "sseBytesSplitMidCharacter: no multibyte lead byte found (ASCII-only content)",
      );
    }
    const cut = i + 1;
    return { first: full.subarray(0, cut), second: full.subarray(cut) };
  }

  it("decodes a CJK body split across chunks with no U+FFFD via the collapse path", () => {
    const content = "官网群 says hello 🎉";
    const { first, second } = sseBytesSplitMidCharacter(content);

    // Sanity: decoding the chunks INDEPENDENTLY would corrupt the text — this
    // pins that the split really straddles a multibyte boundary (so the test
    // is meaningful and not trivially green).
    expect(first.toString() + second.toString()).toContain("�");

    // The recorder's actual order: buffer all bytes, decode once, then collapse.
    const rawBuffer = Buffer.concat([first, second]);
    const decoded = rawBuffer.toString("utf8");
    const result = collapseOpenAISSE(decoded);

    expect(result.content).toBe(content);
    expect(result.content).not.toContain("�");
  });

  it("decodes an emoji-only body split across chunks with no U+FFFD via the collapse path", () => {
    const content = "🎉🎉🎉";
    const { first, second } = sseBytesSplitMidCharacter(content);

    expect(first.toString() + second.toString()).toContain("�");

    const rawBuffer = Buffer.concat([first, second]);
    const result = collapseOpenAISSE(rawBuffer.toString("utf8"));

    expect(result.content).toBe(content);
    expect(result.content).not.toContain("�");
  });
});
