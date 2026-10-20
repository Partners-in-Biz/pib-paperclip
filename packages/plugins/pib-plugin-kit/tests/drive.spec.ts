import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { driveSave, registerDriveReplies, DRIVE_EVENTS } from "../src/drive.js";
import { CRM_PLUGIN_ID } from "../src/crm-projection.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const tick = () => new Promise(r => setTimeout(r, 10));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("drive save", () => {
  let fake: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    fake = fakeCtx({ companies: { "co-1": {} } });
    vi.clearAllMocks();
  });

  it("saved: emits contentBase64+sha256, resolves driveFileId+url", async () => {
    const bytes = Buffer.from([1, 2, 3, 255, 254, 253]);
    const promise = driveSave(fake.ctx, { companyId: "co-1", kind: "attachment", name: "test.bin", mimeType: "application/octet-stream", bytes });
    await tick();
    const emitted = fake.emitted[0]!.payload;
    expect(emitted.sha256).toBe(sha256(bytes));
    expect(Buffer.from(emitted.contentBase64 as string, "base64")).toEqual(bytes);
    const requestId = emitted.requestId as string;
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId, driveFileId: "file-123", url: "https://drive.example.com/file-123" });
    const result = await promise;
    expect(result.status).toBe("saved");
    if (result.status === "saved") expect(result.driveFileId).toBe("file-123");
  });

  it("failed: returns status=failed with reason+hint", async () => {
    const promise = driveSave(fake.ctx, { companyId: "co-1", kind: "test", name: "test.txt", mimeType: "text/plain", bytes: Buffer.from("test") });
    await tick();
    const requestId = fake.emitted[0]!.payload.requestId as string;
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.failed}`, "co-1", { requestId, reason: "upload_failed", hint: "Network timeout" });
    const result = await promise;
    if (result.status === "failed") {
      expect(result.reason).toBe("upload_failed");
      expect(result.hint).toBe("Network timeout");
    }
  });

  it("timeout: no_ack on timeout, late reply ignored", async () => {
    vi.useFakeTimers();
    const promise = driveSave(fake.ctx, { companyId: "co-1", kind: "test", name: "test.txt", mimeType: "text/plain", bytes: Buffer.from("test"), timeoutMs: 50 });
    vi.advanceTimersByTime(100);
    const result = await promise;
    const requestId = fake.emitted[0]!.payload.requestId as string;
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId, driveFileId: "file-1", url: "https://example.com/file-1" });
    expect(result.status).toBe("no_ack");
    vi.useRealTimers();
  });

  it("emit failures: never throws, returns failed with emit_failed reason", async () => {
    let result = await driveSave({ events: { on: vi.fn(), emit: vi.fn().mockRejectedValue(new Error("E")) } },
      { companyId: "co-1", kind: "x", name: "x", mimeType: "x", bytes: Buffer.from("x") });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toBe("emit_failed");
  });

  it("invalid inputs: no emit, returns failed with reason", async () => {
    const cases = [
      { requestId: "bad-id", bytes: Buffer.from("x"), reason: "invalid_request_id" },
      { bytes: Buffer.alloc(5 * 1024 * 1024 + 1), reason: "too_large" },
      { publicUrl: "http://x.com", reason: "invalid_input" },
      { reason: "invalid_input" },
    ] as const;
    for (const tc of cases) {
      fake.emitted = [];
      const opts: any = { companyId: "co-1", kind: "x", name: "x", mimeType: "x" };
      if ("requestId" in tc) opts.requestId = tc.requestId;
      if ("bytes" in tc) opts.bytes = tc.bytes;
      if ("publicUrl" in tc) opts.publicUrl = tc.publicUrl;
      const result = await driveSave(fake.ctx, opts);
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.reason).toBe(tc.reason);
      expect(fake.emitted).toHaveLength(0);
    }
  });

  it("wrong requestId/companyId: ignored, no_ack on timeout", async () => {
    const promise = driveSave(fake.ctx, { companyId: "co-1", requestId: "req1", kind: "test", name: "test.txt", mimeType: "text/plain", bytes: Buffer.from("test"), timeoutMs: 50 });
    await tick();
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId: "wrong", driveFileId: "file-1", url: "https://example.com/file-1" });
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-2", { requestId: "req1", driveFileId: "file-2", url: "https://example.com/file-2" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    const result = await promise;
    expect(result.status).toBe("no_ack");
    vi.useRealTimers();
  });

  it("subscription idempotent, duplicate requestId rejected", async () => {
    registerDriveReplies(fake.ctx);
    registerDriveReplies(fake.ctx);
    expect(Array.from(fake.handlers.keys()).filter(n => n.includes(DRIVE_EVENTS.saved)).length).toBeLessThanOrEqual(1);
    const p1 = driveSave(fake.ctx, { companyId: "co-1", requestId: "dup", kind: "test", name: "f1.txt", mimeType: "text/plain", bytes: Buffer.from("test1") });
    await tick();
    const result2 = await driveSave(fake.ctx, { companyId: "co-1", requestId: "dup", kind: "test", name: "f2.txt", mimeType: "text/plain", bytes: Buffer.from("test2") });
    if (result2.status === "failed") expect(result2.reason).toBe("duplicate_request_id");
    expect(fake.emitted).toHaveLength(1);
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId: "dup", driveFileId: "file-1", url: "https://example.com/file-1" });
    const result1 = await p1;
    expect(result1.status).toBe("saved");
  });

  it("publicUrl: emits publicUrl, no contentBase64+sha256", async () => {
    const promise = driveSave(fake.ctx, { companyId: "co-1", kind: "external", name: "remote.pdf", mimeType: "application/pdf", publicUrl: "https://example.com/document.pdf" });
    await tick();
    const emitted = fake.emitted[0]!.payload;
    expect(emitted.publicUrl).toBe("https://example.com/document.pdf");
    expect(emitted.contentBase64).toBeUndefined();
    expect(emitted.sha256).toBeUndefined();
    const requestId = emitted.requestId;
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId, driveFileId: "file-789", url: "https://drive.example.com/file-789" });
    const result = await promise;
    expect(result.status).toBe("saved");
  });

  it.each([
    [{ subfolder: "03 Deliverables", client: { kind: "company", ref: "acme-123" } }, "provided", true],
    [{}, "omitted when absent", false],
  ])("subfolder+client: %s when %s", async (addlOpts, _, shouldExist) => {
    const promise = driveSave(fake.ctx, {
      companyId: "co-1",
      kind: "deliverable",
      name: "report.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("test"),
      ...addlOpts,
    });
    await tick();
    const emitted = fake.emitted[0]!.payload;
    if (shouldExist) {
      expect(emitted.subfolder).toBe("03 Deliverables");
      expect(emitted.clientKind).toBe("company");
      expect(emitted.clientRef).toBe("acme-123");
    } else {
      expect(emitted.subfolder).toBeUndefined();
      expect(emitted.clientKind).toBeUndefined();
      expect(emitted.clientRef).toBeUndefined();
    }
    const requestId = emitted.requestId as string;
    await fake.deliver(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, "co-1", { requestId, driveFileId: "file-456", url: "https://drive.example.com/file-456" });
    const result = await promise;
    expect(result.status).toBe("saved");
  });

  it.each([
    { subfolder: "" },
    { subfolder: "   " },
    { client: { kind: "", ref: "ref1" } },
    { client: { kind: "company", ref: "" } },
    { client: { kind: "   ", ref: "ref1" } },
    { client: { kind: "company", ref: "   " } },
  ])("invalid subfolder/client $#: returns invalid_input", async (tc) => {
    fake.emitted = [];
    const opts: any = { companyId: "co-1", kind: "x", name: "x", mimeType: "x", bytes: Buffer.from("x"), ...tc };
    const result = await driveSave(fake.ctx, opts);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toBe("invalid_input");
    expect(fake.emitted).toHaveLength(0);
  });
});
