import { describe, expect, it, vi, beforeEach } from "vitest";
import { reportFileName, saveReportCopy, REPORTS_SUBFOLDER } from "../src/report-copy.js";

const { fakeDriveSave } = vi.hoisted(() => ({ fakeDriveSave: vi.fn() }));
vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => ({ ...await orig(), driveSave: fakeDriveSave }));

describe("report-copy functions", () => {
  const mockCtx = {
    logger: { warn: vi.fn() },
  } as unknown as Parameters<typeof saveReportCopy>[0];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("reportFileName", () => {
    it("builds filename with date, sanitized name, and version", () => {
      expect(reportFileName("Acme Corp", "2026-09", 1)).toBe("2026-09-01 Acme Corp v01.html");
      expect(reportFileName("Test <Client> & Co.", "2026-12", 5)).toBe("2026-12-01 Test Client  Co v05.html");
      expect(reportFileName("Client-99", "2026-01", 2)).toBe("2026-01-01 Client-99 v02.html");
    });

    it("pads version to 2 digits", () => {
      expect(reportFileName("Acme", "2026-09", 1)).toMatch(/v01/);
      expect(reportFileName("Acme", "2026-09", 12)).toMatch(/v12/);
      expect(reportFileName("Acme", "2026-09", 100)).toMatch(/v100/);
    });
  });

  describe("saveReportCopy", () => {
    it("calls driveSave with correct subfolder, mimeType, and client", async () => {
      fakeDriveSave.mockResolvedValue({ status: "saved", requestId: "r", driveFileId: "f", url: "https://drive.example/f" });

      await saveReportCopy(mockCtx, {
        companyId: "co-1",
        clientName: "Acme Corp",
        period: "2026-09",
        seq: 1,
        html: "<html>Report</html>",
        client: { kind: "company", id: "acme-1" },
      });

      expect(fakeDriveSave).toHaveBeenCalledOnce();
      const call = fakeDriveSave.mock.calls[0]!;
      expect(call[1]).toMatchObject({
        subfolder: REPORTS_SUBFOLDER,
        mimeType: "text/html",
        kind: "client",
        client: { kind: "company", ref: "acme-1" },
      });
    });

    it("encodes HTML as bytes", async () => {
      fakeDriveSave.mockResolvedValue({ status: "saved", requestId: "r", driveFileId: "f", url: "https://drive.example/f" });
      const html = "<html>Report</html>";

      await saveReportCopy(mockCtx, {
        companyId: "co-1",
        clientName: "Acme",
        period: "2026-09",
        seq: 1,
        html,
        client: { kind: "contact", id: "contact-1" },
      });

      const call = fakeDriveSave.mock.calls[0]!;
      const bytes = call[1]!.bytes as Uint8Array;
      expect(new TextDecoder().decode(bytes)).toBe(html);
    });

    it("never throws on driveSave rejection", async () => {
      fakeDriveSave.mockRejectedValue(new Error("network error"));

      const result = await saveReportCopy(mockCtx, {
        companyId: "co-1",
        clientName: "Acme",
        period: "2026-09",
        seq: 1,
        html: "<html>Report</html>",
        client: { kind: "company", id: "acme-1" },
      });

      expect(result).toBeNull();
      expect(mockCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not save"), expect.objectContaining({ period: "2026-09" }));
    });

    it("never throws on driveSave failed result", async () => {
      fakeDriveSave.mockResolvedValue({ status: "failed", requestId: "r", reason: "drive_not_bound" });

      const result = await saveReportCopy(mockCtx, {
        companyId: "co-1",
        clientName: "Acme",
        period: "2026-09",
        seq: 1,
        html: "<html>Report</html>",
        client: { kind: "company", id: "acme-1" },
      });

      expect(result).toEqual({ status: "failed", requestId: "r", reason: "drive_not_bound" });
      expect(mockCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not save"), expect.objectContaining({ status: "failed" }));
    });

    it("never throws on driveSave no_ack (timeout)", async () => {
      fakeDriveSave.mockResolvedValue({ status: "no_ack", requestId: "r" });

      const result = await saveReportCopy(mockCtx, {
        companyId: "co-1",
        clientName: "Acme",
        period: "2026-09",
        seq: 1,
        html: "<html>Report</html>",
        client: { kind: "company", id: "acme-1" },
      });

      expect(result).toEqual({ status: "no_ack", requestId: "r" });
      expect(mockCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not save"), expect.objectContaining({ status: "no_ack" }));
    });

    it("returns result on success", async () => {
      const success = { status: "saved" as const, requestId: "r", driveFileId: "f123", url: "https://drive.example/f" };
      fakeDriveSave.mockResolvedValue(success);

      const result = await saveReportCopy(mockCtx, {
        companyId: "co-1",
        clientName: "Acme",
        period: "2026-09",
        seq: 1,
        html: "<html>Report</html>",
        client: { kind: "company", id: "acme-1" },
      });

      expect(result).toEqual(success);
      expect(mockCtx.logger.warn).not.toHaveBeenCalled();
    });
  });
});
