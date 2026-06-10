import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { resolveProgression } from "../fal.js";
import type { VideoResponse } from "../types.js";
import { SKIPPED_BY_STATE_RE } from "./helpers/strict-matchers.js";

// ─── Task 1: shared progression resolver + extended video fixture fields ───

describe("resolveProgression (shared with fal queue)", () => {
  test("is exported and defaults to 0/0 (complete on first poll)", () => {
    expect(resolveProgression(undefined)).toEqual({
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 0,
    });
  });

  test("inProgress-only config defaults completed to one poll later", () => {
    expect(resolveProgression({ pollsBeforeInProgress: 2 })).toEqual({
      pollsBeforeInProgress: 2,
      pollsBeforeCompleted: 3,
    });
  });

  test("clamps completed >= inProgress", () => {
    expect(resolveProgression({ pollsBeforeInProgress: 3, pollsBeforeCompleted: 1 })).toEqual({
      pollsBeforeInProgress: 3,
      pollsBeforeCompleted: 3,
    });
  });
});

describe("VideoResponse extended fields", () => {
  test("accepts error, b64, and cost on the video object", () => {
    const failed: VideoResponse = {
      video: { id: "v1", status: "failed", error: "policy violation" },
    };
    const completed: VideoResponse = {
      video: { id: "v2", status: "completed", b64: "AAAA", cost: 0.05 },
    };
    expect(failed.video.error).toBe("policy violation");
    expect(completed.video.b64).toBe("AAAA");
    expect(completed.video.cost).toBe(0.05);
  });

  test("openRouterVideo progression config is accepted in server options", async () => {
    const mock = new LLMock({
      port: 0,
      openRouterVideo: { pollsBeforeInProgress: 1, pollsBeforeCompleted: 2 },
    });
    await mock.start();
    await mock.stop();
  });
});
