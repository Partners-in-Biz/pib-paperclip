/**
 * Unit tests for sent-copy.ts: PDF naming and fire-and-forget save logic.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import { sentCopyName, saveSentCopy } from "../src/sent-copy.js";

// Hoisted before module imports
const { fakeDriveSave } = vi.hoisted(() => ({
  fakeDriveSave: vi.fn(),
}));

vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => {
  const original = await orig<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return {
    ...original,
    driveSave: fakeDriveSave,
  };
});

describe("sentCopyName", () => {
  it("formats invoice name with date, kind, number, and padded seq", () => {
    const date = new Date("2026-10-20T14:30:00Z");
    const name = sentCopyName("invoice", "INV-0042", date, 1);
    expect(name).toBe("2026-10-20 Invoice INV-0042 v01.pdf");
  });

  it("formats quote name with date, kind, number, and padded seq", () => {
    const date = new Date("2026-10-20T14:30:00Z");
    const name = sentCopyName("quote", "Q-LUM-007", date, 3);
    expect(name).toBe("2026-10-20 Quote Q-LUM-007 v03.pdf");
  });

  it("sanitizes number: removes non-alphanumeric and dash characters", () => {
    const date = new Date("2026-10-20");
    const name = sentCopyName("invoice", "INV/0042 x", date, 1);
    expect(name).toBe("2026-10-20 Invoice INV0042x v01.pdf");
  });

  it("pads seq to 2 digits", () => {
    const date = new Date("2026-10-20");
    expect(sentCopyName("invoice", "INV-0001", date, 1)).toContain(" v01.pdf");
    expect(sentCopyName("invoice", "INV-0001", date, 10)).toContain(" v10.pdf");
    expect(sentCopyName("invoice", "INV-0001", date, 99)).toContain(" v99.pdf");
  });

  it("matches the required regex pattern", () => {
    const date = new Date("2026-10-20");
    const name = sentCopyName("invoice", "INV-0042", date, 1);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+$/);
  });

  it("handles empty number by keeping the sanitized result", () => {
    const date = new Date("2026-10-20");
    const name = sentCopyName("invoice", "", date, 5);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}\s+Invoice\s+v05\.pdf$/);
  });
});

describe("saveSentCopy", () => {
  let ctx: PluginContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = {
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as unknown as PluginContext;
    fakeDriveSave.mockResolvedValue({
      status: "saved",
      requestId: "r",
      driveFileId: "f",
      url: "https://drive.example/f",
    });
  });

  it("passes to driveSave with exact parameters and matching sha256", async () => {
    const input = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF" prefix
    const now = new Date("2026-10-20T10:00:00Z");

    const result = await saveSentCopy(ctx, {
      companyId: "co-1",
      kind: "invoice",
      number: "INV-0042",
      seq: 1,
      bytes: input,
      customerKind: "contact",
      customerRef: "ct-lumen",
      now,
    });

    expect(fakeDriveSave).toHaveBeenCalledTimes(1);
    const call = fakeDriveSave.mock.calls[0]!;
    const opts = call[1];

    // Verify exact parameters
    expect(opts.companyId).toBe("co-1");
    expect(opts.kind).toBe("client");
    expect(opts.subfolder).toBe("03 Deliverables");
    expect(opts.mimeType).toBe("application/pdf");
    expect(opts.name).toMatch(/^\d{4}-\d{2}-\d{2}\s+Invoice\s+INV-0042\s+v01\.pdf$/);
    expect(opts.client).toEqual({ kind: "contact", ref: "ct-lumen" });

    // Verify bytes are the same reference and sha256 matches
    expect(opts.bytes).toBe(input);
    const inputSha256 = createHash("sha256").update(input).digest("hex");
    const callSha256 = createHash("sha256").update(opts.bytes).digest("hex");
    expect(callSha256).toBe(inputSha256);

    // Verify result is returned
    expect(result).toEqual({
      status: "saved",
      requestId: "r",
      driveFileId: "f",
      url: "https://drive.example/f",
    });
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  it("handles {status: failed} response: resolves, logs warning, does not log bytes", async () => {
    const input = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    fakeDriveSave.mockResolvedValue({
      status: "failed",
      requestId: "r",
      reason: "drive_not_bound",
    });

    const result = await saveSentCopy(ctx, {
      companyId: "co-1",
      kind: "invoice",
      number: "INV-0042",
      seq: 1,
      bytes: input,
      customerKind: "contact",
      customerRef: "ct-lumen",
    });

    expect(result).toEqual({
      status: "failed",
      requestId: "r",
      reason: "drive_not_bound",
    });
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    const warnFn = ctx.logger.warn as any;
    const warnCall = warnFn.mock.calls[0];
    const warnStr = JSON.stringify(warnCall);
    expect(warnStr).not.toContain(Buffer.from(input).toString("base64"));
  });

  it("handles {status: no_ack} response: resolves, logs warning", async () => {
    const input = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    fakeDriveSave.mockResolvedValue({
      status: "no_ack",
      requestId: "r",
    });

    const result = await saveSentCopy(ctx, {
      companyId: "co-1",
      kind: "quote",
      number: "Q-001",
      seq: 2,
      bytes: input,
      customerKind: "contact",
      customerRef: "ct-lumos",
    });

    expect(result).toEqual({
      status: "no_ack",
      requestId: "r",
    });
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("handles fake rejects: resolves null, logs warning", async () => {
    const input = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    fakeDriveSave.mockRejectedValue(new Error("Network error"));

    const result = await saveSentCopy(ctx, {
      companyId: "co-1",
      kind: "invoice",
      number: "INV-0042",
      seq: 1,
      bytes: input,
      customerKind: "contact",
      customerRef: "ct-lumen",
    });

    expect(result).toBeNull();
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("handles fake throws synchronously: resolves null, logs warning", async () => {
    const input = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    fakeDriveSave.mockImplementation(() => {
      throw new Error("boom");
    });

    const result = await saveSentCopy(ctx, {
      companyId: "co-1",
      kind: "quote",
      number: "Q-001",
      seq: 1,
      bytes: input,
      customerKind: "contact",
      customerRef: "ct-lumos",
    });

    expect(result).toBeNull();
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("handles {status: saved} response: returns it, does not warn", async () => {
    const input = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const savedResult = {
      status: "saved" as const,
      requestId: "r-saved",
      driveFileId: "f-saved",
      url: "https://drive.example/f-saved",
    };
    fakeDriveSave.mockResolvedValue(savedResult);

    const result = await saveSentCopy(ctx, {
      companyId: "co-1",
      kind: "invoice",
      number: "INV-0042",
      seq: 1,
      bytes: input,
      customerKind: "contact",
      customerRef: "ct-lumen",
    });

    expect(result).toEqual(savedResult);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });
});
