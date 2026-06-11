import * as net from "node:net";

/**
 * An upstream URL that deterministically refuses every request: the port is
 * HELD for the lifetime of the suite by a live server that destroys each
 * connection the moment it arrives. Unlike the old bind-then-release pattern
 * (reserve a port, close the listener, hand out the URL), there is no TOCTOU
 * window in which another process — or a parallel test file doing the same
 * dance — could re-bind the port and start answering. Callers must close the
 * returned server in `afterAll`.
 */
export function startRefusingUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
