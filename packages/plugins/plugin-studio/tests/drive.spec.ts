import { beforeEach, describe, expect, it, vi } from "vitest";

const row = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "Summer / hero",
  mime: "image/png",
  bytes: 1_500_000,
  r2_key: "studio/co-1/a.png",
  created_at: "2026-11-01T10:00:00.000Z",
  current_version: 2,
  client_kind: "crm_contact",
  client_id: "client-9",
};
const links: string[] = [];

vi.mock("../src/assets.js", () => ({
  getAssetRow: vi.fn(async () => row),
  addLink: vi.fn(async (_ctx: unknown, _co: string, _id: string, type: string, target: string) => {
    links.push(`${type}:${target}`);
  }),
}));
vi.mock("../src/storage.js", () => ({
  assertOwnKey: vi.fn(),
  extFor: (mime: string) => (mime === "image/png" ? "png" : "bin"),
  getObject: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));
vi.mock("../src/config.js", () => ({
  StudioConfig: class {
    async bucket() {
      return {};
    }
  },
}));
vi.mock("@partnersinbiz/pib-plugin-kit", () => ({
  DRIVE_ACK_TIMEOUT_MS: 8_000,
  driveSave: vi.fn(),
  scopeOfRow: (r: { client_kind?: string; client_id?: string }) => (r.client_kind && r.client_id ? { kind: r.client_kind, id: r.client_id } : null),
}));

const { DRIVE_MAX_BYTES, driveFileName, driveFileUrl, refusalText, saveAssetToDrive } = await import("../src/drive.js");

const ctx = {} as never;

describe("Save to Drive", () => {
  beforeEach(() => {
    links.length = 0;
    row.bytes = 1_500_000;
  });

  it("saves into the asset's own client 02 Assets and records the link", async () => {
    const save = vi.fn(async () => ({ status: "saved" as const, driveFileId: "1AbCdEfGhIjKlMnOp" }));
    const out = (await saveAssetToDrive(ctx, "co-1", row.id, save as never)) as { url: string };
    expect(save).toHaveBeenCalledTimes(1);
    const opts = (save.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(opts).toMatchObject({ companyId: "co-1", subfolder: "02 Assets", mimeType: "image/png", client: { kind: "crm_contact", ref: "client-9" } });
    expect(opts.name).toBe("2026-11-01 Summer - hero 11111111 v2.png");
    expect(out.url).toBe("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view");
    expect(links).toEqual(["drive_file:1AbCdEfGhIjKlMnOp"]);
  });

  it("refuses files over the broker limit before reading R2 or calling CRM", async () => {
    row.bytes = DRIVE_MAX_BYTES + 1;
    const save = vi.fn();
    await expect(saveAssetToDrive(ctx, "co-1", row.id, save as never)).rejects.toThrow(/up to 200\.0 MB, the largest file Studio keeps/);
    expect(save).not.toHaveBeenCalled();
    expect(links).toEqual([]);
  });

  it("reports refusals plainly and records nothing", async () => {
    const save = vi.fn(async () => ({ status: "refused" as const, reason: "drive_not_bound" }));
    await expect(saveAssetToDrive(ctx, "co-1", row.id, save as never)).rejects.toThrow(/no Shared Drive bound/);
    expect(links).toEqual([]);
    expect(refusalText({ status: "no_ack" } as never)).toMatch(/didn't answer/);
    expect(refusalText({ status: "refused", reason: "no_project" } as never)).toMatch(/no Drive project/);
  });

  it("only links real Drive ids", () => {
    expect(driveFileUrl("javascript:alert(1)")).toBeNull();
    expect(driveFileUrl("short")).toBeNull();
    expect(driveFileName({ id: row.id, name: "", createdAt: null, version: 1, mime: "image/png" })).toMatch(/^\d{4}-\d{2}-\d{2} asset 11111111 v1\.png$/);
  });
});
