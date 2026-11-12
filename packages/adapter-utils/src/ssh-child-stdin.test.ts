import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route `ssh` (and optionally `tar`) to real short-lived local children so the
// stdin pipes, EPIPE and exit ordering are real.
const fakes = vi.hoisted(() => ({
  routes: {} as Record<string, [string, string[]]>,
  children: [] as Array<{ file: string; child: ChildProcess }>,
  readStreams: [] as ReadStream[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      const route = fakes.routes[file];
      const child = route ? actual.spawn(route[0], route[1], options) : actual.spawn(file, args, options);
      fakes.children.push({ file, child });
      return child;
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: vi.fn((...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      fakes.readStreams.push(stream);
      return stream;
    }),
  };
});

import { runSshCommand, streamLocalFileToSsh, syncDirectoryFromSsh, syncDirectoryToSsh } from "./ssh.js";

const node = process.execPath;
const spec = { host: "fake", port: 22, username: "u", remoteWorkspacePath: "/r", remoteCwd: "/r", privateKey: null, knownHosts: null, strictHostKeyChecking: false };
// Writes zeros to stdout until killed.
const ENDLESS_WRITER = "const b=Buffer.alloc(65536);(function w(){while(process.stdout.write(b));process.stdout.once('drain',w)})()";

const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => uncaught.push(error);
const roots: string[] = [];

beforeEach(() => {
  uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
});

afterEach(async () => {
  process.off("uncaughtException", onUncaught);
  for (const { child } of fakes.children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  fakes.readStreams.splice(0);
  for (const key of Object.keys(fakes.routes)) delete fakes.routes[key];
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ssh-child-stdin-"));
  roots.push(dir);
  return dir;
}

function exited(file: string) {
  return fakes.children
    .filter((entry) => entry.file === file)
    .every(({ child }) => child.exitCode !== null || child.signalCode !== null);
}

async function settle(promise: Promise<unknown>) {
  return await promise.then(() => null, (error: Error) => error);
}

describe("child stdin on the ssh path", () => {
  it("(a) spawnText: 1 MB into a child that exits at once settles with no uncaught error", async () => {
    fakes.routes.ssh = [node, ["-e", "process.exit(0)"]];
    await settle(runSshCommand(spec, "true", { stdin: "x".repeat(1024 * 1024) }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(uncaught).toEqual([]);
  }, 10_000);

  it("(j) syncDirectoryToSsh reports ssh's own error, not EPIPE, and stops tar", async () => {
    const localDir = await tempDir();
    await writeFile(path.join(localDir, "big.bin"), randomBytes(1536 * 1024));
    fakes.routes.ssh = [node, ["-e", "process.stderr.write('Permission denied (publickey).\\n');process.exit(1)"]];
    const error = await settle(syncDirectoryToSsh({ spec, localDir, remoteDir: "/r" }));
    expect(error?.message).toContain("Permission denied");
    expect(error?.message).not.toContain("EPIPE");
    expect(uncaught).toEqual([]);
    expect(exited("tar")).toBe(true);
  }, 10_000);

  it("(k) syncDirectoryFromSsh reports tar's error and stops ssh", async () => {
    const localDir = await tempDir();
    fakes.routes.ssh = [node, ["-e", ENDLESS_WRITER]];
    fakes.routes.tar = [node, ["-e", "process.stderr.write('tar: bad archive\\n');process.exit(2)"]];
    const error = await settle(syncDirectoryFromSsh({ spec, remoteDir: "/r", localDir }));
    expect(error?.message).toContain("tar: bad archive");
    expect(uncaught).toEqual([]);
    expect(exited("ssh")).toBe(true);
  }, 10_000);

  it("(b) streamLocalFileToSsh settles and destroys the source when ssh closes early", async () => {
    const dir = await tempDir();
    const localFile = path.join(dir, "bundle");
    await writeFile(localFile, randomBytes(2 * 1024 * 1024));
    fakes.routes.ssh = [node, ["-e", "process.stderr.write('Connection reset\\n');process.exit(255)"]];
    const error = await settle(streamLocalFileToSsh({ spec, localFile, remoteScript: "cat >/dev/null" }));
    expect(error?.message).toContain("Connection reset");
    expect(fakes.readStreams).toHaveLength(1);
    expect(fakes.readStreams[0]!.destroyed).toBe(true);
    expect(uncaught).toEqual([]);
  }, 10_000);
});
