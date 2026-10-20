import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sentCopyName, saveSentCopy } from "../src/sent-copy.js";

const { fakeDriveSave } = vi.hoisted(() => ({ fakeDriveSave: vi.fn() }));
vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => {
  const original = await orig<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return { ...original, driveSave: fakeDriveSave };
});

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("sentCopyName", () => {
  const date = new Date("2026-10-20");
  it.each<["invoice" | "quote", string, number, string | RegExp]>([
    ["invoice", "INV-0042", 1, "2026-10-20 Invoice INV-0042 v01.pdf"],
    ["quote", "Q-LUM-007", 3, "2026-10-20 Quote Q-LUM-007 v03.pdf"],
    ["invoice", "INV/0042 x", 1, "2026-10-20 Invoice INV0042x v01.pdf"],
    ["invoice", "", 5, /^\d{4}-\d{2}-\d{2}\s+Invoice\s+v05\.pdf$/],
  ])("formats %s number=%s seq=%d", (kind, num, seq, expected) => {
    const name = sentCopyName(kind, num, date, seq);
    typeof expected === "string" ? expect(name).toBe(expected) : expect(name).toMatch(expected);
  });

  it("regex+padding", () => {
    const name = sentCopyName("invoice", "INV-0001", date, 1);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+$/);
    expect(sentCopyName("invoice", "I", date, 10)).toContain(" v10.pdf");
  });
});

describe("saveSentCopy", () => {
  const input = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  let ctx: PluginContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = { logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as PluginContext;
    fakeDriveSave.mockResolvedValue({ status: "saved", requestId: "r", driveFileId: "f", url: "https://drive.example/f" });
  });

  it("correct params and sha256", async () => {
    const result = await saveSentCopy(ctx, { companyId: "co-1", kind: "invoice", number: "INV-0042", seq: 1, bytes: input, customerKind: "contact", customerRef: "ct-lumen" });
    expect(result).not.toBeNull();
    const opts = fakeDriveSave.mock.calls[0]![1];
    expect(opts.companyId).toBe("co-1");
    expect(opts.kind).toBe("client");
    expect(opts.subfolder).toBe("03 Deliverables");
    expect(opts.mimeType).toBe("application/pdf");
    expect(sha256(opts.bytes)).toBe(sha256(input));
    expect((result as any).status).toBe("saved");
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  it.each<[string, any]>([
    ["failed", { status: "failed", requestId: "r", reason: "drive_not_bound" }],
    ["no_ack", { status: "no_ack", requestId: "r" }],
  ])("handles %s: warn, no bytes in log", async (_, mockResult) => {
    fakeDriveSave.mockResolvedValue(mockResult);
    const result = await saveSentCopy(ctx, { companyId: "co-1", kind: "invoice", number: "INV-0042", seq: 1, bytes: input, customerKind: "contact", customerRef: "ct-lumen" });
    expect(result).toEqual(mockResult);
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((ctx.logger.warn as any).mock.calls[0])).not.toContain(Buffer.from(input).toString("base64"));
  });

  it.each<[string, () => void]>([["rejects", () => fakeDriveSave.mockRejectedValue(new Error())], ["throws", () => fakeDriveSave.mockImplementation(() => { throw new Error(); })]])("handles %s: null, warn", async (_, setup) => {
    setup();
    const result = await saveSentCopy(ctx, { companyId: "co-1", kind: "invoice", number: "INV-0042", seq: 1, bytes: input, customerKind: "contact", customerRef: "ct-lumen" });
    expect(result).toBeNull();
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
  });
});
