/**
 * PAR-7733: the report Drive copy on a sent report email. A real send files the report and saves "YYYY-MM-01 <client> v01.html";
 * a canary dry run saves one "YYYY-MM-01 DRY RUN <client> v01.html" copy and files nothing; a real-client dry run does neither.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { canaryContactId } from "../src/canary-flag.js";

const { fakeDriveSave, fakeFiling, fakeGetReport } = vi.hoisted(() => ({ fakeDriveSave: vi.fn(), fakeFiling: vi.fn(), fakeGetReport: vi.fn() }));
vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => ({ ...await orig(), driveSave: fakeDriveSave, wakeIssue: vi.fn(async () => undefined) }));
vi.mock("../src/care-store.js", async (orig) => ({ ...await orig(), getReportById: fakeGetReport, setReportStatus: vi.fn(async () => undefined) }));
vi.mock("../src/care-clients.js", async (orig) => ({ ...await orig(), clientInfo: vi.fn(async () => ({ name: "Acme Ltd" })), logOnClient: vi.fn(async () => undefined) }));
vi.mock("../src/filing.js", async (orig) => ({ ...await orig(), openReportFilingIssue: fakeFiling }));

const { reportHooks } = await import("../src/report.js");

const CO = "co-1";
const ctx = { logger: { warn: vi.fn(), info: vi.fn() }, issues: { createComment: vi.fn(async () => undefined) } } as never;

async function send(clientId: string, dryRun: boolean) {
  const record = { id: "rep-1", companyId: CO, client: { kind: "contact", id: clientId }, period: "2026-10", html: "<p>report</p>", issueId: null, status: "awaiting_approval" };
  fakeGetReport.mockResolvedValue(record);
  await reportHooks.onSent!(ctx, { kind: "client_report", companyId: CO, subjectId: "rep-1" } as never, { dryRun } as never);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("report email sent: Drive copy and filing issue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDriveSave.mockResolvedValue({ status: "saved", requestId: "r", driveFileId: "f", url: "https://drive.example/f" });
    fakeFiling.mockResolvedValue(undefined);
  });

  it("canary dry run: exactly one Drive save with the DRY RUN name, and no filing issue", async () => {
    await send(canaryContactId(CO), true);
    expect(fakeDriveSave).toHaveBeenCalledOnce();
    expect(fakeDriveSave.mock.calls[0]![1]).toMatchObject({ name: "2026-10-01 DRY RUN Acme Ltd v01.html", subfolder: "04 Reports", client: { kind: "contact", ref: canaryContactId(CO) } });
    expect(fakeFiling).not.toHaveBeenCalled();
  });

  it("real-client dry run: no Drive save and no filing issue", async () => {
    await send("contact-real", true);
    expect(fakeDriveSave).not.toHaveBeenCalled();
    expect(fakeFiling).not.toHaveBeenCalled();
  });

  it("real send: the normal name and one filing issue, unchanged", async () => {
    await send("contact-real", false);
    expect(fakeDriveSave).toHaveBeenCalledOnce();
    expect(fakeDriveSave.mock.calls[0]![1]).toMatchObject({ name: "2026-10-01 Acme Ltd v01.html" });
    expect(fakeFiling).toHaveBeenCalledOnce();
  });

  it("real send on the canary client still files and saves the normal name", async () => {
    await send(canaryContactId(CO), false);
    expect(fakeDriveSave.mock.calls[0]![1]).toMatchObject({ name: "2026-10-01 Acme Ltd v01.html" });
    expect(fakeFiling).toHaveBeenCalledOnce();
  });
});
