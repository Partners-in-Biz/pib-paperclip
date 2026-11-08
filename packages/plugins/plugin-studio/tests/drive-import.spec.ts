import { beforeEach, describe, expect, it, vi } from "vitest";

const stored: Array<Record<string, unknown>> = [];
const existing = new Map<string, string>();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

vi.mock("../src/assets.js", () => ({
  storeAsset: vi.fn(async (_ctx: unknown, _cfg: unknown, input: Record<string, unknown>) => {
    stored.push(input);
    existing.set(String(input.sourceRef), "asset-new");
    return "asset-new";
  }),
  getAssetRow: vi.fn(async (_ctx: unknown, _co: string, id: string) => ({ id })),
  assetOut: (row: { id: string }) => ({ id: row.id, name: "hero" }),
}));
vi.mock("../src/config.js", () => ({ StudioConfig: class {} }));
vi.mock("../src/storage.js", () => ({ MAX_ASSET_BYTES: 50 * 1024 * 1024, sniffMime: (b: Uint8Array) => (b[0] === 0x89 ? "image/png" : null) }));
vi.mock("../src/scope.js", () => ({
  scopeInput: (p: { client?: unknown }) => (p.client === "company:acme" ? { kind: "company", id: "acme" } : p.client === null || p.client === "own" ? null : undefined),
  resolveScope: vi.fn(async (_ctx: unknown, _co: string, scope: { kind: string; id: string } | null) => (scope ? { scope, client: { name: "Acme" } } : { scope: null, client: null })),
}));

const { importFromDrive, listDriveFiles, driveSourceRef, driveThumbs } = await import("../src/drive-import.js");

const ctx = {
  db: {
    namespace: "plugin_studio_test",
    query: vi.fn(async (sql: string, args: unknown[]) => {
      // The picker's "already added" lookup: every Drive copy under a source-ref prefix (LIKE 'drive:<scope>:%').
      if (sql.includes("LIKE")) {
        const prefix = String(args[1]).replace(/%$/, "").replace(/\\(.)/g, "$1");
        return [...existing.entries()].filter(([ref]) => ref.startsWith(prefix)).map(([source_ref, id]) => ({ id, source_ref }));
      }
      const id = existing.get(String(args[1]));
      return id ? [{ id }] : [];
    }),
  },
} as never;
const FILE = { id: "1AbCdEfGhIjKlMnOp", name: "hero.png", mimeType: "image/png", size: PNG.length };

describe("From Drive", () => {
  beforeEach(() => {
    stored.length = 0;
    existing.clear();
  });

  it("copies the picked file into the picked client's library with Drive provenance", async () => {
    const read = vi.fn(async () => ({ status: "read" as const, requestId: "r", file: FILE, bytes: PNG }));
    const out = await importFromDrive(ctx, "co-1", { client: "company:acme", fileId: FILE.id }, { userId: "u-1" }, { list: vi.fn(), read } as never);
    expect(read).toHaveBeenCalledWith(ctx, expect.objectContaining({ companyId: "co-1", fileId: FILE.id, client: { kind: "company", ref: "acme" } }));
    expect(stored[0]).toMatchObject({ scope: { kind: "company", id: "acme" }, clientName: "Acme", source: "drive", sourceRef: `drive:company:acme:${FILE.id}`, name: "hero", userId: "u-1", mime: "image/png" });
    expect(out).toMatchObject({ id: "asset-new", reused: false });
    // The same file for the same client again: the first copy, no second read.
    const again = await importFromDrive(ctx, "co-1", { client: "company:acme", fileId: FILE.id }, { userId: "u-1" }, { list: vi.fn(), read } as never);
    expect(again).toMatchObject({ reused: true });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shows the CRM's refusal of another client's file and stores nothing", async () => {
    const read = vi.fn(async () => ({ status: "failed" as const, requestId: "r", reason: "not_in_client_folder" }));
    await expect(importFromDrive(ctx, "co-1", { client: "company:acme", fileId: FILE.id }, { userId: "u-1" }, { list: vi.fn(), read } as never)).rejects.toThrow(/isn't in this client's Drive/);
    expect(stored).toEqual([]);
  });

  it("refuses files Studio can't store and bad ids", async () => {
    const read = vi.fn(async () => ({ status: "read" as const, requestId: "r", file: { ...FILE, name: "a.pdf" }, bytes: new Uint8Array([0x25, 0x50]) }));
    await expect(importFromDrive(ctx, "co-1", { client: "own", fileId: FILE.id }, { userId: "u-1" }, { list: vi.fn(), read } as never)).rejects.toThrow(/JPEG, PNG/);
    await expect(importFromDrive(ctx, "co-1", { client: "own", fileId: "x" }, { userId: "u-1" }, { list: vi.fn(), read } as never)).rejects.toThrow(/Pick a Drive file/);
    expect(stored).toEqual([]);
  });

  it("lists only images and videos and flags files over the limit", async () => {
    const list = vi.fn(async () => ({ status: "listed" as const, requestId: "r", files: [FILE, { ...FILE, id: "2", name: "q.pdf", mimeType: "application/pdf" }, { ...FILE, id: "3", mimeType: "video/mp4", size: 201 * 1024 * 1024 }, { ...FILE, id: "4", mimeType: "video/mp4", size: 6 * 1024 * 1024 }] }));
    const out = await listDriveFiles(ctx, "co-1", { client: "own" }, { list, read: vi.fn() } as never);
    // Over 5 MiB is fine now (a background transfer, PAR-8125); only over 200 MB is too large.
    expect(out.files.map((f) => [f.id, f.tooLarge])).toEqual([[FILE.id, false], ["3", true], ["4", false]]);
    expect(list).toHaveBeenCalledWith(ctx, expect.not.objectContaining({ client: expect.anything() }));
    expect(driveSourceRef(null, "abc")).toBe("drive:own:abc");
  });

  it("lists newest first with folders, and marks files this client already has", async () => {
    existing.set(`drive:company:acme:${FILE.id}`, "asset-old");
    existing.set("drive:own:2BbCdEfGhIjKlMnOp", "asset-own");
    const files = [
      { ...FILE, folder: "Assets/Images", modifiedTime: "2026-10-01T00:00:00Z" },
      { ...FILE, id: "2BbCdEfGhIjKlMnOp", name: "new.png", folder: "Assets/Social", modifiedTime: "2026-11-05T00:00:00Z" },
      { ...FILE, id: "3BbCdEfGhIjKlMnOp", name: "clip.mp4", mimeType: "video/mp4" },
    ];
    const list = vi.fn(async () => ({ status: "listed" as const, requestId: "r", files }));
    const out = await listDriveFiles(ctx, "co-1", { client: "company:acme" }, { list, read: vi.fn() } as never);
    expect(out.files.map((f) => [f.id, f.folder, f.assetId])).toEqual([
      ["2BbCdEfGhIjKlMnOp", "Assets/Social", null], // another scope's copy doesn't count
      [FILE.id, "Assets/Images", "asset-old"],
      ["3BbCdEfGhIjKlMnOp", null, null],
    ]);
    expect(out.maxBytes).toBeGreaterThan(0);
  });

  it("turns the CRM's previews into data URLs and passes reasons through", async () => {
    const thumbs = vi.fn(async () => ({ status: "thumbs" as const, requestId: "r", thumbs: [{ id: FILE.id, mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }, { id: "2BbCdEfGhIjKlMnOp", reason: "no_preview" }] }));
    const out = await driveThumbs(ctx, "co-1", { client: "company:acme", fileIds: [FILE.id, "2BbCdEfGhIjKlMnOp"], size: "large" }, { list: vi.fn(), read: vi.fn(), thumbs } as never);
    expect(out.thumbs).toEqual([{ id: FILE.id, url: "data:image/jpeg;base64,AQID" }, { id: "2BbCdEfGhIjKlMnOp", reason: "no_preview" }]);
    expect(thumbs).toHaveBeenCalledWith(ctx, expect.objectContaining({ client: { kind: "company", ref: "acme" }, fileIds: [FILE.id, "2BbCdEfGhIjKlMnOp"], size: "large" }));
    await expect(driveThumbs(ctx, "co-1", { client: "own", fileIds: ["../x"] }, { list: vi.fn(), read: vi.fn(), thumbs } as never)).rejects.toThrow(/Ask for 1 to 24/);
    await expect(driveThumbs(ctx, "co-1", { client: "own", fileIds: Array.from({ length: 25 }, (_, i) => `abcdefghij${i}`) }, { list: vi.fn(), read: vi.fn(), thumbs } as never)).rejects.toThrow(/Ask for 1 to 24/);
    const refused = vi.fn(async () => ({ status: "failed" as const, requestId: "r", reason: "no_project" }));
    await expect(driveThumbs(ctx, "co-1", { client: "own", fileIds: [FILE.id] }, { list: vi.fn(), read: vi.fn(), thumbs: refused } as never)).rejects.toThrow(/no Drive project/);
  });
});
