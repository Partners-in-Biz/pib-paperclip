/**
 * PAR-8125: Drive saves and imports over 5 MiB run as background transfers through signed R2 links. The links go only
 * to the CRM: never into a transfer view, an error or a reply the page or an agent sees.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const MiB = 1024 * 1024;
const row = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "Launch film",
  mime: "video/mp4",
  bytes: 48 * MiB,
  r2_key: "studio/co-1/own/11111111-2222-3333-4444-555555555555/v1.mp4",
  created_at: "2026-11-01T10:00:00.000Z",
  current_version: 1,
  client_kind: null as string | null,
  client_id: null as string | null,
};
const SHA = "a".repeat(64);
const SIGNED = "https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=deadbeef";
const links: string[] = [];
const recorded: Array<Record<string, unknown>> = [];
const deleted: string[] = [];
let head = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); // ....ftypisom
const assetRows = new Map<string, string>();

vi.mock("../src/assets.js", () => ({
  getAssetRow: vi.fn(async (_c: unknown, _co: string, id: string) => (id === row.id ? row : { id })),
  addLink: vi.fn(async (_c: unknown, _co: string, _id: string, type: string, target: string) => void links.push(`${type}:${target}`)),
  assetOut: (r: { id: string }) => ({ id: r.id }),
  storeAsset: vi.fn(async () => "small-asset"),
  recordStoredAsset: vi.fn(async (_c: unknown, input: Record<string, unknown>) => {
    recorded.push(input);
    assetRows.set(String(input.sourceRef), String(input.id));
  }),
}));
vi.mock("../src/storage.js", () => ({
  MAX_ASSET_BYTES: 200 * MiB,
  assertOwnKey: vi.fn(),
  extFor: (m: string) => (m === "video/mp4" ? "mp4" : "png"),
  assetKey: (co: string, _s: unknown, id: string, v: number, ext: string) => `studio/${co}/own/${id}/v${v}.${ext}`,
  getObject: vi.fn(async () => new Uint8Array([1, 2, 3])),
  getObjectHead: vi.fn(async () => head),
  deleteObject: vi.fn(async (_b: unknown, _co: string, key: string) => void deleted.push(key)),
  objectUrl: () => SIGNED,
  sniffMime: (b: Uint8Array) => (String.fromCharCode(...b.subarray(4, 8)) === "ftyp" ? "video/mp4" : null),
}));
vi.mock("../src/config.js", () => ({ StudioConfig: class { async bucket() { return {}; } } }));
vi.mock("../src/scope.js", () => ({ scopeInput: () => null, resolveScope: async () => ({ scope: null, client: null }) }));
vi.mock("@partnersinbiz/pib-plugin-kit", () => ({
  DRIVE_ACK_TIMEOUT_MS: 8_000,
  driveSave: vi.fn(),
  driveList: vi.fn(),
  driveRead: vi.fn(),
  driveReadToR2: vi.fn(),
  driveThumbs: vi.fn(),
  DRIVE_THUMBS_MAX: 24,
  formatClientParam: (s: { kind: string; id: string }) => `${s.kind}:${s.id}`,
  scopeOfRow: () => null,
}));

const { saveAssetToDrive } = await import("../src/drive.js");
const { importFromDrive } = await import("../src/drive-import.js");
const { getTransfer, resetTransfers, startTransfer, TRANSFER_STALE_MS } = await import("../src/drive-jobs.js");
const { awaitTransfer, percent } = await import("../src/ui/drive-transfer.js");

const ctx = {
  db: {
    namespace: "plugin_studio_test",
    query: vi.fn(async (sql: string, args: unknown[]) => {
      if (sql.includes("asset_versions")) return [{ sha256: SHA }];
      const id = assetRows.get(String(args[1]));
      return id ? [{ id }] : [];
    }),
  },
} as never;

async function settle(transferId: string) {
  for (let i = 0; i < 50; i++) {
    const v = getTransfer("co-1", transferId);
    if (v.status !== "running") return v;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("transfer did not finish");
}

function noSecret(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(/X-Amz-Signature|r2\.cloudflarestorage\.com/);
}

beforeEach(() => {
  resetTransfers();
  links.length = 0;
  recorded.length = 0;
  deleted.length = 0;
  assetRows.clear();
  row.bytes = 48 * MiB;
  head = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
});

describe("Save to Drive over 5 MiB", () => {
  it("returns a transfer at once, sends the CRM a signed link with size and sha256, and records the Drive link at the end", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const save = vi.fn(async (_c: unknown, opts: Record<string, unknown>) => {
      (opts.onProgress as (p: { bytesDone: number; bytesTotal: number }) => void)({ bytesDone: 16 * MiB, bytesTotal: 48 * MiB });
      await gate;
      return { status: "saved" as const, requestId: "r", driveFileId: "1AbCdEfGhIjKlMnOp", url: "x" };
    });
    const started = await saveAssetToDrive(ctx, "co-1", row.id, save as never);
    expect(started).toMatchObject({ status: "running", bytesTotal: 48 * MiB });
    noSecret(started);
    const opts = save.mock.calls[0]![1];
    expect(opts).toMatchObject({ r2Url: SIGNED, size: 48 * MiB, sha256: SHA, ownWork: true, subfolder: "02 Assets" });
    expect(opts.bytes).toBeUndefined();
    const id = (started as { transferId: string }).transferId;
    expect(getTransfer("co-1", id)).toMatchObject({ status: "running", bytesDone: 16 * MiB });
    release();
    const done = await settle(id);
    expect(done).toMatchObject({ status: "done", result: { fileId: "1AbCdEfGhIjKlMnOp", url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view" } });
    noSecret(done);
    expect(links).toEqual(["drive_file:1AbCdEfGhIjKlMnOp"]);
  });

  it("files of 5 MiB or less still go as bytes and answer inside the action", async () => {
    row.bytes = 5 * MiB;
    const save = vi.fn(async (_c: unknown, _o: Record<string, unknown>) => ({ status: "saved" as const, requestId: "r", driveFileId: "1AbCdEfGhIjKlMnOp", url: "x" }));
    const out = await saveAssetToDrive(ctx, "co-1", row.id, save as never);
    expect(out).toMatchObject({ fileId: "1AbCdEfGhIjKlMnOp" });
    expect(save.mock.calls[0]![1]).toMatchObject({ bytes: new Uint8Array([1, 2, 3]), timeoutMs: 8_000 });
  });

  it("refuses over 200 MB in plain words, and a double click joins the running transfer", async () => {
    row.bytes = 201 * MiB;
    await expect(saveAssetToDrive(ctx, "co-1", row.id, vi.fn() as never)).rejects.toThrow(/201\.0 MB\. Drive transfers take files up to 200\.0 MB, the largest file Studio keeps/);
    row.bytes = 48 * MiB;
    const save = vi.fn(() => new Promise(() => undefined));
    const a = await saveAssetToDrive(ctx, "co-1", row.id, save as never);
    const b = await saveAssetToDrive(ctx, "co-1", row.id, save as never);
    expect((a as { transferId: string }).transferId).toBe((b as { transferId: string }).transferId);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a refusal or a crash ends the transfer with plain words and no link", async () => {
    const refused = await saveAssetToDrive(ctx, "co-1", row.id, (async () => ({ status: "failed", requestId: "r", reason: "sha256_mismatch" })) as never);
    expect(await settle((refused as { transferId: string }).transferId)).toMatchObject({ status: "failed", error: expect.stringMatching(/changed while it was being copied/) });
    resetTransfers();
    const crashed = await saveAssetToDrive(ctx, "co-1", row.id, (async () => {
      throw new Error(`fetch failed for ${SIGNED}`);
    }) as never);
    const view = await settle((crashed as { transferId: string }).transferId);
    expect(view.status).toBe("failed");
    noSecret(view);
    expect(links).toEqual([]);
  });
});

describe("From Drive over 5 MiB", () => {
  const FILE = { id: "1AbCdEfGhIjKlMnOp", name: "film.mp4", mimeType: "video/mp4", size: 48 * MiB };

  it("streams into a signed PUT link in the background, checks the type and records the asset", async () => {
    const readToR2 = vi.fn(async (_c: unknown, t: Record<string, unknown>) => {
      (t.onProgress as (p: { bytesDone: number; bytesTotal: number }) => void)({ bytesDone: 8 * MiB, bytesTotal: 48 * MiB });
      return { status: "stored" as const, requestId: "r", file: FILE, size: FILE.size, sha256: SHA };
    });
    const read = vi.fn();
    const started = await importFromDrive(ctx, "co-1", { fileId: FILE.id, size: FILE.size, mimeType: FILE.mimeType }, { userId: "u-1" }, { list: vi.fn(), read, readToR2 } as never);
    expect(started).toMatchObject({ status: "running", bytesTotal: FILE.size });
    noSecret(started);
    const done = await settle((started as { transferId: string }).transferId);
    expect(done).toMatchObject({ status: "done", result: { reused: false } });
    expect(read).not.toHaveBeenCalled();
    expect(readToR2.mock.calls[0]![1]).toMatchObject({ fileId: FILE.id, r2PutUrl: SIGNED, timeoutMs: 60_000 });
    expect(recorded[0]).toMatchObject({ size: FILE.size, sha256: SHA, mime: "video/mp4", source: "drive", name: "film", sourceRef: `drive:own:${FILE.id}` });
    expect(String(recorded[0]!.key)).toMatch(/\.mp4$/);
  });

  it("drops the stored copy when its bytes are not the type Drive listed", async () => {
    head = new Uint8Array(12);
    const readToR2 = vi.fn(async () => ({ status: "stored" as const, requestId: "r", file: FILE, size: FILE.size, sha256: SHA }));
    const started = await importFromDrive(ctx, "co-1", { fileId: FILE.id, size: FILE.size, mimeType: FILE.mimeType }, { userId: null }, { list: vi.fn(), read: vi.fn(), readToR2 } as never);
    const done = await settle((started as { transferId: string }).transferId);
    expect(done).toMatchObject({ status: "failed", error: expect.stringMatching(/MP4 and MOV/) });
    expect(deleted).toHaveLength(1);
    expect(recorded).toEqual([]);
  });

  it("refuses too-big and unknown types before starting", async () => {
    const readers = { list: vi.fn(), read: vi.fn(), readToR2: vi.fn() } as never;
    await expect(importFromDrive(ctx, "co-1", { fileId: FILE.id, size: 300 * MiB, mimeType: "video/mp4" }, { userId: null }, readers)).rejects.toThrow(/300\.0 MB\. Drive transfers take files up to 200\.0 MB/);
    await expect(importFromDrive(ctx, "co-1", { fileId: FILE.id, size: 48 * MiB, mimeType: "application/zip" }, { userId: null }, readers)).rejects.toThrow(/MP4 and MOV/);
  });
});

describe("transfers", () => {
  it("are company-scoped and report a stall in plain words", async () => {
    const v = startTransfer("co-1", "save", "k", 10, () => new Promise(() => undefined));
    expect(() => getTransfer("co-2", v.transferId)).toThrow(/isn't running any more/);
    expect(getTransfer("co-1", v.transferId, Date.now() + TRANSFER_STALE_MS + 1)).toMatchObject({ status: "failed", error: expect.stringMatching(/Nothing moved for 2 minutes/) });
  });

  it("the page polls until done, reporting progress, and passes small results straight through", async () => {
    const seen: number[] = [];
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ transferId: "t", status: "running", bytesDone: 50, bytesTotal: 100 })
      .mockResolvedValueOnce({ transferId: "t", status: "done", bytesDone: 100, bytesTotal: 100, result: { url: "u" } });
    const out = await awaitTransfer({ transferId: "t", status: "running", bytesDone: 0, bytesTotal: 100 }, poll, "co-1", (d, t) => seen.push(percent(d, t)), async () => undefined);
    expect(out).toEqual({ url: "u" });
    expect(seen).toEqual([0, 50, 100]);
    expect(await awaitTransfer({ url: "small" }, poll, "co-1", () => undefined)).toEqual({ url: "small" });
    await expect(awaitTransfer({ transferId: "t", status: "failed", bytesDone: 0, bytesTotal: 1, error: "Plain reason." }, poll, "co-1", () => undefined)).rejects.toThrow("Plain reason.");
  });
});
