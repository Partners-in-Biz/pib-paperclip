import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { creativeFileName, saveCreativeToDrive, type DriveSaveFn } from "../src/drive.js";

const warn = vi.fn();
const ctx = { events: {}, logger: { warn } } as unknown as PluginContext;
const base = {
  companyId: "c1",
  proposalId: "1234abcd-0000-0000-0000-000000000000",
  name: "Q4 creative",
  platform: "meta",
  fields: { headline: "Q4 Sale", body: "Get 30% off." },
  savedAt: new Date("2026-10-20T10:00:00Z"),
};

describe("saveCreativeToDrive", () => {
  it("saves the creative to 02 Assets with a convention name", async () => {
    const fake = vi.fn<DriveSaveFn>(async () => ({ status: "saved", requestId: "r", driveFileId: "d", url: "https://drive/x" }));
    expect(await saveCreativeToDrive(ctx, { ...base, driveSave: fake })).toBe(true);
    const opts = fake.mock.calls[0]![1];
    expect(opts).toMatchObject({ companyId: "c1", kind: "ads", subfolder: "02 Assets", mimeType: "application/json", name: "2026-10-20 meta Q4 creative 1234abcd v01.json" });
    expect(opts.name).toMatch(/^\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+$/);
    expect(JSON.parse(Buffer.from(opts.bytes as Buffer).toString("utf-8"))).toMatchObject({ name: "Q4 creative", headline: "Q4 Sale" });
  });

  it.each([
    ["failed", async () => ({ status: "failed" as const, requestId: "r", reason: "drive_not_bound" })],
    ["no_ack", async () => ({ status: "no_ack" as const, requestId: "r" })],
    ["a throw", async () => { throw new Error("boom"); }],
  ])("never fails the job when Drive answers %s", async (_label, impl) => {
    warn.mockClear();
    await expect(saveCreativeToDrive(ctx, { ...base, driveSave: impl as DriveSaveFn })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("cleans path characters out of the file name", () => {
    expect(creativeFileName({ ...base, name: "a/b\\c\n" })).toBe("2026-10-20 meta a-b-c 1234abcd v01.json");
  });
});
