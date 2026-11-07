import { describe, expect, it, vi } from "vitest";
import { saveSendRecord } from "../src/drive.js";

const ctx = () => ({ logger: { info: vi.fn(), warn: vi.fn() }, events: { emit: vi.fn(), on: vi.fn() } }) as any;
const base = { companyId: "co-1", campaignId: "camp-1", enrollmentId: "enr-12345678", stepPosition: 1, variant: "a", subject: "Hi", messageId: null, threadId: null, sentAt: new Date("2026-11-07T10:00:00Z"), campaignName: "Spring" };
const saved = () => vi.fn(async () => ({ status: "saved" as const, requestId: "r", driveFileId: "f", url: "https://drive.example/f" }));

describe("saveSendRecord client (PAR-8128)", () => {
  it("a client campaign's record carries that client", async () => {
    const drive = saved();
    await saveSendRecord(ctx(), { ...base, driveSave: drive, loadCampaign: async () => ({ clientKind: "company", clientRef: "acme" }) });
    expect((drive.mock.calls[0] as unknown[])[1]).toMatchObject({ client: { kind: "company", ref: "acme" } });
    expect((drive.mock.calls[0] as unknown[])[1]).not.toHaveProperty("ownWork");
  });

  it("our own campaign asks for the own folder", async () => {
    const drive = saved();
    await saveSendRecord(ctx(), { ...base, driveSave: drive, loadCampaign: async () => ({ clientKind: null, clientRef: null }) });
    expect((drive.mock.calls[0] as unknown[])[1]).toMatchObject({ ownWork: true });
    expect((drive.mock.calls[0] as unknown[])[1]).not.toHaveProperty("client");
  });

  it("an unreadable campaign is not copied at all", async () => {
    const drive = saved();
    await saveSendRecord(ctx(), { ...base, driveSave: drive, loadCampaign: async () => { throw new Error("db down"); } });
    await saveSendRecord(ctx(), { ...base, driveSave: drive, loadCampaign: async () => null });
    expect(drive).not.toHaveBeenCalled();
  });
});
