import type { Fixture } from "./types.js";

export interface InterruptionControl {
  signal: AbortSignal;
  tick(): void;
  cleanup(): void;
  reason(): string | undefined;
}

export function createInterruptionSignal(fixture: Fixture): InterruptionControl | null {
  const { truncateAfterChunks, disconnectAfterMs } = fixture;

  if (truncateAfterChunks === undefined && disconnectAfterMs === undefined) {
    return null;
  }

  const controller = new AbortController();
  let abortReason: string | undefined;
  let chunkCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (disconnectAfterMs !== undefined) {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        abortReason = "disconnectAfterMs";
        controller.abort();
      }
    }, disconnectAfterMs);
  }

  return {
    signal: controller.signal,

    tick() {
      if (controller.signal.aborted) return;
      chunkCount++;
      if (truncateAfterChunks !== undefined && chunkCount >= truncateAfterChunks) {
        abortReason = "truncateAfterChunks";
        controller.abort();
      }
    },

    cleanup() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },

    reason() {
      return abortReason;
    },
  };
}
