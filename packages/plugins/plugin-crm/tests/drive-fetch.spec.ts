/**
 * PAR-9263 (PAR-9219 D): drive_file_fetch into the run's scratch dir. Drive is a fake broker that streams a generated
 * body; the run row is faked like heartbeat_runs; the scratch dir is a temp dir. Generated data only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const tools = vi.hoisted(() => ({
  driveFolderEnsure: vi.fn(async () => ({ status: "exists", folder_id: "projFolder", path: "Clients/A", tree: [{ path: "Clients/A/Deliverables", folderId: "subFolder" }] })),
  createBrokerForCompany: vi.fn(async () => null),
}));
vi.mock("../src/drive/tools.js", () => tools);

import { driveFileFetch, safeName, FETCH_DISK_MARGIN_BYTES, type FetchDeps } from "../src/drive/fetch.js";
import { driveJobStatus, resetDriveJobsForTests, TEXTS } from "../src/drive/jobs.js";
import { resetTransferSlotsForTests } from "../src/drive/transfer-slots.js";
import { BrokerError, type Broker, type DriveFileInfo } from "../src/drive/broker.js";

const MiB = 1024 * 1024;
const CO = randomUUID(), AG = randomUUID(), RUN = randomUUID();
const ID = "fileAAAAAAAAAAAA";
const BODY = randomBytes(50 * MiB);
const SHA = createHash("sha256").update(BODY).digest("hex");
const SECRET = "Bearer ya29.SECRET upload_id=SESSION X-Amz-Signature=abc";

const base = realpathSync(mkdtempSync(join(tmpdir(), "drive-fetch-spec-")));
const scratch = join(base, "scratch"), outside = join(base, "outside");
mkdirSync(scratch);
mkdirSync(outside);
afterAll(() => rmSync(base, { recursive: true, force: true }));

const run = { status: "running", env: null as unknown, scratch: scratch as string | null };
const logs: unknown[] = [];
const log = (...a: unknown[]) => void logs.push(a);
const ctx = {
  db: {
    query: async (sql: string, p: unknown[]) => {
      if (/same_company/.test(sql)) return p[0] === RUN ? [{ same_company: p[1] === CO }] : [];
      if (p[0] !== RUN || p[1] !== CO || p[2] !== AG) return [];
      return [{ status: run.status, cwd: null, worktree_path: null, scratch_dir: run.scratch, environment: run.env }];
    },
  },
  projects: { get: async (id: string) => (id === "p1" ? { id } : null) },
  logger: { info: vi.fn(log), warn: vi.fn(log), error: vi.fn(log), debug: vi.fn(log) },
} as any;
const viewer = (runId: string | null = RUN) => ({ companyId: CO, userId: null, agentId: AG, role: "agent", runId });

let meta: DriveFileInfo;
let body: Buffer;
let broker: Broker;
const stream = (bytes: Buffer, piece = 1 * MiB) => {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(new Uint8Array(bytes.subarray(at, at + piece)));
      at += piece;
    },
  });
};
const roomy: FetchDeps["statfs"] = async () => ({ bavail: 1e12, bsize: 1 });
const deps = (extra: FetchDeps = {}): FetchDeps => ({ brokerFor: async () => broker, statfs: roomy, ...extra });

beforeEach(() => {
  resetDriveJobsForTests();
  resetTransferSlotsForTests();
  Object.assign(run, { status: "running", env: null, scratch });
  logs.length = 0;
  body = BODY;
  meta = { id: ID, name: "2026-11-11 test video v01.mp4", mimeType: "video/mp4", size: BODY.length, parents: ["subFolder"], sha256: SHA };
  broker = {
    fileMeta: vi.fn(async (id: string) => (id === ID ? meta : null)),
    downloadStream: vi.fn(async () => ({ body: stream(body), size: null })),
  } as unknown as Broker;
});

async function settle(jobId: string, runId: string = RUN) {
  for (let i = 0; i < 2000; i++) {
    const s = driveJobStatus({ companyId: CO, agentId: AG, runId }, jobId) as any;
    if (s.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not settle");
}
const fetchFile = async (extra?: FetchDeps, v = viewer()) => driveFileFetch(ctx, v, { projectId: "p1", fileId: ID }, deps(extra)) as Promise<any>;
const jobDirs = () => readdirSync(scratch).filter((d) => d.startsWith("drive-fetch-"));
const clean = () => {
  for (const d of readdirSync(scratch)) rmSync(join(scratch, d), { recursive: true, force: true });
};
const noSecrets = (v: unknown) => expect(JSON.stringify(v)).not.toMatch(/Bearer|upload_id=|X-Amz-|SECRET/);

describe("drive_file_fetch: the happy path", () => {
  it("lands a 50 MiB file in <scratch>/drive-fetch-*/<name> with a matching sha256", async () => {
    clean();
    const started = await fetchFile();
    expect(started).toMatchObject({ status: "started", bytesTotal: BODY.length, hint: expect.stringMatching(/drive_transfer_status/) });
    const done = await settle(started.jobId);
    expect(done.status).toBe("done");
    const r = done.result;
    expect(r).toEqual({ path: expect.any(String), size: BODY.length, sha256: SHA, name: meta.name, mimeType: "video/mp4", runId: RUN });
    expect(dirname(dirname(r.path))).toBe(scratch);
    expect(basename(dirname(r.path))).toMatch(/^drive-fetch-/);
    expect(basename(r.path)).toBe(meta.name);
    expect(createHash("sha256").update(readFileSync(r.path)).digest("hex")).toBe(SHA);
    // No .part, no second file: the dir holds only the file.
    expect(readdirSync(dirname(r.path))).toEqual([meta.name]);
    noSecrets(done);
  });

  it("gives every job a fresh dir, so a second fetch never overwrites the first", async () => {
    clean();
    const a = await settle((await fetchFile()).jobId);
    const b = await settle((await fetchFile()).jobId);
    expect(a.result.path).not.toBe(b.result.path);
    expect(jobDirs()).toHaveLength(2);
  });

  it("takes a file in the project folder itself, and one with no stored sha256", async () => {
    meta = { ...meta, parents: ["projFolder"], sha256: undefined };
    expect((await settle((await fetchFile()).jobId)).status).toBe("done");
  });
});

describe("hostile names", () => {
  it.each([
    ["../../x", "x"],
    [".bashrc", "bashrc"],
    ["a\0b.txt", "a_b.txt"],
    ["", `drive-file-${ID}`],
    ["...", `drive-file-${ID}`],
    ["$(rm -rf ~)`;|.sh", "_(rm -rf _)___.sh"],
  ])("%j becomes %j", (raw, safe) => expect(safeName(raw, ID)).toBe(safe));

  it("cuts 300 chars to 120 and keeps the extension", () => {
    const name = safeName(`${"a".repeat(300)}.mp4`, ID);
    expect(name).toHaveLength(120);
    expect(name.endsWith(".mp4")).toBe(true);
  });

  it("writes a ../../x file inside its job dir", async () => {
    clean();
    meta = { ...meta, name: "../../x" };
    const r = (await settle((await fetchFile()).jobId)).result;
    expect(r.path).toBe(join(scratch, jobDirs()[0]!, "x"));
    expect(existsSync(join(base, "x"))).toBe(false);
  });
});

describe("symlinks are refused before any byte is written", () => {
  it("at the mkdtemp path", async () => {
    clean();
    const mk = async (prefix: string) => {
      const p = `${prefix}planted`;
      symlinkSync(outside, p);
      return p;
    };
    const s = await settle((await fetchFile({ mkdtemp: mk })).jobId);
    expect(s).toMatchObject({ status: "failed", code: "path_not_allowed" });
    expect(readdirSync(outside)).toEqual([]);
    expect(broker.downloadStream).not.toHaveBeenCalled();
  });

  it("at the final name", async () => {
    clean();
    const target = join(outside, "victim.txt");
    writeFileSync(target, "keep me");
    const mk = async (prefix: string) => {
      const dir = await mkdtemp(prefix);
      symlinkSync(target, join(dir, meta.name));
      return dir;
    };
    const s = await settle((await fetchFile({ mkdtemp: mk })).jobId);
    expect(s).toMatchObject({ status: "failed", code: "path_not_allowed" });
    expect(readFileSync(target, "utf8")).toBe("keep me");
    rmSync(target);
  });
});

describe("refusals before a job", () => {
  it("a file outside the project folder and its sub-folders", async () => {
    meta = { ...meta, parents: ["elsewhere"] };
    expect(await fetchFile()).toMatchObject({ status: "not_in_project_folder" });
  });
  it("a Google Docs file", async () => {
    meta = { ...meta, mimeType: "application/vnd.google-apps.document", size: 0 };
    expect(await fetchFile()).toEqual({ status: "not_supported", hint: "Export Google Docs files from Drive first." });
  });
  it("over 200 MiB", async () => {
    meta = { ...meta, size: 200 * MiB + 1 };
    expect(await fetchFile()).toEqual({ status: "too_large", hint: TEXTS.tooLarge });
  });
  it("low disk", async () => {
    const statfs = async () => ({ bavail: BODY.length + FETCH_DISK_MARGIN_BYTES - 1, bsize: 1 });
    expect(await fetchFile({ statfs })).toMatchObject({ status: "no_space" });
  });
  it("a remote run, and a run with no scratch dir", async () => {
    run.env = { driver: "ssh", remoteCwd: "/srv/x" };
    expect(await fetchFile()).toMatchObject({ status: "path_not_allowed", hint: expect.stringMatching(/remote environment/) });
    run.env = null;
    run.scratch = null;
    expect(await fetchFile()).toMatchObject({ status: "path_not_allowed", hint: expect.stringMatching(/no scratch dir/) });
  });
  it("a call with no run", async () => {
    expect(await fetchFile(undefined, viewer(null))).toMatchObject({ status: "path_not_allowed" });
    expect(broker.fileMeta).not.toHaveBeenCalled();
  });
  it("a fileId that is not a Google id", async () => {
    expect(await driveFileFetch(ctx, viewer(), { projectId: "p1", fileId: "../etc/passwd" }, deps())).toMatchObject({ status: "invalid_input" });
  });
});

describe("a mismatch removes the file and fails", () => {
  const failsClean = async (code: string) => {
    clean();
    const s = await settle((await fetchFile()).jobId);
    expect(s).toMatchObject({ status: "failed", code, hint: TEXTS.sizeMismatch });
    expect(jobDirs()).toEqual([]);
  };
  it("a short body", async () => {
    body = BODY.subarray(0, BODY.length - 1);
    await failsClean("size_mismatch");
  });
  it("a long body", async () => {
    body = Buffer.concat([BODY, Buffer.from("x")]);
    await failsClean("size_mismatch");
  });
  it("a declared size that differs", async () => {
    (broker.downloadStream as any).mockImplementation(async () => ({ body: stream(body), size: BODY.length + 5 }));
    await failsClean("size_mismatch");
  });
  it("a pibSha256 that differs", async () => {
    meta = { ...meta, sha256: "0".repeat(64) };
    await failsClean("sha_mismatch");
  });
});

describe("status scope and secrets (R4)", () => {
  it("another run of the same agent gets expired", async () => {
    const { jobId } = await fetchFile();
    await settle(jobId);
    expect(driveJobStatus({ companyId: CO, agentId: AG, runId: randomUUID() }, jobId)).toEqual({ status: "expired", hint: TEXTS.expired });
  });

  it("Google's error text never reaches the result or the log", async () => {
    (broker.fileMeta as any).mockRejectedValueOnce(new BrokerError(SECRET, 500, true));
    const refused = await fetchFile();
    expect(refused).toEqual({ status: "transfer_failed", hint: TEXTS.failed });
    (broker.downloadStream as any).mockRejectedValueOnce(new BrokerError(SECRET, 403, false));
    const failed = await settle((await fetchFile()).jobId);
    expect(failed).toMatchObject({ status: "failed", code: "transfer_failed" });
    noSecrets([refused, failed, logs]);
  });
});
