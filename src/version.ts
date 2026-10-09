/**
 * The aimock package version (C12), read lazily from the nearest
 * `@copilotkit/aimock` package.json above this module. Importing this module
 * never reads a file and never throws.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@copilotkit/aimock";
let cached: string | undefined;
let warned = false;

/** Nearest @copilotkit/aimock package.json above this module, or undefined. Never throws. */
function fromPackageJson(): string | undefined {
  try {
    // import.meta.url only (review r3 R3-1: a global __dirname, e.g. under
    // `node -e`, is not this module's dir). tsdown rewrites import.meta.url
    // for the CJS build.
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") return pkg.version;
      } catch {
        /* not here; keep walking up */
      }
      dir = dirname(dir);
    }
  } catch {
    /* no usable module URL */
  }
  return undefined;
}

/**
 * The aimock package version, for FA2 `recorded.aimockVersion`. Lazy: read on
 * first call (a recording write), never at import. "unknown" when no
 * package.json is reachable, with one warning per process.
 */
export function aimockVersion(warn: (message: string) => void = (m) => console.warn(m)): string {
  if (cached !== undefined) return cached;
  cached = fromPackageJson() ?? "unknown";
  if (cached === "unknown" && !warned) {
    warned = true;
    warn(
      `aimock: could not find the ${PACKAGE_NAME} package.json; recordings will carry aimockVersion "unknown"`,
    );
  }
  return cached;
}
