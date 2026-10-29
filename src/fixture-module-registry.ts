import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileFixtureModule,
  snapshotModuleOptions,
  type CompiledFixtureModule,
  type FixtureModuleOptions,
  type FixtureModuleInfo,
} from "./fixture-module.js";
import { observeFixtureQueue } from "./fixture-loader.js";
import type { Fixture } from "./types.js";
import type { LiveOptions } from "./live-types.js";

interface MountedModule extends CompiledFixtureModule {
  kind: "module";
  name: string;
  revision: number;
  path: string;
  options: FixtureModuleOptions;
}

interface UnmanagedFixtures {
  kind: "unmanaged";
  fixtures: Fixture[];
}

type Registration = MountedModule | UnmanagedFixtures;

function validateName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Module names must be nonblank strings");
  }
}

function changedIdentities(paths: readonly string[]): Set<string> {
  if (!Array.isArray(paths)) throw new Error("Changed paths must be an array");
  const identities = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("Changed paths must be nonempty strings");
    }
    const absolute = resolve(path);
    identities.add(absolute);
    // A removed dependency still selects its former owners by its original path.
    try {
      identities.add(realpathSync(absolute));
    } catch {
      // The changed path need not exist; compilation validates selected roots.
    }
  }
  return identities;
}

/** Tracks registration positions, including modules that currently emit no fixtures. */
export class FixtureModuleRegistry {
  private modules = new Map<string, MountedModule>();
  private registrations: Registration[];

  constructor(
    private readonly queue: Fixture[],
    private readonly liveOptions?: LiveOptions,
    private readonly prepare: (fixtures: Fixture[]) => Fixture[] = (fixtures) => fixtures,
  ) {
    this.registrations = [{ kind: "unmanaged", fixtures: [...queue] }];
    observeFixtureQueue(queue, {
      append: (fixtures) => this.registrations.push({ kind: "unmanaged", fixtures }),
      prepend: (fixtures) => this.registrations.unshift({ kind: "unmanaged", fixtures }),
      remove: (fixture) => {
        this.registrations = this.registrations.flatMap<Registration>((entry) => {
          if (entry.kind === "module") return [entry];
          const fixtures = entry.fixtures.filter((item) => item !== fixture);
          return fixtures.length ? [{ kind: "unmanaged" as const, fixtures }] : [];
        });
      },
      clear: () => {
        this.modules.clear();
        this.registrations = [];
      },
    });
  }

  mount(name: string, filePath: string, options?: FixtureModuleOptions): void {
    validateName(name);
    const path = resolve(filePath);
    const savedOptions = snapshotModuleOptions(options);
    const compiled = compileFixtureModule(path, savedOptions, this.liveOptions);
    compiled.fixtures = this.prepare(compiled.fixtures);
    const previous = this.modules.get(name);
    const mounted: MountedModule = {
      kind: "module",
      name,
      path,
      options: savedOptions,
      revision: (previous?.revision ?? 0) + 1,
      ...compiled,
    };
    const registrations = previous
      ? this.registrations.map((entry) => (entry === previous ? mounted : entry))
      : [...this.registrations, mounted];
    const modules = new Map(this.modules);
    modules.set(name, mounted);
    this.publish(registrations, modules);
  }

  reload(changedPaths?: readonly string[]): number {
    const changed = changedPaths === undefined ? undefined : changedIdentities(changedPaths);
    const replacements = new Map<MountedModule, MountedModule>();
    for (const mounted of this.modules.values()) {
      if (changed && ![...mounted.dependencies].some((path) => changed.has(path))) continue;
      const compiled = compileFixtureModule(mounted.path, mounted.options, this.liveOptions);
      compiled.fixtures = this.prepare(compiled.fixtures);
      replacements.set(mounted, { ...mounted, ...compiled, revision: mounted.revision + 1 });
    }
    if (replacements.size === 0) return 0;
    const registrations = this.registrations.map((entry) =>
      entry.kind === "module" ? (replacements.get(entry) ?? entry) : entry,
    );
    const modules = new Map(this.modules);
    for (const mounted of replacements.values()) modules.set(mounted.name, mounted);
    this.publish(registrations, modules);
    return replacements.size;
  }

  unmount(name: string): boolean {
    validateName(name);
    const mounted = this.modules.get(name);
    if (!mounted) return false;
    const registrations = this.registrations.filter((entry) => entry !== mounted);
    const modules = new Map(this.modules);
    modules.delete(name);
    this.publish(registrations, modules);
    return true;
  }

  list(): FixtureModuleInfo[] {
    return [...this.modules.values()].map((mounted) => ({
      name: mounted.name,
      filePath: mounted.path,
      fixtureCount: mounted.fixtures.length,
      revision: mounted.revision,
      files: [...mounted.files],
      options: snapshotModuleOptions(mounted.options),
    }));
  }

  private publish(registrations: Registration[], modules: Map<string, MountedModule>): void {
    const next: Fixture[] = [];
    for (const entry of registrations) {
      for (const fixture of entry.fixtures) next.push(fixture);
    }
    for (let index = 0; index < next.length; index++) this.queue[index] = next[index];
    this.queue.length = next.length;
    this.registrations = registrations;
    this.modules = modules;
  }
}
