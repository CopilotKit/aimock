import { isDeepStrictEqual } from "node:util";
import { isKnownSurface } from "./surface-registry.js";

export type ObservationBody =
  | null
  | boolean
  | number
  | string
  | ObservationBody[]
  | { [key: string]: ObservationBody };
export interface ObservedResponse {
  status: number;
  body: ObservationBody;
}
export interface LiveObservation {
  surface: string;
  caseId: string;
  expected: ObservedResponse;
  actual: ObservedResponse;
  matched: boolean;
}

export const LIVE_OBSERVATION_PREFIX = "AIMOCK_DRIFT_OBSERVATION ";
const MAX_OBSERVATION_BYTES = 64 * 1024;
const secretField =
  /^(authorization|proxyauthorization|cookie|setcookie|headers|requestheaders|apikey|xapikey|xgoogapikey|key|secret|clientsecret|password|credentials|token|accesstoken|refreshtoken)$/i;
const secretValue = /(?:\bsk-[a-zA-Z0-9_-]+|\bAIza[a-zA-Z0-9_-]+)/;
const bearerValue = /\bbearer\s+\S+/i;

function safeBody(value: unknown, depth = 0): value is ObservationBody {
  if (depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !secretValue.test(value) && !bearerValue.test(value);
  if (Array.isArray(value)) return value.every((item) => safeBody(item, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      !secretField.test(key.replace(/[-_]/g, "")) &&
      !["__proto__", "constructor", "prototype"].includes(key) &&
      safeBody(item, depth + 1),
  );
}

function response(value: unknown): value is ObservedResponse {
  return (
    !!value &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    "status" in value &&
    "body" in value &&
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599 &&
    safeBody(value.body)
  );
}

function observation(value: unknown): value is LiveObservation {
  return (
    !!value &&
    typeof value === "object" &&
    Object.keys(value).length === 5 &&
    "surface" in value &&
    typeof value.surface === "string" &&
    isKnownSurface(value.surface) &&
    "caseId" in value &&
    typeof value.caseId === "string" &&
    /^[a-z0-9][a-z0-9:_. /-]{0,119}$/.test(value.caseId) &&
    "expected" in value &&
    response(value.expected) &&
    "actual" in value &&
    response(value.actual) &&
    "matched" in value &&
    typeof value.matched === "boolean" &&
    value.matched === isDeepStrictEqual(value.expected, value.actual)
  );
}

/** Explicit status/body channel; ShapeDiff reporting remains a separate caller responsibility. */
export function emitLiveObservation(input: Omit<LiveObservation, "matched">): LiveObservation {
  const value = { ...input, matched: isDeepStrictEqual(input.expected, input.actual) };
  const encoded = JSON.stringify(value);
  if (!observation(value) || Buffer.byteLength(encoded) > MAX_OBSERVATION_BYTES)
    throw new Error("Invalid or unsafe live observation");
  // Compare the JSON representation that the parser and persisted artifact consume.
  const normalized: LiveObservation = JSON.parse(encoded);
  normalized.matched = isDeepStrictEqual(normalized.expected, normalized.actual);
  if (!observation(normalized)) throw new Error("Invalid or unsafe live observation");
  console.log(LIVE_OBSERVATION_PREFIX + JSON.stringify(normalized));
  return normalized;
}

/** Ignore ordinary console lines; reject malformed marked evidence without echoing its contents. */
export function parseLiveObservation(line: string): LiveObservation | null {
  if (!line.startsWith(LIVE_OBSERVATION_PREFIX)) return null;
  const encoded = line.slice(LIVE_OBSERVATION_PREFIX.length);
  let value: unknown;
  try {
    if (Buffer.byteLength(encoded) > MAX_OBSERVATION_BYTES) throw new Error();
    value = JSON.parse(encoded);
  } catch {
    throw new Error("Invalid or unsafe live observation");
  }
  if (!observation(value)) throw new Error("Invalid or unsafe live observation");
  return value;
}
