/**
 * AWS Event Stream binary frame encoder.
 *
 * Implements the AWS binary event stream framing protocol used by Bedrock's
 * streaming (invoke-with-response-stream) endpoint. Each frame carries a set of
 * string headers and a raw-bytes payload, wrapped in a prelude with CRC32
 * checksums for integrity.
 *
 * Binary frame layout:
 *   [total_length: 4B uint32-BE]
 *   [headers_length: 4B uint32-BE]
 *   [prelude_crc32: 4B CRC32 of first 8 bytes]
 *   [headers: variable]
 *   [payload: variable, raw JSON bytes]
 *   [message_crc32: 4B CRC32 of entire frame minus last 4 bytes]
 */

import { crc32 } from "node:zlib";
import type * as http from "node:http";
import type { StreamingProfile, RecordedTimings } from "./types.js";
import { httpSink, runFrameLoop, type FrameCodec } from "./response/frame-loop.js";

// ─── Header encoding ────────────────────────────────────────────────────────

function encodeHeaders(headers: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = Buffer.from(name, "utf8");
    const valueBytes = Buffer.from(value, "utf8");

    // name_length (1 byte) + name + type (1 byte, 7 = STRING) +
    // value_length (2 bytes BE) + value
    const header = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    let offset = 0;
    header.writeUInt8(nameBytes.length, offset);
    offset += 1;
    nameBytes.copy(header, offset);
    offset += nameBytes.length;
    header.writeUInt8(7, offset); // STRING type
    offset += 1;
    header.writeUInt16BE(valueBytes.length, offset);
    offset += 2;
    valueBytes.copy(header, offset);

    parts.push(header);
  }
  return Buffer.concat(parts);
}

// ─── Frame encoding ─────────────────────────────────────────────────────────

/**
 * Encode a single AWS Event Stream binary frame with the given headers and
 * payload buffer.
 */
export function encodeEventStreamFrame(headers: Record<string, string>, payload: Buffer): Buffer {
  const headersBuffer = encodeHeaders(headers);
  const headersLength = headersBuffer.length;

  // prelude (8) + prelude_crc (4) + headers + payload + message_crc (4)
  const totalLength = 4 + 4 + 4 + headersLength + payload.length + 4;

  const frame = Buffer.alloc(totalLength);
  let offset = 0;

  // Prelude
  frame.writeUInt32BE(totalLength, offset);
  offset += 4;
  frame.writeUInt32BE(headersLength, offset);
  offset += 4;

  // Prelude CRC32 (covers first 8 bytes)
  const preludeCrc = crc32(frame.subarray(0, 8));
  frame.writeUInt32BE(preludeCrc >>> 0, offset);
  offset += 4;

  // Headers
  headersBuffer.copy(frame, offset);
  offset += headersLength;

  // Payload
  payload.copy(frame, offset);
  offset += payload.length;

  // Message CRC32 (covers entire frame minus last 4 bytes)
  const messageCrc = crc32(frame.subarray(0, totalLength - 4));
  frame.writeUInt32BE(messageCrc >>> 0, offset);

  return frame;
}

// ─── Convenience wrappers ───────────────────────────────────────────────────

/**
 * Encode an event-stream message with standard AWS headers for a JSON event.
 *
 * Sets `:content-type` = `application/json`, `:event-type` = eventType,
 * `:message-type` = `event`.
 */
export function encodeEventStreamMessage(eventType: string, jsonPayload: object): Buffer {
  const headers: Record<string, string> = {
    ":content-type": "application/json",
    ":event-type": eventType,
    ":message-type": "event",
  };
  const payload = Buffer.from(JSON.stringify(jsonPayload), "utf8");
  return encodeEventStreamFrame(headers, payload);
}

/**
 * Write a sequence of event-stream frames to an HTTP response with optional
 * timing control. Mirrors the writeSSEStream pattern from sse-writer.ts.
 *
 * Returns `true` when all events are written (including when the response
 * was already ended before writing began), or `false` if interrupted by
 * the provided abort signal.
 */
export async function writeEventStream(
  res: http.ServerResponse,
  events: Array<{ eventType: string; payload: object }>,
  options?: {
    latency?: number;
    streamingProfile?: StreamingProfile;
    recordedTimings?: RecordedTimings;
    replaySpeed?: number;
    signal?: AbortSignal;
    onChunkSent?: () => void;
  },
): Promise<boolean> {
  const opts = options ?? {};
  // Base contract (public API): with no frames, an aborted signal does not
  // stop the writer; it still finishes the stream (any trailer, then end())
  // and returns true. The frame loop returns false there, so pass it no
  // signal when there are no frames (it reads the signal only per frame and
  // after the loop).
  return runFrameLoop(
    httpSink(res),
    events,
    eventStreamCodec(),
    {
      latency: opts.latency,
      streamingProfile: opts.streamingProfile,
      recordedTimings: opts.recordedTimings,
      replaySpeed: opts.replaySpeed,
    },
    { signal: events.length > 0 ? opts.signal : undefined, onChunkSent: opts.onChunkSent },
  );
}

// Internal (not part of the public API): the AWS binary event-stream codec.
// Each event becomes one complete frame, encoded by encodeEventStreamMessage
// unless an `encode` argument replaces it. There is no prelude or trailer.
// These are line comments, not JSDoc, so the bundled .d.ts does not attach
// them to a public declaration.
export function eventStreamCodec<F extends { eventType: string; payload: object }>(
  encode?: (event: F) => Buffer,
): FrameCodec<F> {
  return {
    headers: {
      "Content-Type": "application/vnd.amazon.eventstream",
      "Transfer-Encoding": "chunked",
    },
    encode: encode ?? ((event) => encodeEventStreamMessage(event.eventType, event.payload)),
  };
}
