import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { saveSendRecord, type SaveSendRecordOptions } from "../src/drive.js";
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

describe("saveSendRecord", () => {
  it("saves send record with correct subfolder and kind", async () => {
    const savedRequests: any[] = [];
    const mockDriveSave = vi.fn(async (ctx, opts) => {
      savedRequests.push(opts);
      return { status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.example.com/file-1" };
    });

    const ctx = fakeCtx();
    const sentAt = new Date("2026-10-20T15:30:00Z");

    await saveSendRecord(ctx, {
      companyId: "co-1",
      campaignId: "camp-abc",
      enrollmentId: "enr-123",
      stepPosition: 1,
      variant: "a",
      subject: "Test Subject",
      messageId: "msg-456",
      threadId: "thr-789",
      sentAt,
      campaignName: "Welcome Series",
      driveSave: mockDriveSave,
    });

    expect(savedRequests).toHaveLength(1);
    const req = savedRequests[0];

    expect(req.kind).toBe("campaigns");
    expect(req.subfolder).toBe("03 Deliverables");
    expect(req.mimeType).toBe("application/json");
    expect(req.name).toMatch(/^2026-10-20\s+Welcome\s+Series\s+send\s+enr123\s+step\s+1\s+v1\.json$/);

    // Verify no email in the bytes
    const recordBytes = JSON.parse(Buffer.from(req.bytes).toString("utf-8"));
    expect(recordBytes).toEqual({
      campaignId: "camp-abc",
      enrollmentId: "enr-123",
      stepPosition: 1,
      variant: "a",
      subject: "Test Subject",
      messageId: "msg-456",
      threadId: "thr-789",
      sentAt: sentAt.toISOString(),
    });
    expect(recordBytes).not.toHaveProperty("email");
  });

  it("uses campaign id when campaign name not provided", async () => {
    const savedRequests: any[] = [];
    const mockDriveSave = vi.fn(async (ctx, opts) => {
      savedRequests.push(opts);
      return { status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.example.com/file-1" };
    });

    const ctx = fakeCtx();

    await saveSendRecord(ctx, {
      companyId: "co-1",
      campaignId: "camp-xyz-123",
      enrollmentId: "enr-456",
      stepPosition: 2,
      variant: "b",
      subject: "",
      messageId: null,
      threadId: null,
      sentAt: new Date("2026-10-20"),
      driveSave: mockDriveSave,
    });

    const req = savedRequests[0];
    expect(req.name).toMatch(/^2026-10-20\s+camp-xyz-123\s+send\s+enr456\s+step\s+2\s+v1\.json$/);
  });

  it("does not fail when driveSave fails", async () => {
    const mockDriveSave = vi.fn(async () => ({
      status: "failed" as const,
      requestId: "req-1",
      reason: "upload_failed",
    } as DriveSaveResult));

    const log: any = {};
    const ctx = fakeCtx(log);

    await expect(
      saveSendRecord(ctx, {
        companyId: "co-1",
        campaignId: "camp-fail",
        enrollmentId: "enr-fail",
        stepPosition: 1,
        variant: "a",
        subject: "Failing test",
        messageId: null,
        threadId: null,
        sentAt: new Date(),
        driveSave: mockDriveSave,
      })
    ).resolves.toBeUndefined();

    expect(log.warns).toHaveLength(1);
    expect(log.warns[0].msg).toContain("campaign send record");
  });

  it("logs warning when driveSave throws", async () => {
    const mockDriveSave = vi.fn(async () => {
      throw new Error("Network error");
    });

    const log: any = {};
    const ctx = fakeCtx(log);

    await expect(
      saveSendRecord(ctx, {
        companyId: "co-1",
        campaignId: "camp-err",
        enrollmentId: "enr-err",
        stepPosition: 3,
        variant: "c",
        subject: "Error test",
        messageId: "msg-123",
        threadId: "thr-456",
        sentAt: new Date(),
        driveSave: mockDriveSave,
      })
    ).resolves.toBeUndefined();

    expect(log.warns).toHaveLength(1);
    expect(log.warns[0].msg).toContain("Error saving");
  });

  it("sanitizes filenames", async () => {
    const savedRequests: any[] = [];
    const mockDriveSave = vi.fn(async (ctx, opts) => {
      savedRequests.push(opts);
      return { status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.example.com/file-1" };
    });

    const ctx = fakeCtx();

    await saveSendRecord(ctx, {
      companyId: "co-1",
      campaignId: "camp/evil\\control\x00",
      enrollmentId: "enr-san",
      stepPosition: 1,
      variant: "a",
      subject: "Test",
      messageId: null,
      threadId: null,
      sentAt: new Date(),
      campaignName: "Bad/Name\\With\x00Control",
      driveSave: mockDriveSave,
    });

    const name = savedRequests[0].name;
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain("\x00");
  });

  it("handles no_ack result gracefully", async () => {
    const mockDriveSave = vi.fn(async () => ({
      status: "no_ack" as const,
      requestId: "req-1",
    } as DriveSaveResult));

    const log: any = {};
    const ctx = fakeCtx(log);

    await saveSendRecord(ctx, {
      companyId: "co-1",
      campaignId: "camp-noack",
      enrollmentId: "enr-noack",
      stepPosition: 1,
      variant: "a",
      subject: "Timeout test",
      messageId: null,
      threadId: null,
      sentAt: new Date(),
      driveSave: mockDriveSave,
    });

    // no_ack is not treated as a warning
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
      saveSendRecord(ctx, {
        companyId: "co-1",
        campaignId: "camp-hang",
        enrollmentId: "enr-hang",
        stepPosition: 1,
        variant: "a",
        subject: "Hang test",
        messageId: "msg-789",
        threadId: "thr-012",
        sentAt: new Date(),
        driveSave: mockDriveSave,
      })
    ).resolves.toBeUndefined();

    // Should have called driveSave
    expect(mockDriveSave).toHaveBeenCalled();
    // Should not have any warning logs for no_ack (it is expected behavior)
    const warnMessages = (log.warns || []).map((w: any) => w.msg).join(",");
    expect(warnMessages).not.toContain("no_ack");
  });
});
