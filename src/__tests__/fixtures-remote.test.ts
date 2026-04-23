import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Logger } from "../logger.js";
import {
  resolveFixturesValue,
  looksLikeUrl,
  defaultCacheRoot,
  REMOTE_FETCH_TIMEOUT_MS,
  REMOTE_MAX_BYTES,
  isPrivateAddress,
  assertAllowedHost,
} from "../fixtures-remote.js";

// All integration tests below hit 127.0.0.1 via ephemeral http servers.
// The SSRF denylist rejects private addresses by default; opt in for the
// whole file so fixture fetches against local test servers are allowed.
let prevAllowPrivate: string | undefined;
beforeAll(() => {
  prevAllowPrivate = process.env.AIMOCK_ALLOW_PRIVATE_URLS;
  process.env.AIMOCK_ALLOW_PRIVATE_URLS = "1";
});
afterAll(() => {
  if (prevAllowPrivate === undefined) delete process.env.AIMOCK_ALLOW_PRIVATE_URLS;
  else process.env.AIMOCK_ALLOW_PRIVATE_URLS = prevAllowPrivate;
});

const VALID_FIXTURE_JSON = JSON.stringify({
  fixtures: [
    {
      match: { userMessage: "hello" },
      response: { content: "Hello from remote!" },
    },
  ],
});

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aimock-remote-test-"));
}

interface FakeServerHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/**
 * Build a Logger whose `warn` writes into the provided sink. Uses a subclass so
 * the concrete `Logger` type is preserved without type casts.
 */
class CapturingLogger extends Logger {
  private sink: string[];
  constructor(sink: string[]) {
    super("silent");
    this.sink = sink;
  }
  warn(...args: unknown[]): void {
    this.sink.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }
}

function makeCapturingLogger(sink: string[]): Logger {
  return new CapturingLogger(sink);
}

function startFakeServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<FakeServerHandle> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        url,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

describe("looksLikeUrl", () => {
  it("recognizes http(s)/ftp/file schemes", () => {
    expect(looksLikeUrl("https://example.com/x.json")).toBe(true);
    expect(looksLikeUrl("http://example.com/x.json")).toBe(true);
    expect(looksLikeUrl("file:///tmp/x.json")).toBe(true);
    expect(looksLikeUrl("ftp://host/x.json")).toBe(true);
  });

  it("treats local paths as non-URL", () => {
    expect(looksLikeUrl("./fixtures")).toBe(false);
    expect(looksLikeUrl("/tmp/fixtures.json")).toBe(false);
    expect(looksLikeUrl("fixtures.json")).toBe(false);
    expect(looksLikeUrl("C:\\users\\foo\\fixtures.json")).toBe(false);
  });
});

describe("defaultCacheRoot", () => {
  it("honors XDG_CACHE_HOME when set", () => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/custom/xdg";
    try {
      expect(defaultCacheRoot()).toBe("/custom/xdg/aimock/fixtures");
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
});

describe("resolveFixturesValue: local path", () => {
  it("returns the resolved local path unchanged for filesystem inputs", async () => {
    const tmp = makeTmpDir();
    try {
      const file = join(tmp, "fx.json");
      writeFileSync(file, VALID_FIXTURE_JSON, "utf-8");
      const result = await resolveFixturesValue(file, {
        validateOnLoad: true,
        logger: new Logger("silent"),
      });
      expect(result.path).toBe(file);
      expect(result.source).toBe(file);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveFixturesValue: unsupported scheme", () => {
  it("rejects file:// scheme with a clear error", async () => {
    await expect(
      resolveFixturesValue("file:///tmp/foo.json", {
        validateOnLoad: true,
        logger: new Logger("silent"),
      }),
    ).rejects.toThrow(/Unsupported --fixtures URL scheme "file"/);
  });

  it("rejects ftp:// scheme with a clear error", async () => {
    await expect(
      resolveFixturesValue("ftp://host/foo.json", {
        validateOnLoad: true,
        logger: new Logger("silent"),
      }),
    ).rejects.toThrow(/Unsupported --fixtures URL scheme "ftp"/);
  });
});

describe("resolveFixturesValue: http(s) success", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("fetches JSON, caches to disk, and returns cached path", async () => {
    const server = await startFakeServer((_req, res) => {
      // 50ms delay to match test plan
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(VALID_FIXTURE_JSON);
      }, 50);
    });
    try {
      const url = `${server.url}/fixtures.json`;
      const result = await resolveFixturesValue(url, {
        validateOnLoad: true,
        logger: new Logger("silent"),
        cacheRoot: cacheDir,
      });
      expect(result.source).toBe(url);
      expect(result.path).toContain(cacheDir);
      expect(readFileSync(result.path, "utf-8")).toBe(VALID_FIXTURE_JSON);
    } finally {
      await server.close();
    }
  });
});

describe("resolveFixturesValue: http(s) failure modes", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("throws on HTTP 500 with no cache and validateOnLoad=true (fail loud)", async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    try {
      const url = `${server.url}/fx.json`;
      await expect(
        resolveFixturesValue(url, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
        }),
      ).rejects.toThrow(/Failed to fetch.*HTTP 500/);
    } finally {
      await server.close();
    }
  });

  it("returns empty path and warns without validateOnLoad when fetch fails and no cache", async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const warnLines: string[] = [];
    const logger: Logger = {
      info: () => {},
      warn: (msg: string) => warnLines.push(msg),
      error: () => {},
      debug: () => {},
    } as unknown as Logger;
    try {
      const url = `${server.url}/fx.json`;
      const result = await resolveFixturesValue(url, {
        validateOnLoad: false,
        logger,
        cacheRoot: cacheDir,
      });
      expect(result.path).toBe("");
      expect(warnLines.join("\n")).toMatch(/no cached copy/);
    } finally {
      await server.close();
    }
  });

  it("falls back to pre-seeded cache on fetch failure with validateOnLoad=true", async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    try {
      const url = `${server.url}/fx.json`;
      // Pre-seed cache with the same hashing convention used by the helper.
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256").update(url).digest("hex");
      const cachedDir = join(cacheDir, digest);
      mkdirSync(cachedDir, { recursive: true });
      const cachedFile = join(cachedDir, "fixtures.json");
      writeFileSync(cachedFile, VALID_FIXTURE_JSON, "utf-8");

      const warnLines: string[] = [];
      const logger = makeCapturingLogger(warnLines);

      const result = await resolveFixturesValue(url, {
        validateOnLoad: true,
        logger,
        cacheRoot: cacheDir,
      });
      expect(result.path).toBe(cachedFile);
      expect(existsSync(result.path)).toBe(true);
      expect(warnLines.join("\n")).toMatch(/using cached copy/);
    } finally {
      await server.close();
    }
  });

  it("times out with a fail-loud error when upstream never responds", async () => {
    // Start a server that accepts the connection but never writes a response.
    const server = await startFakeServer(() => {
      /* black hole */
    });
    try {
      const url = `${server.url}/fx.json`;
      await expect(
        resolveFixturesValue(url, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
          timeoutMs: 200,
        }),
      ).rejects.toThrow(/timed out after 200ms/);
    } finally {
      await server.close();
    }
  });

  it("rejects responses that exceed the max-size cap", async () => {
    const big = "x".repeat(4096);
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(big);
    });
    try {
      const url = `${server.url}/fx.json`;
      await expect(
        resolveFixturesValue(url, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
          maxBytes: 512,
        }),
      ).rejects.toThrow(/response too large/);
    } finally {
      await server.close();
    }
  });

  it("rejects oversized responses declared via content-length", async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": "999999999",
      });
      res.end("{}");
    });
    try {
      const url = `${server.url}/fx.json`;
      await expect(
        resolveFixturesValue(url, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
          maxBytes: 1024,
        }),
      ).rejects.toThrow(/response too large/);
    } finally {
      await server.close();
    }
  });

  it("throws on invalid JSON response with validateOnLoad=true", async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{ not valid json");
    });
    try {
      const url = `${server.url}/fx.json`;
      await expect(
        resolveFixturesValue(url, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
        }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});

/* ================================================================== */
/* Gap #5 — default timeout + max-bytes constants are exported         */
/* ================================================================== */

describe("fixtures-remote: exported defaults", () => {
  it("exposes a 10s default fetch timeout constant", () => {
    expect(REMOTE_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("exposes a 50 MB default max-body constant", () => {
    expect(REMOTE_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});

/* ================================================================== */
/* Gap #3 — lying Content-Length + oversized stream                    */
/* ================================================================== */

describe("resolveFixturesValue: lying Content-Length", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("enforces the byte cap incrementally when body streams past the cap via chunked encoding", async () => {
    // Chunked transfer-encoding (no Content-Length) is the real bypass vector:
    // the server can stream an unbounded body and there's no header-level size
    // hint.  The incremental check must abort mid-stream once the limit is hit.
    const maxBytes = 1024;
    const chunk = "x".repeat(4096); // single chunk exceeds the cap by 4x
    const server = await startFakeServer((_req, res) => {
      // Explicitly use chunked framing — do NOT set Content-Length.
      res.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      });
      // Write multiple chunks to force the incremental check to run against
      // partial totals rather than the whole body at once.
      res.write(chunk);
      res.write(chunk);
      res.write(chunk);
      res.end(chunk);
    });
    try {
      const url = `${server.url}/fx.json`;
      await expect(
        resolveFixturesValue(url, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
          maxBytes,
        }),
      ).rejects.toThrow(/response too large/);
    } finally {
      await server.close();
    }
  });

  it("rejects with a fail-loud error when Content-Length under-declares body size (truncation safety)", async () => {
    // A server that lies with a small CL header but emits a larger body
    // causes the client reader to truncate.  The CHANGELOG guarantee is
    // fail-loud behavior: invalid-JSON (the truncated payload) must throw
    // rather than silently succeed with a corrupted fixture.  The cap itself
    // is not bypassed in this scenario because Node's fetch bounds reads by
    // the declared Content-Length — this test pins the fail-loud contract.
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": "50",
      });
      // Body of valid JSON padded past the declared 50 bytes — client sees
      // only the first 50 bytes, which is truncated / invalid JSON.
      res.end('{"fixtures":[' + " ".repeat(4096) + "]}");
    });
    try {
      const url = `${server.url}/fx.json`;
      await expect(
        resolveFixturesValue(url, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
        }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});

/* ================================================================== */
/* Gap #1 — SSRF denylist                                              */
/* ================================================================== */

describe("isPrivateAddress: table-driven address classification", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "IPv4 loopback"],
    ["127.255.255.254", "IPv4 loopback end"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["10.255.255.255", "RFC1918 10/8 end"],
    ["172.16.0.1", "RFC1918 172.16/12"],
    ["172.31.255.255", "RFC1918 172.16/12 end"],
    ["192.168.0.1", "RFC1918 192.168/16"],
    ["169.254.169.254", "cloud metadata endpoint"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT 100.64/10"],
    ["198.18.0.1", "benchmarking 198.18/15"],
    ["0.0.0.0", "unspecified 0/8"],
    ["224.0.0.1", "multicast 224/4"],
    ["240.0.0.1", "reserved 240/4"],
    ["255.255.255.255", "broadcast"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 ULA"],
    ["fd12:3456::1", "IPv6 ULA fd"],
  ];

  const allowed: Array<[string, string]> = [
    ["8.8.8.8", "public Google DNS"],
    ["1.1.1.1", "public Cloudflare"],
    ["140.82.114.4", "public GitHub"],
    ["2606:4700::1111", "public IPv6 Cloudflare"],
  ];

  for (const [addr, label] of blocked) {
    it(`rejects ${addr} (${label}) as private`, () => {
      expect(isPrivateAddress(addr)).toBe(true);
    });
  }

  for (const [addr, label] of allowed) {
    it(`accepts ${addr} (${label}) as public`, () => {
      expect(isPrivateAddress(addr)).toBe(false);
    });
  }
});

describe("assertAllowedHost: env opt-out + denylist enforcement", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.AIMOCK_ALLOW_PRIVATE_URLS;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AIMOCK_ALLOW_PRIVATE_URLS;
    else process.env.AIMOCK_ALLOW_PRIVATE_URLS = savedEnv;
  });

  it("permits 127.0.0.1 when AIMOCK_ALLOW_PRIVATE_URLS=1", async () => {
    process.env.AIMOCK_ALLOW_PRIVATE_URLS = "1";
    await expect(assertAllowedHost("127.0.0.1")).resolves.toBeUndefined();
  });

  it("rejects 127.0.0.1 when AIMOCK_ALLOW_PRIVATE_URLS is unset", async () => {
    delete process.env.AIMOCK_ALLOW_PRIVATE_URLS;
    await expect(assertAllowedHost("127.0.0.1")).rejects.toThrow(/private address|not allowed/i);
  });

  it("rejects literal 169.254.169.254 (cloud metadata) by default", async () => {
    delete process.env.AIMOCK_ALLOW_PRIVATE_URLS;
    await expect(assertAllowedHost("169.254.169.254")).rejects.toThrow(
      /private address|not allowed/i,
    );
  });
});

describe("resolveFixturesValue: SSRF integration", () => {
  let cacheDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    cacheDir = makeTmpDir();
    savedEnv = process.env.AIMOCK_ALLOW_PRIVATE_URLS;
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.AIMOCK_ALLOW_PRIVATE_URLS;
    else process.env.AIMOCK_ALLOW_PRIVATE_URLS = savedEnv;
  });

  it("rejects http://169.254.169.254/ (cloud-metadata endpoint) without opt-out", async () => {
    delete process.env.AIMOCK_ALLOW_PRIVATE_URLS;
    await expect(
      resolveFixturesValue("http://169.254.169.254/latest/meta-data/", {
        validateOnLoad: true,
        logger: new Logger("silent"),
        cacheRoot: cacheDir,
      }),
    ).rejects.toThrow(/private address|not allowed/i);
  });

  it("rejects http://127.0.0.1:<port>/ without opt-out (even with a reachable server)", async () => {
    // Spin up a local server; even with it reachable the denylist must reject
    // the URL because AIMOCK_ALLOW_PRIVATE_URLS is unset.
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(VALID_FIXTURE_JSON);
    });
    try {
      delete process.env.AIMOCK_ALLOW_PRIVATE_URLS;
      await expect(
        resolveFixturesValue(`${server.url}/fx.json`, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
        }),
      ).rejects.toThrow(/private address|not allowed/i);
    } finally {
      await server.close();
    }
  });

  it("permits http://127.0.0.1:<port>/ when AIMOCK_ALLOW_PRIVATE_URLS=1", async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(VALID_FIXTURE_JSON);
    });
    try {
      process.env.AIMOCK_ALLOW_PRIVATE_URLS = "1";
      const result = await resolveFixturesValue(`${server.url}/fx.json`, {
        validateOnLoad: true,
        logger: new Logger("silent"),
        cacheRoot: cacheDir,
      });
      expect(result.path).toContain(cacheDir);
    } finally {
      await server.close();
    }
  });
});

/* ================================================================== */
/* Gap #2 — redirect rejection (fail loud, no scheme bypass)           */
/* ================================================================== */

describe("resolveFixturesValue: redirect rejection", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("rejects 302 → file:///... without following (scheme-bypass defense)", async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    });
    try {
      const url = `${server.url}/fx.json`;
      await expect(
        resolveFixturesValue(url, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
        }),
      ).rejects.toThrow(/redirect/i);
    } finally {
      await server.close();
    }
  });

  it("rejects 302 → https://other-allowed/ (redirects disabled entirely)", async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(302, { location: "https://example.invalid/other.json" });
      res.end();
    });
    try {
      const url = `${server.url}/fx.json`;
      await expect(
        resolveFixturesValue(url, {
          validateOnLoad: true,
          logger: new Logger("silent"),
          cacheRoot: cacheDir,
        }),
      ).rejects.toThrow(/redirect/i);
    } finally {
      await server.close();
    }
  });
});
