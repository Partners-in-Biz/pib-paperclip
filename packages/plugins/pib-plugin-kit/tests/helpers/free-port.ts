import { createServer } from "node:net";

/**
 * A free TCP port chosen by the OS. The test harnesses used a random number in a fixed range, which collides when many
 * suites start an embedded Postgres in parallel and overlaps the OS's own ephemeral ports: it made deploy gates flaky.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}
