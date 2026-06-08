import { describe, it, expect, vi } from "vitest";
import { resolveReasoningForModel } from "../helpers.js";
import { Logger } from "../logger.js";

describe("resolveReasoningForModel", () => {
  it("returns undefined when there is no reasoning to emit (no-op)", () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    expect(resolveReasoningForModel(undefined, "gpt-4.1", false, logger)).toBeUndefined();
    expect(resolveReasoningForModel("", "gpt-4.1", true, logger)).toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("emits unchanged for a reasoning-capable model, no log", () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    expect(resolveReasoningForModel("thinking…", "o3-mini", false, logger)).toBe("thinking…");
    expect(resolveReasoningForModel("thinking…", "o3-mini", true, logger)).toBe("thinking…");

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("warns but preserves emission for a non-reasoning model when strict is OFF", () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const result = resolveReasoningForModel("thinking…", "gpt-4.1", false, logger);

    expect(result).toBe("thinking…");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).toContain("gpt-4.1");
    expect(error).not.toHaveBeenCalled();
  });

  it("suppresses emission and logs error for a non-reasoning model when strict is ON", () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const result = resolveReasoningForModel("thinking…", "gpt-4.1", true, logger);

    expect(result).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.join(" ")).toContain("gpt-4.1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the requested model id when deciding capability", () => {
    const logger = new Logger("warn");
    // unknown model defaults to capable → emits unchanged, no log
    expect(resolveReasoningForModel("r", "some-future-model", true, logger)).toBe("r");
  });
});
