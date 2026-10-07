import { describe, expect, it } from "vitest";
import { InvalidToolArgumentsError, toolArgsForWire } from "../helpers.js";
import type { ToolCall } from "../types.js";

const malformed = '{"city":';

function toolCall(args: string): ToolCall {
  return { name: "lookup", arguments: args };
}

function parseDiagnostic(raw: string) {
  try {
    JSON.parse(raw);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected malformed JSON in error test");
}

describe("toolArgsForWire internal compatibility contract", () => {
  it("keeps raw spacing and ordering alongside canonical text and parsed value", () => {
    const raw = '{ "b": 2, "a": 1 }';
    expect(toolArgsForWire(toolCall(raw))).toEqual({
      kind: "parsed",
      value: { b: 2, a: 1 },
      text: '{"b":2,"a":1}',
      raw,
    });
  });

  it.each([malformed, "   "])("preserves invalid arguments verbatim: %j", (raw) => {
    expect(toolArgsForWire(toolCall(raw))).toEqual({ kind: "verbatim", raw });
  });

  it.each(["empty", "missing"])("defaults %s arguments to an empty object", (mode) => {
    const tc = toolCall("");
    if (mode === "missing") Reflect.deleteProperty(tc, "arguments");
    expect(toolArgsForWire(tc)).toEqual({ kind: "parsed", value: {}, text: "{}", raw: "{}" });
  });

  it.each([
    { raw: "null", value: null },
    { raw: "[1, 2]", value: [1, 2] },
    { raw: '"hello"', value: "hello" },
    { raw: "1e2", value: 100 },
    { raw: "false", value: false },
  ])("preserves valid non-object JSON: $raw", ({ raw, value }) => {
    expect(toolArgsForWire(toolCall(raw))).toEqual({
      kind: "parsed",
      value,
      text: JSON.stringify(value),
      raw,
    });
  });
});

describe("InvalidToolArgumentsError", () => {
  it("retains the tool name, JSON diagnostic, and object-wire advice", () => {
    const error = new InvalidToolArgumentsError(toolCall(malformed));
    const diagnostic = parseDiagnostic(malformed);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("InvalidToolArgumentsError");
    expect(error.toolName).toBe("lookup");
    expect(error.parseDiagnostic).toBe(diagnostic);
    expect(error.message).toBe(
      `aimock: fixture tool call "lookup" has invalid JSON arguments; this wire carries arguments as an object. ` +
        `Use a wire that carries tool arguments as a string to test malformed JSON. (${diagnostic})`,
    );
  });
});
