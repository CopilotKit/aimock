import { validateHeaderName } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { CausalOccurrences } from "./causal-occurrences.js";
import type { CausalSelection } from "./causal-occurrences.js";

export interface RequestVerificationOptions {
  correlationHeader?: string;
  causal?: boolean;
}

export interface RequestExpectation {
  id: string;
  match: { path: string | RegExp; method?: string };
  count: number;
  after?: readonly string[];
  afterEach?: readonly string[];
}

export interface RequestExpectationResult {
  id: string;
  expected: number;
  started: number;
  completed: number;
  aborted: number;
  pending: number;
  missing: number;
  excess: number;
  premature: number;
}

export interface RequestVerificationResult {
  ok: boolean;
  expectations: RequestExpectationResult[];
}

interface Observation {
  expectation: RequestExpectation;
  started: number;
  completed: number;
  aborted: number;
  premature: number;
  completions: Map<string, number>;
  claimed: Map<string, Map<string, number>>;
  causal: CausalOccurrences;
}

function newObservation(expectation: RequestExpectation): Observation {
  return {
    expectation,
    started: 0,
    completed: 0,
    aborted: 0,
    premature: 0,
    completions: new Map(),
    claimed: new Map(),
    causal: new CausalOccurrences(),
  };
}

interface Scope {
  observations: Map<string, Observation>;
  correlationHeader?: string;
  causal: boolean;
}

function validateTestId(testId: string): void {
  if (typeof testId !== "string" || testId.trim().length === 0) {
    throw new TypeError("testId must be a nonblank string");
  }
}

function copyExpectations(expectations: readonly RequestExpectation[]): RequestExpectation[] {
  if (!Array.isArray(expectations)) throw new TypeError("expectations must be an array");
  const byId = new Map<string, RequestExpectation>();
  for (const entry of expectations as readonly RequestExpectation[]) {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || byId.has(entry.id)) {
      throw new TypeError("expectation IDs must be unique nonblank strings");
    }
    if (!Number.isSafeInteger(entry.count) || entry.count < 0) {
      throw new RangeError("expectation count must be a nonnegative safe integer");
    }
    if (
      !entry.match ||
      !(typeof entry.match.path === "string" || entry.match.path instanceof RegExp) ||
      (entry.match.method !== undefined &&
        (typeof entry.match.method !== "string" || !entry.match.method.trim()))
    ) {
      throw new TypeError("expectations require a path and an optional nonblank method");
    }
    for (const dependencies of [entry.after, entry.afterEach]) {
      if (
        dependencies !== undefined &&
        (!Array.isArray(dependencies) || dependencies.some((id) => typeof id !== "string"))
      ) {
        throw new TypeError("Dependencies must be arrays of expectation IDs");
      }
    }
    byId.set(entry.id, {
      id: entry.id,
      count: entry.count,
      match: {
        path:
          typeof entry.match.path === "string"
            ? entry.match.path
            : new RegExp(entry.match.path.source, entry.match.path.flags),
        method: entry.match.method?.toUpperCase(),
      },
      after: [...new Set(entry.after ?? [])],
      afterEach: [...new Set(entry.afterEach ?? [])],
    });
  }
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const entry of byId.values()) {
    const prerequisites = new Set([...entry.after!, ...entry.afterEach!]);
    remaining.set(entry.id, prerequisites.size);
    for (const id of prerequisites) {
      if (!byId.has(id)) throw new TypeError(`Unknown prerequisite: ${id}`);
      const children = dependents.get(id) ?? [];
      children.push(entry.id);
      dependents.set(id, children);
    }
  }
  const ready = [...remaining.keys()].filter((id) => remaining.get(id) === 0);
  for (let i = 0; i < ready.length; i++) {
    for (const id of dependents.get(ready[i]) ?? []) {
      const count = remaining.get(id)! - 1;
      remaining.set(id, count);
      if (count === 0) ready.push(id);
    }
  }
  if (ready.length !== byId.size) throw new TypeError("Request prerequisites must be acyclic");
  return [...byId.values()];
}

export class RequestVerifier {
  private scopes = new Map<string, Scope>();

  set(
    testId: string,
    expectations: readonly RequestExpectation[],
    options: RequestVerificationOptions = {},
  ): void {
    validateTestId(testId);
    const copied = copyExpectations(expectations);
    const header = options.correlationHeader;
    if (header !== undefined) validateHeaderName(header);
    if (options.causal !== undefined && typeof options.causal !== "boolean") {
      throw new TypeError("causal must be a boolean");
    }
    this.scopes.set(testId, {
      observations: new Map(copied.map((entry) => [entry.id, newObservation(entry)])),
      correlationHeader: header?.toLowerCase(),
      causal: options.causal ?? false,
    });
  }

  reset(testId?: string): void {
    if (testId !== undefined) validateTestId(testId);
    for (const [id, scope] of this.scopes) {
      if (testId !== undefined && id !== testId) continue;
      this.scopes.set(id, {
        correlationHeader: scope.correlationHeader,
        causal: scope.causal,
        observations: new Map(
          [...scope.observations].map(([key, value]) => [key, newObservation(value.expectation)]),
        ),
      });
    }
  }

  clear(): void {
    this.scopes.clear();
  }

  snapshot(testId: string): RequestVerificationResult {
    validateTestId(testId);
    const expectations = [...(this.scopes.get(testId)?.observations.values() ?? [])].map(
      (entry) => ({
        id: entry.expectation.id,
        expected: entry.expectation.count,
        started: entry.started,
        completed: entry.completed,
        aborted: entry.aborted,
        pending: entry.started - entry.completed - entry.aborted,
        missing: Math.max(0, entry.expectation.count - entry.started),
        excess: Math.max(0, entry.started - entry.expectation.count),
        premature: entry.premature,
      }),
    );
    return {
      ok: expectations.every(
        (entry) =>
          entry.missing === 0 &&
          entry.excess === 0 &&
          entry.pending === 0 &&
          entry.aborted === 0 &&
          entry.premature === 0,
      ),
      expectations,
    };
  }

  admit(
    testId: string,
    method: string,
    path: string,
    headers: IncomingHttpHeaders = {},
  ): ((completed: boolean) => void) | undefined {
    const scope = this.scopes.get(testId);
    if (!scope) return;
    const observations = scope.observations;
    const header =
      scope.correlationHeader !== undefined && Object.hasOwn(headers, scope.correlationHeader)
        ? headers[scope.correlationHeader]
        : undefined;
    const empty =
      header === undefined ||
      header === "" ||
      (Array.isArray(header) && header.length === 1 && header[0] === "");
    const key = empty ? "" : JSON.stringify(header);
    const matched = [...observations.values()].filter(({ expectation: { match } }) => {
      if (match.method !== undefined && match.method !== method.toUpperCase()) return false;
      if (typeof match.path === "string") return match.path === path;
      match.path.lastIndex = 0;
      return match.path.test(path);
    });
    if (!matched.length) return;
    const reservations: Array<{ claimed: Map<string, number>; prerequisites: readonly string[] }> =
      [];
    const causalReservations: Array<{
      pool: CausalOccurrences;
      ordinal: number;
      selection: CausalSelection;
    }> = [];
    for (const entry of matched) {
      entry.started++;
      const claimed = entry.claimed.get(key) ?? new Map<string, number>();
      const barrierMissing = entry.expectation.after!.some((id) => {
        const prerequisite = observations.get(id)!;
        return prerequisite.completed < prerequisite.expectation.count;
      });
      if (scope.causal) {
        const selection = barrierMissing
          ? undefined
          : entry.causal.reserve(
              entry.expectation.afterEach!.map((id) => observations.get(id)!.causal),
              key,
            );
        if (selection) {
          causalReservations.push({ pool: entry.causal, ordinal: entry.started, selection });
        } else entry.premature++;
      } else if (
        barrierMissing ||
        entry.expectation.afterEach!.some(
          (id) => (observations.get(id)!.completions.get(key) ?? 0) <= (claimed.get(id) ?? 0),
        )
      ) {
        entry.premature++;
      } else if (entry.expectation.afterEach!.length) {
        for (const id of entry.expectation.afterEach!) claimed.set(id, (claimed.get(id) ?? 0) + 1);
        entry.claimed.set(key, claimed);
        reservations.push({ claimed, prerequisites: entry.expectation.afterEach! });
      }
    }
    let settled = false;
    return (completed) => {
      if (settled) return;
      settled = true;
      for (const entry of matched) {
        if (completed) {
          entry.completed++;
          entry.completions.set(key, (entry.completions.get(key) ?? 0) + 1);
        } else entry.aborted++;
      }
      if (!completed) {
        for (const { claimed, prerequisites } of reservations) {
          for (const id of prerequisites) {
            claimed.set(id, claimed.get(id)! - 1);
          }
        }
      }
      for (const { pool, ordinal, selection } of causalReservations) {
        if (completed) pool.finish(key, ordinal, selection);
        else pool.release(selection);
      }
    };
  }
}
