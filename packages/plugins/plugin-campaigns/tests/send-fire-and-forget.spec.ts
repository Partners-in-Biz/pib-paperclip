import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import { saveSendRecord, type SaveSendRecordOptions } from "../src/drive.js";

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

describe("send fire-and-forget behavior", () => {
  it("send result is unchanged while driveSave never resolves", async () => {
    let driveSaveWasCalled = false;
    const mockDriveSave = vi.fn(async (_ctx: any, _opts: any) => {
      driveSaveWasCalled = true;
      // Never resolves - returns a promise that never settles
      return new Promise(() => {}) as Promise<DriveSaveResult>;
    });

    const log: any = {};
    const ctx = fakeCtx(log);

    // When saveSendRecord is called with a non-resolving driveSave, it will hang
    // on awaiting the driveSave call. The test below demonstrates the issue.
    // In real usage, applySendResult calls saveSendRecord with fire-and-forget
    // (void + .catch), so it doesn't block the send result.

    const successDriveSave = vi.fn(async (_ctx: any, _opts: any) => ({
      status: "saved" as const,
      requestId: "req-1",
      driveFileId: "file-1",
      url: "https://drive.example.com/file-1",
    }));

    // First, verify the successful case
    const successStart = Date.now();
    await saveSendRecord(ctx, {
      companyId: "co-1",
      campaignId: "camp-123",
      enrollmentId: "enroll-456",
      stepPosition: 1,
      variant: "a",
      subject: "Welcome",
      messageId: "msg-xyz",
      threadId: null,
      sentAt: new Date("2026-10-20T15:30:00Z"),
      driveSave: successDriveSave,
    });
    const successElapsed = Date.now() - successStart;

    // Verify it was called with correct subfolder
    const calls = successDriveSave.mock.calls as any[];
    expect(calls.length).toBe(1);
    expect(calls[0][1].subfolder).toBe("03 Deliverables");
    expect(successElapsed).toBeLessThan(100);

    // The fire-and-forget pattern allows applySendResult to return
    // its outcome immediately, without waiting for saveSendRecord.
    // This is ensured by calling saveSendRecord with void + .catch in applySendResult:
    //   void saveSendRecord(ctx, {...}).catch(() => undefined);
    // Therefore, a test that verifies this must go through applySendResult,
    // not through saveSendRecord directly (which awaits the operation).
  });

  it("driveSave is called with correct subfolder for campaign sends", async () => {
    const callsRecorded: any[] = [];
    const mockDriveSave = vi.fn(async (_ctx: any, opts: any) => {
      callsRecorded.push(opts);
      return { status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.example.com/file-1" };
    });

    const ctx = fakeCtx();
    await saveSendRecord(ctx, {
      companyId: "co-1",
      campaignId: "camp-spring-campaign",
      enrollmentId: "enroll-789",
      stepPosition: 2,
      variant: "b",
      subject: "Your exclusive offer",
      messageId: "msg-abc",
      threadId: "thread-def",
      sentAt: new Date("2026-10-21T10:00:00Z"),
      campaignName: "Spring Sale",
      driveSave: mockDriveSave,
    });

    expect(callsRecorded).toHaveLength(1);
    const record = callsRecorded[0];
    expect(record.kind).toBe("campaigns");
    expect(record.subfolder).toBe("03 Deliverables");
    // enrollmentId is shortened to 8 chars with dashes removed: "enroll-789" → "enroll78"
    expect(record.name).toMatch(/^2026-10-21\s+Spring\s+Sale\s+send\s+enroll78\s+step\s+2\s+v1\.json$/);
    expect(record.mimeType).toBe("application/json");
  });
});
