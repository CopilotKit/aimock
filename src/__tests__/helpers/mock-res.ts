import * as http from "node:http";
import type { HandlerDefaults } from "../../types.js";
import { Logger } from "../../logger.js";

export function createMockReq(overrides: Partial<http.IncomingMessage> = {}): http.IncomingMessage {
  return {
    method: undefined,
    url: undefined,
    headers: {},
    ...overrides,
  } as unknown as http.IncomingMessage;
}

export function createMockRes(): http.ServerResponse & {
  _written: string;
  _status: number;
  _headers: Record<string, string>;
} {
  const res = {
    _written: "",
    _status: 0,
    _headers: {} as Record<string, string>,
    writableEnded: false,
    statusCode: 0,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      res.statusCode = status;
      if (headers) Object.assign(res._headers, headers);
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
    },
    write(data: string) {
      res._written += data;
      return true;
    },
    end(data?: string) {
      if (data) res._written += data;
      res.writableEnded = true;
    },
    destroy() {
      res.writableEnded = true;
    },
  };
  return res as unknown as http.ServerResponse & {
    _written: string;
    _status: number;
    _headers: Record<string, string>;
  };
}

export function createDefaults(overrides: Partial<HandlerDefaults> = {}): HandlerDefaults {
  return {
    latency: 0,
    chunkSize: 100,
    replaySpeed: 1.0,
    logger: new Logger("silent"),
    ...overrides,
  };
}
