export type LiveJson = null | boolean | number | string | LiveJson[] | { [key: string]: LiveJson };
export type LiveObject = { [key: string]: LiveJson };
export type LiveMode = "client" | "managed";
export interface LivePosition {
  command: number;
  audioBytes: number;
}
export interface LiveBinding {
  entry: number;
  pointer: string;
  name: string;
  action: "define" | "reference";
  owner: "client" | "server";
  origin?: "observed" | "imported-context";
}
export interface LiveEntry {
  direction: "client" | "server";
  atMs: number;
  event: LiveObject;
  barrier?: LivePosition;
}
export interface LiveTranscript {
  version: 1;
  model: "gpt-live-1";
  mode: LiveMode;
  audio: { encoding: "pcm16le"; sampleRateHz: 24000; channels: 1 };
  configuration: LiveObject;
  entries: LiveEntry[];
  bindings: LiveBinding[];
  capture: {
    source: "authored" | "provider";
    complete: true;
    terminalEntry: number;
    provenance?: {
      host: string;
      path: "/v1/live/sessions";
      observedAt: string;
      referenceVersion: string;
      sanitationVersion: 1;
    };
  };
}
export interface LiveFixtureResponse {
  live: LiveTranscript;
  liveTiming?: "recorded" | "immediate";
}
export interface LiveOptions {
  maxSessions?: number;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
  maxWriteBytes?: number;
  maxDecodedAudioBytes?: number;
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  mismatchTimeoutMs?: number;
  secretValues?: string[];
}
export type LiveFailureCategory =
  | "invalid-client"
  | "fixture-mismatch"
  | "protocol-divergence"
  | "upstream-auth"
  | "upstream-access"
  | "upstream-connect"
  | "timeout"
  | "resource-limit"
  | "incomplete-capture"
  | "unsafe-export";
