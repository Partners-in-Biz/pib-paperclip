import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { driveSave, registerDriveReplies, DRIVE_EVENTS } from "../src/drive.js";
import { CRM_PLUGIN_ID } from "../src/crm-projection.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const tick = () => new Promise(r => setTimeout(r, 10));
describe("drive save", () => {
  let fake: ReturnType<typeof fakeCtx>;
  beforeEach(() => { fake = fakeCtx({ companies: { "co-1": {} } }); vi.clearAllMocks(); });

  it("saved: emits contentBase64+sha256", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const p = driveSave(fake.ctx, { companyId: "co-1", kind: "attachment", name: "test.bin", mimeType: "application/octet-stream", bytes });
    await tick();
    const emitted = fake.emitted[0]!.payload;
    expect(Buffer.from(emitted.contentBase64 as string, "base64")).toEqual(bytes);
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId: emitted.requestId, driveFileId: "f", url: "https://example.com/f" });
    expect((await p).status).toBe("saved");
  });

  it("failed: returns reason+hint", async () => {
    const p = driveSave(fake.ctx, { companyId: "co-1", kind: "test", name: "x", mimeType: "x", bytes: Buffer.from("x") });
    await tick();
    const rid = fake.emitted[0]!.payload.requestId as string;
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.failed}`, "co-1", { requestId: rid, reason: "upload_failed", hint: "timeout" });
    const result = await p;
    expect(result.status === "failed" && result.reason).toBe("upload_failed");
  });

  it("timeout: no_ack", async () => {
    vi.useFakeTimers();
    const p = driveSave(fake.ctx, { companyId: "co-1", kind: "x", name: "x", mimeType: "x", bytes: Buffer.from("x"), timeoutMs: 50 });
    vi.advanceTimersByTime(100);
    expect((await p).status).toBe("no_ack");
    vi.useRealTimers();
  });

  it("emit failure: emit_failed", async () => {
    const result = await driveSave({ events: { on: vi.fn(), emit: vi.fn().mockRejectedValue(new Error()) } }, { companyId: "co-1", kind: "x", name: "x", mimeType: "x", bytes: Buffer.from("x") });
    expect(result.status === "failed" && result.reason).toBe("emit_failed");
  });

  it("invalid subfolder: invalid_input", async () => {
    fake.emitted = [];
    const r = await driveSave(fake.ctx, { companyId: "co-1", kind: "x", name: "x", mimeType: "x", bytes: Buffer.from("x"), subfolder: "" });
    expect(r.status === "failed" && r.reason).toBe("invalid_input");
    expect(fake.emitted).toHaveLength(0);
  });

  it("mismatched requestId/companyId: ignored", async () => {
    const p = driveSave(fake.ctx, { companyId: "co-1", requestId: "r1", kind: "x", name: "x", mimeType: "x", bytes: Buffer.from("x"), timeoutMs: 50 });
    await tick();
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId: "wrong", driveFileId: "f1", url: "https://example.com/f1" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    expect((await p).status).toBe("no_ack");
    vi.useRealTimers();
  });

  it("duplicate requestId: rejected", async () => {
    registerDriveReplies(fake.ctx);
    const p1 = driveSave(fake.ctx, { companyId: "co-1", requestId: "dup", kind: "x", name: "x", mimeType: "x", bytes: Buffer.from("x") });
    await tick();
    const r2 = await driveSave(fake.ctx, { companyId: "co-1", requestId: "dup", kind: "x", name: "y", mimeType: "x", bytes: Buffer.from("y") });
    expect(r2.status === "failed" && r2.reason).toBe("duplicate_request_id");
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId: "dup", driveFileId: "f", url: "https://example.com/f" });
    expect((await p1).status).toBe("saved");
  });

  it("publicUrl: no content/sha256", async () => {
    const p = driveSave(fake.ctx, { companyId: "co-1", kind: "external", name: "x", mimeType: "x", publicUrl: "https://example.com/d.pdf" });
    await tick();
    const emitted = fake.emitted[0]!.payload;
    expect(emitted.contentBase64).toBeUndefined();
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId: emitted.requestId, driveFileId: "f", url: "https://example.com/f" });
    expect((await p).status).toBe("saved");
  });

  it("subfolder/client: present/absent", async () => {
    const p = driveSave(fake.ctx, { companyId: "co-1", kind: "x", name: "x", mimeType: "x", bytes: Buffer.from("x"), subfolder: "03 Deliverables", client: { kind: "company", ref: "acme" } });
    await tick();
    const emitted = fake.emitted[0]!.payload;
    expect(emitted.subfolder).toBe("03 Deliverables");
    expect(emitted.clientKind).toBe("company");
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId: emitted.requestId, driveFileId: "f", url: "https://example.com/f" });
    expect((await p).status).toBe("saved");
  });
});
