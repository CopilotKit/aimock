/**
 * Unit test for structured numeric `status` on InfraError (C5.1).
 *
 * Verifies that errors thrown through the `assertOk` → `withInfraErrorTag`
 * pipeline carry a first-class numeric `.status` field, so downstream
 * classification (C5.2 Slack, C5.3a preflight) can key off
 * `status === 401 || status === 403` → stale-key vs `429`/`5xx` → infra-transient
 * WITHOUT parsing prose message strings.
 *
 * RED captured (pre-change): `e.status` was `undefined` — no numeric status.
 * GREEN (post-change): `e.status` is the exact HTTP status code.
 */
import { describe, it, expect } from "vitest";
import { listOpenAIModels } from "./providers.js";

// Helper: build a minimal Response-like object
function fakeResponse(status: number, body = "Unauthorized"): Response {
  return new Response(body, { status });
}

describe("InfraError structured status (C5.1)", () => {
  it("GREEN: caught error exposes status === 401 (stale-key class)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => fakeResponse(401, "Unauthorized");
    try {
      await listOpenAIModels("fake-key");
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      const e = err as Error & { status?: number };
      // Must be numeric 401, not undefined
      expect(typeof e.status).toBe("number");
      expect(e.status).toBe(401);
      // Human-readable INFRA_ERROR prose must still be present in message
      expect((e as Error).message).toMatch(/INFRA_ERROR/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("GREEN: caught error exposes status === 403 (stale-key class)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => fakeResponse(403, "Forbidden");
    try {
      await listOpenAIModels("fake-key");
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      const e = err as Error & { status?: number };
      expect(typeof e.status).toBe("number");
      expect(e.status).toBe(403);
      expect((e as Error).message).toMatch(/INFRA_ERROR/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("GREEN: caught error exposes status === 503 (infra-transient class)", async () => {
    const origFetch = globalThis.fetch;
    // 503 is in RETRYABLE_STATUSES; fetchWithRetry retries attempts 0 and 1,
    // then returns the response on attempt 2 (the last) without further retry.
    // assertOk then fires on the 503 response.
    globalThis.fetch = async () => fakeResponse(503, "Service Unavailable");
    try {
      await listOpenAIModels("fake-key");
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      const e = err as Error & { status?: number };
      expect(typeof e.status).toBe("number");
      expect(e.status).toBe(503);
      expect((e as Error).message).toMatch(/INFRA_ERROR/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
