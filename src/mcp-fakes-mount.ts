/**
 * Where MCP fakes go on a server (spec 5.2): find the mount that serves a
 * block's `mount` path, auto-mount an `MCPMock` when none does (W3, W6), and
 * the start-time hand-off of `ServiceFixtures.mcpFakes` (F2).
 */
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";
import type { McpFakeSource, Mountable } from "./types.js";
import { FixtureLoadError } from "./fixture-loader.js";
import { MCPMock } from "./mcp-mock.js";
import {
  MCP_FAKES_DEFAULT_MOUNT,
  McpFakeStore,
  McpFakesAddError,
  blockIdOf,
  type McpFakeIssue,
} from "./mcp-fakes.js";
import { build, msg, quote, type Message } from "./message-text.js";

export type MountList = Array<{ path: string; handler: Mountable }>;

/** Dependencies an auto-mount gets when it is created (after start: W4 wiring). */
export interface FakeMountWiring {
  journal?: Journal;
  registry?: MetricsRegistry;
  logger?: Logger;
}

/**
 * The control-API prefix. The server hands every request whose path starts
 * with it to the control API, before any mount, so no mount under it is
 * reachable.
 */
export const CONTROL_PREFIX = "/__aimock";

/**
 * What serves a block's `mount` path. A conflict is a path no fake there can
 * be served at: a mount that is not an MCPMock serves it first (`not-mcp`), an
 * MCPMock mounted at `mountPath` answers it as its root (`mcp-root`, the path
 * is `mountPath` plus a trailing "/"), or it is under the control prefix
 * (`control`).
 */
export type FakeMountTarget =
  | { kind: "mcp"; handler: Mountable }
  | { kind: "conflict"; mountPath: string; reason: "not-mcp" | "mcp-root" | "control" }
  | { kind: "none" };

/** The handlers an auto-mount created (W3, W6), whichever path created them. */
const autoMounts = new WeakSet<Mountable>();

/** `handler` was auto-mounted for MCP fakes (at start, after start or by the control API). */
export function isAutoMount(handler: Mountable): boolean {
  return autoMounts.has(handler);
}

/** A mount "is an MCPMock" for fakes if and only if it implements `addMcpFakes`. */
export function isFakeMount(handler: Mountable): boolean {
  return typeof handler.addMcpFakes === "function";
}

/**
 * The mount that serves `path`, in dispatch order: an MCPMock at exactly
 * `path`; a conflict when the path is under the control prefix, when a mount
 * that is not an MCPMock serves it first (it would shadow the fakes), or when
 * an MCPMock at `path` without its trailing "/" answers it as its root; none
 * when no mount serves it. An MCPMock mounted at a prefix of `path` lets any
 * other sub-path fall through, so it is skipped. `pending` are the paths an
 * add will auto-mount before this one, in order (they follow `mounts`).
 */
export function findFakeMount(
  mounts: MountList,
  path: string,
  pending: readonly string[] = [],
): FakeMountTarget {
  if (path.startsWith(CONTROL_PREFIX)) {
    return { kind: "conflict", mountPath: CONTROL_PREFIX, reason: "control" };
  }
  for (const { path: mountPath, handler } of mounts) {
    if (path !== mountPath && !path.startsWith(mountPath + "/")) continue;
    if (!isFakeMount(handler)) return { kind: "conflict", mountPath, reason: "not-mcp" };
    if (mountPath === path) return { kind: "mcp", handler };
    if (path === mountPath + "/") return { kind: "conflict", mountPath, reason: "mcp-root" };
  }
  for (const mountPath of pending) {
    if (path === mountPath + "/") return { kind: "conflict", mountPath, reason: "mcp-root" };
  }
  return { kind: "none" };
}

/** Why the fakes for `path` cannot be served there (no location prefix). */
export function mountConflictDetail(
  path: string,
  target: Extract<FakeMountTarget, { kind: "conflict" }>,
): Message {
  switch (target.reason) {
    case "control":
      return msg`mount ${quote(path)} is under the control API prefix ${quote(target.mountPath)}, which takes its requests first, so its fakes cannot be served`;
    case "mcp-root":
      return msg`mount ${quote(path)} is answered by the MCP mock at ${quote(target.mountPath)} as its root, so its fakes cannot be served`;
    case "not-mcp":
      return msg`mount ${quote(path)} is served by ${quote(target.mountPath)}, which is not an MCP mock, so its fakes cannot be served`;
  }
}

/** Wire, push and log (L4, L5) an auto-mounted MCPMock. */
function pushAutoMount(
  mounts: MountList,
  path: string,
  handler: MCPMock,
  wiring: FakeMountWiring,
  logger: Logger,
): void {
  if (wiring.journal) handler.setJournal(wiring.journal);
  if (wiring.registry) handler.setRegistry(wiring.registry);
  if (wiring.logger) handler.setLogger(wiring.logger);
  const others = mounts.filter((m) => m.path !== path && isFakeMount(m.handler));
  mounts.push({ path, handler });
  autoMounts.add(handler);
  logger.info(build(msg`MCP fakes: auto-mounted an MCP mock at ${quote(path)}`));
  for (const other of others) {
    logger.warn(
      build(
        msg`MCP fakes: auto-mounted an MCP mock at ${quote(path)} while an MCP mock is mounted at ${quote(other.path)}; fakes for one path do not reach the other`,
      ),
    );
  }
}

/**
 * The MCPMock for `path`: the one already mounted there, or a new one pushed
 * onto `mounts` (auto-mount, logs L4 and L5). A conflict is returned, not
 * thrown, so the caller can name the offending block.
 */
export function ensureFakeMount(
  mounts: MountList,
  path: string,
  wiring: FakeMountWiring,
  logger: Logger,
): { handler: Mountable; created: boolean } | { conflict: string } {
  const target = findFakeMount(mounts, path);
  if (target.kind === "conflict") return { conflict: target.mountPath };
  if (target.kind === "mcp") return { handler: target.handler, created: false };
  const handler = new MCPMock();
  pushAutoMount(mounts, path, handler, wiring, logger);
  return { handler, created: true };
}

/** A block's `mount` path, read without running getters; the add validates it. */
function mountOf(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return MCP_FAKES_DEFAULT_MOUNT;
  const value: unknown = Object.getOwnPropertyDescriptor(raw, "mount")?.value;
  return typeof value === "string" ? value : MCP_FAKES_DEFAULT_MOUNT;
}

/** The mount-conflict error for one file-origin block. */
export function mountConflictError(
  block: McpFakeSource,
  path: string,
  target: Extract<FakeMountTarget, { kind: "conflict" }>,
): FixtureLoadError {
  return new FixtureLoadError({
    rule: "mcp-fakes/mount-conflict",
    file: block.source,
    blockId: blockIdOf(block.source, "", block.blockIndex),
    entryId: null,
    detail: mountConflictDetail(path, target),
  });
}

/** Where a checked add of file blocks goes: each group by its `mount` path. */
export interface FileFakesPlan {
  /** Groups for a path an MCPMock already serves, with that mount. */
  onExisting: Array<{ handler: Mountable; group: McpFakeSource[] }>;
  /** Groups for a path no mount serves, in order: each gets an auto-mount. */
  onNew: Array<{ path: string; group: McpFakeSource[] }>;
  /** The add warnings (L8), as a throwaway store reports them. */
  warnings: McpFakeIssue[];
}

/**
 * Check file-origin `blocks` against `mounts` without changing anything:
 * group them by `mount` path (default `/mcp`), find each group's mount (a
 * mount conflict is one error per block), and add each group to a throwaway
 * store (bad blocks and id collisions inside the input). Throws one
 * `McpFakesAddError` holding every error. With `checked`, only the groups
 * that hold a checked block are checked, and only checked blocks get a
 * mount-conflict error (the others were checked before).
 */
export function planFileFakes(
  mounts: MountList,
  blocks: readonly McpFakeSource[],
  checked?: ReadonlySet<McpFakeSource>,
): FileFakesPlan {
  const groups = new Map<string, McpFakeSource[]>();
  for (const block of blocks) {
    const path = mountOf(block.raw);
    const group = groups.get(path);
    if (group) group.push(block);
    else groups.set(path, [block]);
  }

  const errors: FixtureLoadError[] = [];
  const warnings: McpFakeIssue[] = [];
  const plan: FileFakesPlan = { onExisting: [], onNew: [], warnings };
  for (const [path, group] of groups) {
    if (checked && !group.some((block) => checked.has(block))) continue;
    const target = findFakeMount(
      mounts,
      path,
      plan.onNew.map((g) => g.path),
    );
    if (target.kind === "conflict") {
      for (const block of group) {
        if (!checked || checked.has(block)) errors.push(mountConflictError(block, path, target));
      }
      continue;
    }
    try {
      warnings.push(...new McpFakeStore().add(group, { kind: "file" }).warnings);
    } catch (err) {
      if (!(err instanceof McpFakesAddError)) throw err;
      errors.push(...err.errors);
      warnings.push(...err.warnings);
      continue;
    }
    if (target.kind === "mcp") plan.onExisting.push({ handler: target.handler, group });
    else plan.onNew.push({ path, group });
  }
  if (errors.length > 0) throw new McpFakesAddError(errors, warnings);
  return plan;
}

/** A start-time hand-off: the auto-mounts are in place, the rest waits for `commit`. */
export interface McpFakesHandOff {
  /** Add the groups for existing MCPMocks (after the server listens). */
  commit(): void;
  /** Take the auto-mounts back off the mounts array (start failed). */
  undo(): void;
}

/**
 * Start-time hand-off (F2): check every block first (`planFileFakes`; on any
 * error, a bad block, an id collision or a mount conflict, throws one
 * `McpFakesAddError` holding every error and changes nothing). Then the
 * groups for paths no mount serves are added to new MCPMocks, pushed onto
 * `mounts` (auto-mount, L4, L5) so the mount loop wires them. The groups for
 * an MCPMock already mounted are added by `commit`, once the server listens,
 * so a start that fails after the hand-off leaves those mounts untouched;
 * `undo` removes the auto-mounts. The add warnings (L8) are logged at `warn`.
 */
export function handOffMcpFakes(
  mounts: MountList,
  blocks: McpFakeSource[],
  logger: Logger,
): McpFakesHandOff {
  const plan = planFileFakes(mounts, blocks);
  const created: Array<{ path: string; handler: MCPMock }> = [];
  for (const { path, group } of plan.onNew) {
    const handler = new MCPMock();
    for (const warning of handler.addMcpFakes(group, { kind: "file" }).warnings) {
      logger.warn(warning.message);
    }
    created.push({ path, handler });
  }
  for (const { path, handler } of created) pushAutoMount(mounts, path, handler, {}, logger);
  return {
    commit(): void {
      for (const { handler, group } of plan.onExisting) {
        const result = handler.addMcpFakes?.(group, { kind: "file" });
        for (const warning of result?.warnings ?? []) logger.warn(warning.message);
      }
    },
    undo(): void {
      for (const { handler } of created) {
        const at = mounts.findIndex((m) => m.handler === handler);
        if (at !== -1) mounts.splice(at, 1);
      }
    },
  };
}
