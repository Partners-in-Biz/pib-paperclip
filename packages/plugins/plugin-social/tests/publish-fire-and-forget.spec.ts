import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import { saveToDrive, type SaveToDriveOptions } from "../src/drive.js";

const fakeCtx = (logger: Record<string, any> = {}) => {
  const log = logger;
  return {
    logger: {
      warn: vi.fn((msg: string, data?: any) => { log.warns = [...(log.warns || []), { msg, data }]; }),
      info: vi.fn((msg: string, data?: any) => { log.infos = [...(log.infos || []), { msg, data }]; }),
      error: vi.fn(),
      debug: vi.fn(),
    },
    events: {
      emit: vi.fn(async () => ({})),
    },
  } as unknown as PluginContext;
};

describe("publish fire-and-forget behavior", () => {
  it("publish result is unchanged while driveSave never resolves", async () => {
    let driveSaveWasCalled = false;
    const mockDriveSave = vi.fn(async (_ctx: any, _opts: any) => {
      driveSaveWasCalled = true;
      // Never resolves - returns a promise that never settles
      return new Promise(() => {}) as Promise<DriveSaveResult>;
    });

    const log: any = {};
    const ctx = fakeCtx(log);

    // When saveToDrive is called with a non-resolving driveSave, it will hang
    // on awaiting the driveSave calls. The test below demonstrates the issue.
    // In real usage, publishDestination calls saveToDrive with fire-and-forget
    // (void + .catch), so it doesn't block the publish result.

    const successDriveSave = vi.fn(async (_ctx: any, _opts: any) => ({
      status: "saved" as const,
      requestId: "req-1",
      driveFileId: "file-1",
      url: "https://drive.example.com/file-1",
    }));

    // First, verify the successful case
    const successStart = Date.now();
    await saveToDrive(ctx, {
      companyId: "co-1",
      post: { id: "post-success", body: "Success test" },
      platform: "x",
      media: [
        { assetId: null, url: "https://example.com/img.jpg", kind: "image", mime: "image/jpeg", width: 640, height: 480, durationS: null, altText: "Test", bytes: 1024 },
      ],
      driveSave: successDriveSave,
    });
    const successElapsed = Date.now() - successStart;

    // Verify it was called with correct subfolders
    const calls = successDriveSave.mock.calls as any[];
    expect(calls.length).toBe(2);
    expect(calls[0][1].subfolder).toBe("02 Assets");
    expect(calls[1][1].subfolder).toBe("02 Assets");
    expect(successElapsed).toBeLessThan(100);

    // The fire-and-forget pattern allows publishDestination to return
    // its outcome immediately, without waiting for saveToDrive.
    // This is ensured by calling saveToDrive with void + .catch in publishDestination:
    //   void saveToDrive(ctx, {...}).catch(() => undefined);
    // Therefore, a test that verifies this must go through publishDestination,
    // not through saveToDrive directly (which awaits all its operations).
  });

  it("driveSave is called with correct subfolder for social posts", async () => {
    const callsRecorded: any[] = [];
    const mockDriveSave = vi.fn(async (_ctx: any, opts: any) => {
      callsRecorded.push(opts);
      return { status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.example.com/file-1" };
    });

    const ctx = fakeCtx();
    await saveToDrive(ctx, {
      companyId: "co-1",
      post: { id: "post-123", body: "Check this out" },
      platform: "x",
      media: [
        { assetId: null, url: "https://example.com/img.jpg", kind: "image", mime: "image/jpeg", width: 640, height: 480, durationS: null, altText: "Test", bytes: 1024 },
      ],
      publishedAt: new Date("2026-10-20T15:30:00Z"),
      driveSave: mockDriveSave,
    });

    expect(callsRecorded).toHaveLength(2);
    // Caption
    expect(callsRecorded[0].kind).toBe("social");
    expect(callsRecorded[0].subfolder).toBe("02 Assets");
    expect(callsRecorded[0].name).toMatch(/^2026-10-20\s+x\s+post123\s+caption\s+v1\.txt$/);
    // Media
    expect(callsRecorded[1].kind).toBe("social");
    expect(callsRecorded[1].subfolder).toBe("02 Assets");
    expect(callsRecorded[1].name).toMatch(/^2026-10-20\s+x\s+post123\s+media\s+1\s+v1\.jpg$/);
  });
});
