import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { entryToFixture, validateFixtures } from "./fixture-loader.js";
import type { Fixture, FixtureFileEntry } from "./types.js";
import type { LiveOptions } from "./live-types.js";

export type FixtureModuleValue =
  | null
  | boolean
  | number
  | string
  | FixtureModuleValue[]
  | { [key: string]: FixtureModuleValue };

export interface FixtureModuleOptions {
  parameters?: Record<string, FixtureModuleValue>;
  maxFixtures?: number;
  maxDepth?: number;
}

export interface FixtureModuleInfo {
  name: string;
  filePath: string;
  fixtureCount: number;
  revision: number;
  files: string[];
  options: Required<FixtureModuleOptions>;
}

type JsonObject = { [key: string]: FixtureModuleValue };
type Bindings = Map<string, FixtureModuleValue>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nameIsValid(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function copyJson(value: unknown, ancestors = new Set<object>()): FixtureModuleValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) throw new Error("Expected a finite JSON value");
  if (ancestors.has(value)) throw new Error("Parameter values cannot contain cycles");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("Expected a JSON object");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item) => copyJson(item, ancestors));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copyJson(item, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function bindingObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error("Parameter bindings must be an object");
  return copyJson(value) as JsonObject;
}

function substitute(value: FixtureModuleValue, bindings: Bindings): FixtureModuleValue {
  if (Array.isArray(value)) return value.map((item) => substitute(item, bindings));
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$param") {
    const name = value.$param;
    if (!nameIsValid(name) || !bindings.has(name)) {
      throw new Error(`Unbound parameter: ${String(name)}`);
    }
    return copyJson(bindings.get(name));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, substitute(item, bindings)]),
  );
}

function moduleBindings(module: Record<string, unknown>, supplied: JsonObject): Bindings {
  const names: unknown = module.parameters === undefined ? [] : module.parameters;
  if (!Array.isArray(names) || names.some((name) => !nameIsValid(name))) {
    throw new Error("parameters must list nonblank names");
  }
  const declared = new Set<string>(names as string[]);
  if (declared.size !== names.length) throw new Error("Duplicate parameter declaration");
  const defaults = module.defaults === undefined ? {} : bindingObject(module.defaults);
  for (const key of [...Object.keys(defaults), ...Object.keys(supplied)]) {
    if (!declared.has(key)) throw new Error(`Undeclared parameter: ${key}`);
  }
  const bindings: Bindings = new Map();
  for (const name of declared) {
    if (Object.hasOwn(supplied, name)) bindings.set(name, supplied[name]);
    else if (Object.hasOwn(defaults, name)) bindings.set(name, defaults[name]);
    else throw new Error(`Missing parameter: ${name}`);
  }
  return bindings;
}

function limit(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

export function snapshotModuleOptions(
  options: FixtureModuleOptions = {},
): Required<FixtureModuleOptions> {
  return {
    maxFixtures: limit(options.maxFixtures, 10000, "maxFixtures"),
    maxDepth: limit(options.maxDepth, 64, "maxDepth"),
    parameters: options.parameters === undefined ? {} : bindingObject(options.parameters),
  };
}

export interface CompiledFixtureModule {
  fixtures: Fixture[];
  dependencies: Set<string>;
  files: Set<string>;
}

/** Compile dependencies together with fixtures so callers can publish both atomically. */
export function compileFixtureModule(
  filePath: string,
  options: FixtureModuleOptions = {},
  liveOptions?: LiveOptions,
): CompiledFixtureModule {
  const { maxFixtures, maxDepth, parameters } = snapshotModuleOptions(options);
  const active = new Set<string>();
  const dependencies = new Set<string>();
  const files = new Set<string>();
  const result: Fixture[] = [];

  function expand(path: string, supplied: JsonObject, depth: number): void {
    if (depth > maxDepth) throw new Error("Module include depth exceeded");
    const canonicalPath = realpathSync(path);
    if (active.has(canonicalPath)) throw new Error(`Module include cycle at ${path}`);
    active.add(canonicalPath);
    dependencies.add(path);
    dependencies.add(canonicalPath);
    files.add(canonicalPath);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(parsed) || !Array.isArray(parsed.fixtures)) {
        throw new Error("A module must have a fixtures array");
      }
      const bindings = moduleBindings(parsed, supplied);
      for (const raw of parsed.fixtures as unknown[]) {
        if (!isObject(raw)) throw new Error("Fixture entries must be objects");
        if (Object.hasOwn(raw, "include")) {
          if (
            typeof raw.include !== "string" ||
            raw.include.length === 0 ||
            Object.keys(raw).some((key) => key !== "include" && key !== "with")
          ) {
            throw new Error("Invalid include directive");
          }
          const args = raw.with === undefined ? {} : bindingObject(raw.with);
          const child = Object.fromEntries(
            Object.entries(args).map(([key, value]) => [key, substitute(value, bindings)]),
          );
          expand(resolve(dirname(path), raw.include), child, depth + 1);
          continue;
        }
        if (result.length >= maxFixtures) throw new Error("Module fixture limit exceeded");
        const entry = substitute(copyJson(raw), bindings);
        if (!isObject(entry) || !isObject(entry.match) || !isObject(entry.response)) {
          throw new Error("Fixture entries require match and response objects");
        }
        result.push(entryToFixture(entry as unknown as FixtureFileEntry, undefined, liveOptions));
      }
    } catch (error) {
      throw new Error(`Module ${path}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    } finally {
      active.delete(canonicalPath);
    }
  }

  expand(resolve(filePath), parameters, 0);
  const errors = validateFixtures(result, liveOptions).filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length) throw new Error(`Fixture validation failed: ${JSON.stringify(errors)}`);
  return { fixtures: result, dependencies, files };
}

/** Expand local modules before normalizing and validating the resulting fixtures. */
export function loadFixtureModule(filePath: string, options?: FixtureModuleOptions): Fixture[] {
  return compileFixtureModule(filePath, options).fixtures;
}
