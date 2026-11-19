/** Run-scoped path guard (PAR-9219 B.1-B.6) on real Postgres and a real file tree. Generated files only. */
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Viewer } from "../src/domain.js";
import { isDeniedPath, openRunFile, resolveRunRoots, type RunScopeReason } from "../src/drive/run-scope.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const CO = randomUUID(), CO_OTHER = randomUUID(), AGENT = randomUUID(), AGENT_OTHER = randomUUID();
const fdCount = () => readdirSync("/proc/self/fd").length;

describe.skipIf(!available)("run-scope", () => {
  let pg: PgHarness;
  let base: string, cwd: string, worktree: string, scratch: string, outside: string;

  beforeAll(async () => {
    pg = await startPg();
    await pg.client.query(`CREATE TABLE public.heartbeat_runs (id uuid PRIMARY KEY, company_id uuid NOT NULL, agent_id uuid NOT NULL, status text NOT NULL, context_snapshot jsonb, responsible_user_id text)`);
    base = realpathSync(mkdtempSync(join(tmpdir(), "drive-run-scope-")));
    [cwd, worktree, scratch, outside] = ["cwd", "worktree", "scratch", "outside"].map((d) => join(base, d));
    for (const d of [cwd, worktree, scratch, outside]) mkdirSync(d);
    writeFileSync(join(cwd, "a.txt"), "a");
    writeFileSync(join(worktree, "b.txt"), "b");
    writeFileSync(join(scratch, "c.mp4"), "c");
    writeFileSync(join(outside, "x.txt"), "x");
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
    rmSync(base, { recursive: true, force: true });
  });
  beforeEach(() => pg.client.query(`TRUNCATE public.heartbeat_runs`));

  let fdsBefore = 0;
  beforeEach(() => { fdsBefore = fdCount(); });
  // Every refusal closes its handle; accepted handles are closed by the test.
  afterEach(() => expect(fdCount()).toBe(fdsBefore));

  async function addRun(opts: { company?: string; agent?: string; status?: string; env?: unknown } = {}): Promise<string> {
    const id = randomUUID();
    const snapshot = {
      paperclipWorkspace: { cwd, worktreePath: worktree },
      paperclipScratch: { dir: scratch },
      ...(opts.env === undefined ? {} : { paperclipEnvironment: opts.env }),
    };
    await pg.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, context_snapshot) VALUES ($1, $2, $3, $4, $5)`, [id, opts.company ?? CO, opts.agent ?? AGENT, opts.status ?? "running", JSON.stringify(snapshot)]);
    return id;
  }
  const viewer = (runId: string | null): Viewer => ({ companyId: CO, userId: null, agentId: AGENT, role: null, runId });
  const roots = async () => {
    const r = await resolveRunRoots(pg.ctx, viewer(await addRun()));
    if (!r.ok) throw new Error(r.reason);
    return r.roots;
  };
  async function refusal(path: string): Promise<{ reason: RunScopeReason; hint: string }> {
    const r = await openRunFile(await roots(), path);
    if (r.ok) { await r.fh.close(); throw new Error("accepted"); }
    return r;
  }

  it("roots are the real cwd, worktree and scratch dir of a local running run", async () => {
    expect(await roots()).toEqual([cwd, worktree, scratch]);
    for (const env of [null, { driver: "local" }, { driver: "local", remoteCwd: null }]) {
      const r = await resolveRunRoots(pg.ctx, viewer(await addRun({ env })));
      expect(r.ok).toBe(true);
    }
  });

  it.each([
    ["not running", { status: "succeeded" }, "run_not_running"],
    ["another agent's run", { agent: AGENT_OTHER }, "run_other_agent"],
    ["another company's run", { company: CO_OTHER }, "run_other_company"],
    ["ssh driver", { env: { driver: "ssh" } }, "remote_run"],
    ["sandbox driver", { env: { driver: "sandbox" } }, "remote_run"],
    ["plugin driver", { env: { driver: "plugin" } }, "remote_run"],
    ["local with remoteCwd", { env: { driver: "local", remoteCwd: "/srv/x" } }, "remote_run"],
  ] as const)("refuses a run that is %s", async (_label, opts, reason) => {
    const r = await resolveRunRoots(pg.ctx, viewer(await addRun(opts)));
    expect(r).toMatchObject({ ok: false, code: "path_not_allowed", reason });
  });

  it("refuses no run id and an unknown run", async () => {
    expect(await resolveRunRoots(pg.ctx, viewer(null))).toMatchObject({ reason: "no_run" });
    expect(await resolveRunRoots(pg.ctx, viewer(randomUUID()))).toMatchObject({ reason: "run_not_found" });
  });

  it.each([["cwd", "a.txt"], ["worktree", "b.txt"], ["scratch", "c.mp4"]])("accepts a file in %s", async (dir, name) => {
    const r = await openRunFile(await roots(), join(base, dir, name));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.root).toBe(join(base, dir));
      expect(r.stat.size).toBe(1);
      await r.fh.close();
    }
  });

  it("a relative path resolves against the cwd", async () => {
    const r = await openRunFile(await roots(), "a.txt");
    expect(r.ok).toBe(true);
    if (r.ok) await r.fh.close();
  });

  it("refuses a symlink, a .. escape, a file outside, a hardlink, a directory and a missing file, each with its own reason", async () => {
    symlinkSync(join(outside, "x.txt"), join(cwd, "link.txt"));
    linkSync(join(outside, "x.txt"), join(scratch, "hard.txt"));
    mkdirSync(join(cwd, "sub"));
    const cases: Array<[string, RunScopeReason]> = [
      [join(cwd, "link.txt"), "symlink"],
      [`${cwd}/../outside/x.txt`, "dot_dot"],
      [join(outside, "x.txt"), "outside_roots"],
      [join(scratch, "hard.txt"), "hardlink"],
      [join(cwd, "sub"), "not_a_file"],
      [join(cwd, "nope.txt"), "missing"],
    ];
    for (const [path, reason] of cases) {
      const r = await refusal(path);
      expect(r.reason, path).toBe(reason);
      // A hint never echoes a resolved path outside the roots.
      expect(r.hint).not.toContain(outside);
      expect(r.hint).not.toContain(base);
    }
  });

  it("a symlinked directory inside a root that points outside is refused by the real path", async () => {
    symlinkSync(outside, join(worktree, "out"));
    expect((await refusal(join(worktree, "out", "x.txt"))).reason).toBe("outside_roots");
  });

  it.each([
    ["a dot segment", [".env", ".git/config", ".ssh/x"]],
    ["a key file", ["k.pem", "k.key", "k.p12", "k.pfx", "k.jks", "k.keystore"]],
    ["an ssh key", ["id_rsa", "id_rsa.pub", "id_ecdsa", "id_ed25519"]],
    ["a credential or secret", ["aws-credentials.txt", "my_secret.txt"]],
    ["an auth/token/service-account json", ["auth.json", "token-cache.json", "service-account-prod.json"]],
    ["an env file", ["prod.env"]],
  ])("deny-list refuses %s", async (_label, names) => {
    for (const name of names) {
      const p = join(scratch, name);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "s");
      const r = await refusal(p);
      expect(r.reason, name).toBe("secret_file");
      expect(r.hint).not.toContain(scratch);
    }
  });

  it("deny-list leaves ordinary names alone", () => {
    for (const rel of ["video.mp4", "out/report v2.pdf", "keys.txt", "notes.json"]) expect(isDeniedPath(rel), rel).toBe(false);
  });
});
