import { describe, expect, it, vi, beforeEach } from "vitest";
import { evidenceFileName, parseEvidenceClient, saveEvidenceToDrive, EVIDENCE_SUBFOLDER } from "../src/evidence-drive.js";

const { fakeDriveSave, realDriveSave } = vi.hoisted(() => ({ fakeDriveSave: vi.fn(), realDriveSave: { fn: null as null | ((...a: unknown[]) => unknown) } }));
vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => {
  const actual = await orig<typeof import("@partnersinbiz/pib-plugin-kit")>();
  realDriveSave.fn = actual.driveSave as (...a: unknown[]) => unknown;
  return { ...actual, driveSave: fakeDriveSave };
});

describe("evidence-drive functions", () => {
  const mockCtx = {
    logger: { warn: vi.fn() },
  } as unknown as Parameters<typeof saveEvidenceToDrive>[0];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("evidenceFileName", () => {
    it("builds filename from issue id, step, and timestamp", () => {
      const name = evidenceFileName("PAR-123", "login", "20261021T101500Z");
      expect(name).toBe("PAR-123-login-20261021T101500Z.png");
    });

    it("sanitizes step name to lowercase and replaces special chars", () => {
      const name = evidenceFileName("PAR-456", "Screenshot Email!", "20261021T101500Z");
      expect(name).toBe("PAR-456-screenshot-email--20261021T101500Z.png");
    });

    it("matches the expected pattern", () => {
      const pattern = /^[A-Z]+-\d+-[a-z0-9-]+-\d{8}T\d{6}Z\.png$/;
      expect(evidenceFileName("PAR-789", "fill-form", "20261021T101500Z")).toMatch(pattern);
      expect(evidenceFileName("PIB-1", "step", "20261021T010101Z")).toMatch(pattern);
    });

    it("rejects invalid issue ids", () => {
      expect(() => evidenceFileName("INVALID", "step", "20261021T101500Z")).toThrow();
      expect(() => evidenceFileName("PAR-abc", "step", "20261021T101500Z")).toThrow();
      expect(() => evidenceFileName("123-PAR", "step", "20261021T101500Z")).toThrow();
    });
  });

  describe("saveEvidenceToDrive", () => {
    const validPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    it("calls driveSave with correct subfolder and mimeType", async () => {
      fakeDriveSave.mockResolvedValue({ status: "saved", requestId: "r", driveFileId: "f", url: "https://drive.example/f" });

      await saveEvidenceToDrive(mockCtx, {
        companyId: "co-1",
        projectId: "proj-1",
        issueId: "PAR-123",
        step: "login",
        pngBase64: validPngBase64,
      });

      expect(fakeDriveSave).toHaveBeenCalledOnce();
      const call = fakeDriveSave.mock.calls[0]!;
      expect(call[1]).toMatchObject({
        subfolder: EVIDENCE_SUBFOLDER,
        mimeType: "image/png",
        kind: "ops",
      });
    });

    it("generates filename matching PAR-123-step-YYYYMMDDTHHMMSSZ.png pattern", async () => {
      fakeDriveSave.mockResolvedValue({ status: "saved", requestId: "r", driveFileId: "f", url: "https://drive.example/f" });

      await saveEvidenceToDrive(mockCtx, {
        companyId: "co-1",
        projectId: "proj-1",
        issueId: "PAR-456",
        step: "submit-form",
        pngBase64: validPngBase64,
      });

      const call = fakeDriveSave.mock.calls[0]!;
      const name = call[1]!.name as string;
      expect(name).toMatch(/^PAR-456-submit-form-\d{8}T\d{6}Z\.png$/);
    });

    it("rejects invalid PNG signature", async () => {
      const result = await saveEvidenceToDrive(mockCtx, {
        companyId: "co-1",
        projectId: "proj-1",
        issueId: "PAR-123",
        step: "login",
        pngBase64: "aGVsbG8gd29ybGQ=", // "hello world" in base64, not PNG
      });

      expect(result).toBeNull();
      expect(fakeDriveSave).not.toHaveBeenCalled();
      expect(mockCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid PNG"), expect.anything());
    });

    it("rejects invalid issue id", async () => {
      const result = await saveEvidenceToDrive(mockCtx, {
        companyId: "co-1",
        projectId: "proj-1",
        issueId: "INVALID",
        step: "login",
        pngBase64: validPngBase64,
      });

      expect(result).toBeNull();
      expect(fakeDriveSave).not.toHaveBeenCalled();
      expect(mockCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not save evidence"), expect.anything());
    });

    it("never throws on driveSave rejection", async () => {
      fakeDriveSave.mockRejectedValue(new Error("network error"));

      const result = await saveEvidenceToDrive(mockCtx, {
        companyId: "co-1",
        projectId: "proj-1",
        issueId: "PAR-123",
        step: "login",
        pngBase64: validPngBase64,
      });

      expect(result).toBeNull();
      expect(mockCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not save evidence"), expect.anything());
    });

    it("never throws on driveSave failed result", async () => {
      fakeDriveSave.mockResolvedValue({ status: "failed", requestId: "r", reason: "drive_not_bound" });

      const result = await saveEvidenceToDrive(mockCtx, {
        companyId: "co-1",
        projectId: "proj-1",
        issueId: "PAR-123",
        step: "login",
        pngBase64: validPngBase64,
      });

      expect(result).toEqual({ status: "failed", requestId: "r", reason: "drive_not_bound" });
      expect(mockCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not save evidence"), expect.anything());
    });

    it("never throws on driveSave no_ack (timeout)", async () => {
      fakeDriveSave.mockResolvedValue({ status: "no_ack", requestId: "r" });

      const result = await saveEvidenceToDrive(mockCtx, {
        companyId: "co-1",
        projectId: "proj-1",
        issueId: "PAR-123",
        step: "login",
        pngBase64: validPngBase64,
      });

      expect(result).toEqual({ status: "no_ack", requestId: "r" });
      expect(mockCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not save evidence"), expect.anything());
    });

    it("waits 20 s for the CRM ack, under the 30 s gateway cut (PAR-10202)", async () => {
      fakeDriveSave.mockResolvedValue({ status: "no_ack", requestId: "r" });
      await saveEvidenceToDrive(mockCtx, { companyId: "co-1", projectId: "proj-1", issueId: "PAR-123", step: "login", pngBase64: validPngBase64 });
      expect(fakeDriveSave.mock.calls[0]![1]).toMatchObject({ timeoutMs: 20_000 });
    });

    it("returns result on success", async () => {
      const success = { status: "saved" as const, requestId: "r", driveFileId: "f123", url: "https://drive.example/f" };
      fakeDriveSave.mockResolvedValue(success);

      const result = await saveEvidenceToDrive(mockCtx, {
        companyId: "co-1",
        projectId: "proj-1",
        issueId: "PAR-123",
        step: "login",
        pngBase64: validPngBase64,
      });

      expect(result).toEqual(success);
      expect(mockCtx.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("optional client (PAR-7734)", () => {
    const validPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const emit = vi.fn();
    const eventCtx = {
      logger: { warn: vi.fn(), info: vi.fn() },
      events: { emit, on: vi.fn() },
    } as unknown as Parameters<typeof saveEvidenceToDrive>[0];

    beforeEach(() => {
      // Run the kit's real driveSave so the emitted drive.save-requested payload is checked; short timeout -> no_ack.
      fakeDriveSave.mockImplementation((ctx: unknown, opts: Record<string, unknown>) => realDriveSave.fn!(ctx, { ...opts, timeoutMs: 5 }));
    });

    const saveRequests = () => emit.mock.calls.filter((c) => c[0] === "drive.save-requested").map((c) => c[2] as Record<string, unknown>);

    it("with client: drive.save-requested carries clientKind/clientRef", async () => {
      await saveEvidenceToDrive(eventCtx, { companyId: "co-1", issueId: "PAR-1", step: "login", pngBase64: validPngBase64, client: { kind: "company", ref: "canary-abc12345" } });
      const payloads = saveRequests();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ clientKind: "company", clientRef: "canary-abc12345", kind: "ops", subfolder: EVIDENCE_SUBFOLDER });
    });

    it("no project and no client: the copy is skipped, nothing emitted (PAR-8128)", async () => {
      const result = await saveEvidenceToDrive(eventCtx, { companyId: "co-1", issueId: "PAR-1", step: "login", pngBase64: validPngBase64 });
      expect(result).toMatchObject({ status: "failed", reason: "no_client" });
      expect(fakeDriveSave).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it("with the issue's project: drive.save-requested carries projectId and no agent client (PAR-8128)", async () => {
      await saveEvidenceToDrive(eventCtx, { companyId: "co-1", issueId: "PAR-1", step: "login", pngBase64: validPngBase64, projectId: "proj-1", client: { kind: "company", ref: "someone-else" } });
      const payloads = saveRequests();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ projectId: "proj-1", kind: "ops" });
      expect(payloads[0]).not.toHaveProperty("clientRef");
      expect(payloads[0]).not.toHaveProperty("ownWork");
    });

    it.each([
      [{ kind: "project", ref: "x" }, "client.kind"],
      [{ kind: "company", ref: "  " }, "client.ref"],
      [{ kind: "contact" }, "client.ref"],
      ["company", "client must be an object"],
    ])("invalid client %j: clear error, nothing emitted", async (client, msg) => {
      const parsed = parseEvidenceClient(client);
      expect(parsed).toEqual({ error: expect.stringContaining(msg) });
      const result = await saveEvidenceToDrive(eventCtx, { companyId: "co-1", issueId: "PAR-1", step: "login", pngBase64: validPngBase64, client: client as never });
      expect(result).toBeNull();
      expect(fakeDriveSave).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it("parseEvidenceClient: absent -> null, valid -> trimmed ref", () => {
      expect(parseEvidenceClient(undefined)).toEqual({ client: null });
      expect(parseEvidenceClient({ kind: "contact", ref: " c-1 " })).toEqual({ client: { kind: "contact", ref: "c-1" } });
    });
  });
});
