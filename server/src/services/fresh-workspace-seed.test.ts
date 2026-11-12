import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSeedCommit, materializeFreshWorkspaceSeed } from "./fresh-workspace-seed.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

describe("materializeFreshWorkspaceSeed commit availability", { timeout: 30_000 }, () => {
  let tmp: string;
  let upstream: string;
  let source: string;
  let previousHome: string | undefined;
  let n = 0;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "seed-test-"));
    previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = path.join(tmp, "home");
    upstream = path.join(tmp, "upstream");
    source = path.join(tmp, "source");
    execFileSync("git", ["init", "-q", "-b", "main", upstream]);
    writeFileSync(path.join(upstream, "a.txt"), "a");
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "one");
    git(upstream, "checkout", "-qb", "x");
    writeFileSync(path.join(upstream, "b.txt"), "b");
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "two");
    git(upstream, "checkout", "-q", "main");
    execFileSync("git", ["clone", "-q", upstream, source]);
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  const seed = (baseRef: string | null) =>
    materializeFreshWorkspaceSeed({ companyId: "c1", issueId: "i1", runId: `r${++n}`, sourceCwd: source, baseRef });

  it("seeds a commit reachable only through a remote-tracking ref", async () => {
    const sha = git(source, "rev-parse", "refs/remotes/origin/x");
    const dest = await seed("refs/remotes/origin/x");
    expect(git(dest, "rev-parse", "HEAD")).toBe(sha);
  });

  it("seeds a detached HEAD commit", async () => {
    git(source, "checkout", "-q", "--detach", "origin/x");
    const sha = git(source, "rev-parse", "HEAD");
    const dest = await seed(null);
    expect(git(dest, "rev-parse", "HEAD")).toBe(sha);
  });

  it("names the source clone and sha when the source lacks the commit", async () => {
    const staging = path.join(tmp, "staging");
    execFileSync("git", ["clone", "-q", "--no-checkout", source, staging]);
    const missing = "1".repeat(40);
    await expect(ensureSeedCommit(staging, source, missing, "refs/remotes/origin/nope")).rejects.toThrow(
      new RegExp(`${source}.*${missing}.*fetch the project clone`),
    );
  });
});
