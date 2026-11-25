/**
 * PAR-9262 (PAR-9219 A): drive_file_save with `path`. One test per decision-table cell, then a 50 MiB save through the
 * CRM tool on the SDK harness, with Google's resumable upload faked in memory. Generated files only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({ openRunFile: undefined as unknown as ReturnType<typeof import("vitest").vi.fn> }));
vi.mock("../src/drive/run-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/drive/run-scope.js")>();
  spy.openRunFile = vi.fn(actual.openRunFile);
  return { ...actual, openRunFile: spy.openRunFile };
});

import { boot } from "./helpers/crm.js";
import { saveDriveFile, OVER_5MB_PATH_HINT } from "../src/drive/save.js";
import { driveJobStatus, resetDriveJobsForTests, TEXTS } from "../src/drive/jobs.js";
import { resetTransferSlotsForTests } from "../src/drive/transfer-slots.js";
import { OUTSIDE_HINT } from "../src/drive/run-scope.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { DRIVE_ID, KEY_JSON, fakeGoogle, uploadsOf } from "./support/fake-google-drive.js";

const MiB = 1024 * 1024;
const CO = randomUUID(), AG = randomUUID(), RUN = randomUUID();
const NATIVE = { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: DRIVE_ID } };
const PATH_HINT = "Path not allowed: source must be a file inside the permitted drive root";
const SECRET_HINT = "This looks like a secret or settings file, so it is not sent to Drive.";
const NOT_RUNNING_HINT = "Saving or fetching by path works only from a run of yours that is still running.";
const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SECRETSESSION";
const SIZES = { small: 1024, mid: 6 * MiB, big: 200 * MiB + 1 } as const;
type Size = keyof typeof SIZES;

let base: string, old: string, ws: string, scratch: string;
const run = { status: "running", env: null as unknown };

/** Google's resumable upload host: checks each Content-Range and the final sha256, records the session DELETE. */
function uploadHost() {
  const google = fakeGoogle();
  const host = { google, starts: 0, deletes: 0, onStart: undefined as undefined | (() => void) };
  let size = 0, offset = 0, hash = createHash("sha256"), meta: any = null;
  const fetchFn = async (url: string, init: any = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    if (url === SESSION) {
      if (method === "DELETE") return host.deletes++, new Response(null, { status: 204 });
      const body = init.body as Uint8Array;
      expect(init.headers["Content-Range"]).toBe(`bytes ${offset}-${offset + body.byteLength - 1}/${size}`);
      hash.update(body);
      offset += body.byteLength;
      if (offset < size) return new Response("", { status: 308, headers: { range: `bytes=0-${offset - 1}` } });
      expect(hash.digest("hex")).toBe(meta.appProperties.pibSha256);
      const f = { id: `big${host.starts}`, name: meta.name, mimeType: "video/mp4", parents: meta.parents, appProperties: meta.appProperties, size: String(size) };
      google.files.push(f);
      return new Response(JSON.stringify({ ...f, webViewLink: `https://drive.google.com/file/d/${f.id}/view` }), { status: 200 });
    }
    if (url.includes("/upload/drive/v3/files?uploadType=resumable") && method === "POST") {
      host.starts++;
      meta = JSON.parse(init.body);
      size = Number(init.headers["X-Upload-Content-Length"]);
      offset = 0;
      hash = createHash("sha256");
      host.onStart?.();
      return new Response("", { status: 200, headers: { location: SESSION } });
    }
    return google.fetchFn(url, init);
  };
  return { ...host, fetchFn, get: () => host };
}

/** heartbeat_runs as the host keeps it, for the one run of this test agent. */
const runsRoute = [/FROM public\.heartbeat_runs/, (p: unknown[], _s: unknown, sql: string) => {
  if (p[0] !== RUN) return [];
  if (/same_company/.test(sql)) return [{ same_company: p[1] === CO }];
  if (p[1] !== CO || p[2] !== AG) return [];
  return [{ status: run.status, cwd: ws, worktree_path: null, scratch_dir: scratch, environment: run.env, responsible_user_id: null }];
}] as const;

async function setup() {
  const host = uploadHost();
  const { harness } = await boot({ config: NATIVE, routes: [runsRoute as never] });
  harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Video" } as never] });
  vi.stubGlobal("fetch", host.fetchFn);
  return { harness, host: host.get() };
}

const viewer = (runId: string | null = RUN) => ({ companyId: CO, userId: null, agentId: AG, role: null, runId });
const input = (path: string, name = "2026-11-11 clip v01.mp4") => ({ companyId: CO, projectId: "p1", fileKind: "marketing", name, mimeType: "video/mp4", path });
let n = 0;
function file(dir: string, size: Size, name = `f${++n}.mp4`): string {
  const path = join(dir, name);
  if (size === "big") writeFileSync(path, ""), truncateSync(path, SIZES.big); // sparse: no 200 MiB on disk
  else writeFileSync(path, randomBytes(SIZES[size]));
  return path;
}
async function settle(jobId: string) {
  for (let i = 0; i < 400; i++) {
    const s = driveJobStatus({ companyId: CO, agentId: AG, runId: RUN }, jobId);
    if (s.status !== "running") return s as any;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job did not settle");
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "drive-path-save-")));
  [old, ws, scratch] = [join(base, "old"), join(base, "old", "ws"), join(base, "scratch")];
  for (const d of [old, ws, scratch, join(scratch, "dir")]) mkdirSync(d, { recursive: true });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => {
  clearServiceAccountTokenCache();
  resetDriveJobsForTests();
  resetTransferSlotsForTests();
  Object.assign(run, { status: "running", env: null });
  spy.openRunFile.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("the path decision table (one test per cell)", () => {
  const save = async (path: string, runId: string | null = RUN) => {
    const { harness } = await setup();
    return { harness, r: await saveDriveFile(harness.ctx, viewer(runId), input(path, `2026-11-11 c${++n} v01.mp4`), { allowedRoots: [old] }) };
  };

  it("row 1, <= 5 MiB, old root only: saved inline, unchanged, no run file opened", async () => {
    expect((await save(file(old, "small"))).r).toMatchObject({ status: "saved", duplicate: false });
    expect(spy.openRunFile).not.toHaveBeenCalled();
  });
  it.each(["mid", "big"] as const)("row 1, %s, old root only: too_large (status unchanged) with the over-5-MB hint", async (size) => {
    expect((await save(file(old, size))).r).toEqual({ status: "too_large", hint: OVER_5MB_PATH_HINT });
  });

  it("row 2, <= 5 MiB, old root and run root: saved inline through the old root", async () => {
    expect((await save(file(ws, "small"))).r).toMatchObject({ status: "saved" });
    expect(spy.openRunFile).not.toHaveBeenCalled();
  });
  it.each([["row 2", () => ws], ["row 3", () => scratch]] as const)("%s, 5 to 200 MiB: a job that reaches done", async (_row, dir) => {
    const { r } = await save(file(dir(), "mid"));
    expect(r).toMatchObject({ status: "started", bytesTotal: SIZES.mid });
    expect(await settle(r.jobId!)).toMatchObject({ status: "done", result: { status: "saved", duplicate: false } });
  });
  it.each([["row 2", () => ws], ["row 3", () => scratch]] as const)("%s, over 200 MiB (sparse): too_large naming 200 MB", async (_row, dir) => {
    const { r } = await save(file(dir(), "big"));
    expect(r.status).toBe("too_large");
    expect(r.hint).toContain("200 MB");
  });
  it("row 3, <= 5 MiB, run root only: saved inline through openRunFile (fd), not the old root", async () => {
    expect((await save(file(scratch, "small"))).r).toMatchObject({ status: "saved" });
    expect(spy.openRunFile).toHaveBeenCalledTimes(1);
  });

  it.each(["small", "mid", "big"] as const)("row 4, %s, deny-listed in the run root: path_not_allowed with the secret hint", async (size) => {
    expect((await save(file(scratch, size, `k${++n}.pem`))).r).toEqual({ status: "path_not_allowed", hint: SECRET_HINT });
    expect((await save(file(join(scratch, "dir"), size, `.env${++n}`))).r.status).toBe("path_not_allowed");
  });

  it.each(["small", "mid", "big"] as const)("row 5, %s, run not running / remote: path_not_allowed naming the reason", async (size) => {
    run.status = "succeeded";
    expect((await save(file(scratch, size))).r).toEqual({ status: "path_not_allowed", hint: NOT_RUNNING_HINT });
    Object.assign(run, { status: "running", env: { driver: "ssh", remoteCwd: "/w" } });
    expect((await save(file(scratch, size))).r).toMatchObject({ status: "path_not_allowed", hint: expect.stringMatching(/remote environment/) });
  });

  it.each(["small", "mid", "big"] as const)("row 6, %s, no runId outside the old root: today's exact result and no DB query", async (size) => {
    const { harness } = await setup();
    const query = vi.spyOn(harness.ctx.db, "query");
    const r = await saveDriveFile(harness.ctx, viewer(null), input(file(scratch, size)), { allowedRoots: [old] });
    expect(r).toEqual({ status: "path_not_allowed", hint: PATH_HINT });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([[RUN], [null]])("row 7, runId %s: a missing file or a directory is path_not_allowed", async (runId) => {
    for (const path of [join(scratch, "nope.mp4"), join(scratch, "dir"), join(old, "nope.mp4")]) {
      const { r } = await save(path, runId);
      expect(r.status).toBe("path_not_allowed");
      expect(JSON.stringify(r)).not.toContain(base);
    }
  });

  it("a run caller's file outside every root names the rule, never the path", async () => {
    const { r } = await save(join(tmpdir(), "x.mp4"));
    expect(r).toEqual({ status: "path_not_allowed", hint: expect.stringContaining(OUTSIDE_HINT) });
  });
});

describe("drive_file_save over the tool, 50 MiB from the run's scratch dir", () => {
  const RUN_CTX = { companyId: CO, agentId: AG, runId: RUN };
  const call = async (harness: any, name: string, params: Record<string, unknown>) => (await harness.executeTool(name, params, RUN_CTX)).data;
  const params = (path: string, name = "2026-11-11 big clip v01.mp4") => ({ projectId: "p1", fileKind: "marketing", name, mimeType: "video/mp4", path });
  async function untilDone(harness: any, jobId: string) {
    for (let i = 0; i < 600; i++) {
      const s = await call(harness, "drive_transfer_status", { jobId });
      if (s.status !== "running") return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("job did not settle");
  }

  it("starts in under 1 s, reaches done with the url, a second save is a duplicate, and nothing secret leaks", async () => {
    const { harness, host } = await setup();
    const bytes = randomBytes(50 * MiB);
    const path = join(scratch, "big.mp4");
    writeFileSync(path, bytes);
    const t0 = performance.now();
    const started = await call(harness, "drive_file_save", params(path));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(started).toMatchObject({ status: "started", bytesTotal: 50 * MiB, hint: expect.stringMatching(/drive_transfer_status/) });

    const done = await untilDone(harness, started.jobId);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(done).toMatchObject({ status: "done", bytesDone: 50 * MiB, result: { status: "saved", sha256, duplicate: false, url: "https://drive.google.com/file/d/big1/view" } });
    expect(uploadsOf(host.google.files)).toHaveLength(1);

    const again = await call(harness, "drive_file_save", params(path));
    expect(await untilDone(harness, again.jobId)).toMatchObject({ status: "done", result: { duplicate: true, url: done.result.url } });
    expect(host.starts).toBe(1);

    const seen = JSON.stringify([started, done, again, harness.logs]);
    for (const secret of ["upload_id", "SECRETSESSION", "Bearer", "ya29", "X-Amz-"]) expect(seen).not.toContain(secret);
  }, 60_000);

  it("a file rewritten between the hash pass and the upload fails as file_changed and the session is deleted", async () => {
    const { harness, host } = await setup();
    const path = join(scratch, "changing.mp4");
    writeFileSync(path, randomBytes(12 * MiB));
    host.onStart = () => writeFileSync(path, randomBytes(12 * MiB));
    const started = await call(harness, "drive_file_save", params(path, "2026-11-11 changing v01.mp4"));
    const failed = await untilDone(harness, started.jobId);
    expect(failed).toMatchObject({ status: "failed", code: "file_changed", hint: TEXTS.fileChanged });
    expect(host.deletes).toBe(1);
    expect(uploadsOf(host.google.files)).toHaveLength(0);
    expect(JSON.stringify([failed, harness.logs])).not.toContain("SECRETSESSION");
  }, 60_000);

  it("over 200 MiB (sparse) is too_large with a hint naming 200 MB", async () => {
    const { harness, host } = await setup();
    const path = join(scratch, "huge.mp4");
    writeFileSync(path, "");
    truncateSync(path, 200 * MiB + 1);
    const r = await call(harness, "drive_file_save", params(path, "2026-11-11 huge v01.mp4"));
    expect(r).toMatchObject({ status: "too_large", hint: expect.stringContaining("200 MB") });
    expect(host.starts).toBe(0);
  });
});
