import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSshControlDir, sshControlDirFor } from "@paperclipai/adapter-utils/ssh";
import { sweepStaleSshConnectionDirsAtStartup } from "./ssh-connection-sweep.js";

const RUNNING = "11111111-2222-4333-8444-555555555555";
const FINISHED = "66666666-7777-4888-9999-000000000000";
const UNKNOWN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fakeDb(rows: Array<{ id: string; status: string }>) {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as never;
}

describe("startup ssh control directory sweep (PAR-9403 AC 3)", () => {
  it("removes dirs of finished and unknown runs, keeps the running run's dir", async () => {
    const root = await mkdtemp("/tmp/pcs-s");
    roots.push(root);
    const baseDir = path.join(root, "b");
    for (const runId of [RUNNING, FINISHED, UNKNOWN]) {
      expect(await prepareSshControlDir(runId, baseDir)).not.toBeNull();
    }

    const result = await sweepStaleSshConnectionDirsAtStartup(
      fakeDb([{ id: RUNNING, status: "running" }, { id: FINISHED, status: "succeeded" }]),
      { baseDir },
    );

    expect(result.kept).toEqual([RUNNING]);
    expect([...result.removed].sort()).toEqual([FINISHED, UNKNOWN].sort());
    expect(await readdir(baseDir)).toEqual([path.basename(sshControlDirFor(RUNNING, baseDir)!)]);
  });
});
