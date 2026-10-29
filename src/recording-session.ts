import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TEST_ID } from "./constants.js";
import { getTestId } from "./helpers.js";
import type { Fixture, RecordConfig } from "./types.js";

/** A private batch of recordings, published only by a successful commit. */
export interface RecordingSession {
  commit(): Promise<number>;
  discard(): void;
}

interface Capture {
  fixture: Fixture;
  warnings: string[];
  cacheable: boolean;
}

export interface RecordingCapture {
  stage(fixture: Fixture, warnings: string[], cacheable: boolean): void;
  finish(): void;
}

export class RecordingSessionSealedError extends Error {}

class Session implements RecordingSession {
  private state: "open" | "sealed" | "committed" | "discarded" = "open";
  private readonly captures = new Map<number, Capture>();
  private nextAdmission = 0;
  private pending = 0;
  private drained?: () => void;
  private committing?: Promise<number>;
  private count = 0;

  constructor(
    private readonly fixturePath: string,
    private readonly fixtures: Fixture[],
    private readonly release: () => void,
  ) {}

  admit(): RecordingCapture {
    if (this.state !== "open") throw new RecordingSessionSealedError("Recording session sealed");
    const index = this.nextAdmission++;
    this.pending++;
    let finished = false;
    return {
      stage: (fixture, warnings, cacheable) => {
        if (!finished && this.state !== "discarded") {
          this.captures.set(index, { fixture, warnings, cacheable });
        }
      },
      finish: () => {
        if (finished) return;
        finished = true;
        if (--this.pending === 0) this.drained?.();
      },
    };
  }

  commit(): Promise<number> {
    if (this.state === "discarded") return Promise.reject(new Error("Recording session discarded"));
    if (this.state === "committed") return Promise.resolve(this.count);
    if (this.committing) return this.committing;
    this.state = "sealed";
    this.committing = this.publish().finally(() => {
      this.committing = undefined;
    });
    return this.committing;
  }

  discard(): void {
    if (this.state === "committed") throw new Error("Recording session already committed");
    if (this.state === "discarded") return;
    this.state = "discarded";
    this.captures.clear();
    this.drained?.();
    this.release();
  }

  private async publish(): Promise<number> {
    if (this.pending > 0) await new Promise<void>((resolve) => (this.drained = resolve));
    this.drained = undefined;
    if (this.state === "discarded") throw new Error("Recording session discarded");
    const captures = [...this.captures.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    if (captures.length > 0) {
      const warnings = [...new Set(captures.flatMap((c) => c.warnings))];
      const content = {
        fixtures: captures.map((c) => c.fixture),
        ...(warnings.length > 0 && { _warnings: warnings, _warning: warnings.join("; ") }),
      };
      // A single rename exposes the whole batch. Unique destinations preserve
      // batches from other servers without a read/modify/write race.
      const destination = join(this.fixturePath, `recording-${randomUUID()}.json`);
      const temporary = `${destination}.tmp`;
      mkdirSync(this.fixturePath, { recursive: true });
      try {
        writeFileSync(temporary, JSON.stringify(content, null, 2), {
          encoding: "utf8",
          flag: "wx",
        });
        renameSync(temporary, destination);
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch {
          // Preserve the original publication failure if cleanup also fails.
        }
        throw error;
      }
      for (const capture of captures) {
        if (capture.cacheable) this.fixtures.push(capture.fixture);
      }
    }
    this.count = captures.length;
    this.captures.clear();
    this.state = "committed";
    this.release();
    return this.count;
  }
}

export class RecordingSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly fixtures: Fixture[]) {}

  begin(testId: string, record?: RecordConfig): RecordingSession {
    if (!record || record.proxyOnly) throw new Error("Recording must be enabled without proxyOnly");
    if (typeof testId !== "string" || !testId.trim() || testId === DEFAULT_TEST_ID) {
      throw new Error("A nonblank, non-default test ID is required");
    }
    if (this.sessions.has(testId)) throw new Error("Recording session already exists for test ID");
    const session = new Session(record.fixturePath ?? "./fixtures/recorded", this.fixtures, () => {
      if (this.sessions.get(testId) === session) this.sessions.delete(testId);
    });
    this.sessions.set(testId, session);
    return session;
  }

  admit(testId: string): RecordingCapture | undefined {
    return this.sessions.get(testId)?.admit();
  }

  discardAll(): void {
    for (const session of this.sessions.values()) session.discard();
  }
}

// Associate routing context with the request, without extending the public
// signatures of every provider handler that delegates to the recorder.
const requestSessions = new WeakMap<IncomingMessage, RecordingSessions>();

export function bindRecordingSessions(req: IncomingMessage, sessions: RecordingSessions): void {
  requestSessions.set(req, sessions);
}

export function recordingSessionsFor(req: IncomingMessage): RecordingSessions | undefined {
  return requestSessions.get(req);
}

export function admitRecording(
  req: IncomingMessage,
  endpointType: string | undefined,
): RecordingCapture | undefined {
  return endpointType === "chat" ? requestSessions.get(req)?.admit(getTestId(req)) : undefined;
}
