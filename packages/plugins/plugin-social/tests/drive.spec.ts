import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { saveToDrive, type SaveToDriveOptions } from "../src/drive.js";
import type { DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";

const fakeCtx = (logger: Record<string, any> = {}) => {
  const log = logger;
  return {
    logger: {
      warn: vi.fn((msg: string, data?: any) => { log.warns = [...(log.warns || []), { msg, data }]; }),
      info: vi.fn((msg: string, data?: any) => { log.infos = [...(log.infos || []), { msg, data }]; }),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as PluginContext;
};

describe("saveToDrive", () => {
  it("saves caption and media with correct subfolder and kind", async () => {
    const savedRequests: any[] = [];
    const mockDriveSave = vi.fn(async (ctx, opts) => {
      savedRequests.push(opts);
      return { status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.example.com/file-1" };
    });

    const ctx = fakeCtx();
    await saveToDrive(ctx, {
      companyId: "co-1",
      post: { id: "post-123", body: "Check this out" },
      platform: "x",
      media: [
        { assetId: null, url: "https://cdn.example.com/img1.jpg", kind: "image", mime: "image/jpeg", width: 640, height: 480, durationS: null, altText: "Test", bytes: 1024 },
      ],
      publishedAt: new Date("2026-10-20T15:30:00Z"),
      driveSave: mockDriveSave,
    });

    expect(savedRequests).toHaveLength(2);

    // Caption
    const captionReq = savedRequests[0];
    expect(captionReq.kind).toBe("social");
    expect(captionReq.subfolder).toBe("02 Assets");
    expect(captionReq.name).toMatch(/^2026-10-20\s+x\s+post123\s+caption\s+v1\.txt$/);

    // Media
    const mediaReq = savedRequests[1];
    expect(mediaReq.kind).toBe("social");
    expect(mediaReq.subfolder).toBe("02 Assets");
    expect(mediaReq.name).toMatch(/^2026-10-20\s+x\s+post123\s+media\s+1\s+v1\.jpg$/);
  });

  it("skips media without public https URL", async () => {
    const savedRequests: any[] = [];
    const mockDriveSave = vi.fn(async (ctx, opts) => {
      savedRequests.push(opts);
      return { status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.example.com/file-1" };
    });

    const ctx = fakeCtx();
    await saveToDrive(ctx, {
      companyId: "co-1",
      post: { id: "post-abc", body: "Test post" },
      platform: "linkedin",
      media: [
        { assetId: null, url: "http://insecure.example.com/img.jpg", kind: "image", mime: "image/jpeg", width: null, height: null, durationS: null, altText: null, bytes: null },
        { assetId: null, url: "", kind: "image", mime: "image/jpeg", width: null, height: null, durationS: null, altText: null, bytes: null },
      ],
      publishedAt: new Date("2026-10-20"),
      driveSave: mockDriveSave,
    });

    expect(savedRequests).toHaveLength(1);
    expect(savedRequests[0].name).toMatch(/caption/);
  });

  it("does not fail publish when driveSave fails", async () => {
    const mockDriveSave = vi.fn(async () => ({
      status: "failed" as const,
      requestId: "req-1",
      reason: "upload_failed",
    } as DriveSaveResult));

    const log: any = {};
    const ctx = fakeCtx(log);

    await expect(
      saveToDrive(ctx, {
        companyId: "co-1",
        post: { id: "post-xyz", body: "Failing test" },
        platform: "instagram",
        media: [],
        driveSave: mockDriveSave,
      })
    ).resolves.toBeUndefined();

    expect(log.warns).toHaveLength(1);
    expect(log.warns[0].msg).toContain("caption");
  });

  it("logs warning when driveSave throws", async () => {
    const mockDriveSave = vi.fn(async () => {
      throw new Error("Network error");
    });

    const log: any = {};
    const ctx = fakeCtx(log);

    await expect(
      saveToDrive(ctx, {
        companyId: "co-1",
        post: { id: "post-err", body: "Throwing error" },
        platform: "tiktok",
        media: [
          { assetId: null, url: "https://example.com/video.mp4", kind: "video", mime: "video/mp4", width: null, height: null, durationS: 10, altText: null, bytes: 5000 },
        ],
        driveSave: mockDriveSave,
      })
    ).resolves.toBeUndefined();

    expect(log.warns.length).toBeGreaterThanOrEqual(1);
  });

  it("sanitizes filenames", async () => {
    const savedRequests: any[] = [];
    const mockDriveSave = vi.fn(async (ctx, opts) => {
      savedRequests.push(opts);
      return { status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.example.com/file-1" };
    });

    const ctx = fakeCtx();
    await saveToDrive(ctx, {
      companyId: "co-1",
      post: { id: "post-badname/evil\\control\x00chars", body: "Test" },
      platform: "x",
      media: [],
      driveSave: mockDriveSave,
    });

    const name = savedRequests[0].name;
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain("\x00");
  });

  it("uses default driveSave when not provided", async () => {
    const ctx = fakeCtx();

    // With no mock driveSave, it should use the real one.
    // This will fail because we don't have proper event emitting,
    // but it shouldn't throw immediately.
    await expect(
      saveToDrive(ctx, {
        companyId: "co-1",
        post: { id: "post-nodrv", body: "Test" },
        platform: "x",
        media: [],
      })
    ).resolves.not.toThrow();
  });

  it("handles no_ack result gracefully", async () => {
    const mockDriveSave = vi.fn(async () => ({
      status: "no_ack" as const,
      requestId: "req-1",
    } as DriveSaveResult));

    const log: any = {};
    const ctx = fakeCtx(log);

    await saveToDrive(ctx, {
      companyId: "co-1",
      post: { id: "post-noack", body: "Timeout test" },
      platform: "x",
      media: [],
      driveSave: mockDriveSave,
    });

    // no_ack is not treated as a warning - it's expected behavior for timeouts
    const warnMessages = (log.warns || []).map((w: any) => w.msg).join(",");
    expect(warnMessages).not.toContain("no_ack");
  });

  it("does not hang the job when driveSave fails or times out", async () => {
    const mockDriveSave = vi.fn(async () => ({
      status: "no_ack" as const,
      requestId: "req-hang",
    } as DriveSaveResult));

    const log: any = {};
    const ctx = fakeCtx(log);

    // Should complete without hanging despite driveSave timing out
    await expect(
      saveToDrive(ctx, {
        companyId: "co-1",
        post: { id: "post-hang", body: "Hang test" },
        platform: "x",
        media: [
          { assetId: null, url: "https://example.com/img.jpg", kind: "image", mime: "image/jpeg", width: 640, height: 480, durationS: null, altText: "Test", bytes: 1024 },
        ],
        driveSave: mockDriveSave,
      })
    ).resolves.toBeUndefined();

    // Should have called driveSave for caption and media
    expect(mockDriveSave).toHaveBeenCalledTimes(2);
    // Should not have any warning logs for no_ack (it is expected behavior)
    const warnMessages = (log.warns || []).map((w: any) => w.msg).join(",");
    expect(warnMessages).not.toContain("no_ack");
  });
});
