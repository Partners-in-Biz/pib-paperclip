/**
 * evidence-save in an acceptance journey (PAR-10122): the acceptance issue a journey runs under has a project, and the
 * project decides the folder (PAR-8128), so the canary's evidence was refused (no_project). With acceptanceRunId the
 * running canary run names the client; the agent's own `client` still never overrides a project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rehearsalEvidenceClient } from "../src/acceptance-model.js";
import type { Env } from "../src/env.js";
import { runOpsTool } from "../src/ops-tools.js";

const { fakeDriveSave } = vi.hoisted(() => ({ fakeDriveSave: vi.fn() }));
vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => {
  const actual = await orig<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return { ...actual, driveSave: fakeDriveSave };
});

const COMPANY = "11111111-0000-4000-8000-000000000001";
const RUN_ID = "run0a1b2c3d4e5f";
const CANARY = "company:canary-9f8e7d6c";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4oRGFFTEMLQkAWChSgXZ/mz4AAAAASUVORK5CYII=";

function env(run: { status: string; clientRef: string } | null): Env {
  const row = run
    ? { id: RUN_ID, company_id: COMPANY, journey_key: "drive-producers-canary", journey_version: 2, client_ref: run.clientRef, trigger: "on-demand", trigger_ref: null, status: run.status, state: {}, request_issue_id: null, report_issue_id: null, child_issue_ids: {}, agent_id: null, summary: null, report: null, started_at: "2026-11-12T08:00:00Z", updated_at: "2026-11-12T08:00:00Z", finished_at: null }
    : null;
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() },
    db: { query: vi.fn(async (_sql: string, args: unknown[]) => (row && args[1] === RUN_ID ? [row] : [])) },
    issues: { get: vi.fn(async () => ({ id: "issue-1", identifier: "PAR-10114", projectId: "project-pib-platform" })) },
  };
  return { ctx, now: () => new Date("2026-11-12T08:05:00Z") } as unknown as Env;
}

const call = (e: Env, params: Record<string, unknown>) => runOpsTool(e, "evidence-save", params, { companyId: COMPANY, agentId: "agent-1", runId: "hb-1", projectId: "" } as never) as Promise<{ error?: string; data?: any }>;

describe("evidence-save for an acceptance journey step", () => {
  beforeEach(() => {
    fakeDriveSave.mockReset();
    fakeDriveSave.mockResolvedValue({ status: "saved", requestId: "r1", driveFileId: "f1", url: "https://drive.google.com/file/d/f1" });
  });

  it("files the canary's evidence under the run's canary client, not the acceptance issue's project", async () => {
    const out = await call(env({ status: "running", clientRef: CANARY }), { issueId: "PAR-10114", step: `drive-journey-${RUN_ID}`, pngBase64: PNG, acceptanceRunId: RUN_ID });
    expect(out.data).toMatchObject({ saved: true, driveFileId: "f1" });
    const args = fakeDriveSave.mock.calls[0]![1];
    expect(args).toMatchObject({ client: { kind: "company", ref: "canary-9f8e7d6c" }, subfolder: "05 Evidence" });
    expect(args).not.toHaveProperty("projectId");
    expect(args.name).toMatch(new RegExp(`^PAR-10114-drive-journey-${RUN_ID}-\\d{8}T\\d{6}Z\\.png$`));
  });

  it("without acceptanceRunId the issue's project still wins over the agent's client (PAR-8128)", async () => {
    await call(env(null), { issueId: "PAR-10114", step: "login", pngBase64: PNG, client: { kind: "company", ref: "someone-else" } });
    const args = fakeDriveSave.mock.calls[0]![1];
    expect(args).toMatchObject({ projectId: "project-pib-platform" });
    expect(args).not.toHaveProperty("client");
  });

  it("refuses an unknown, finished or non-canary run, and a step that does not carry the run id: nothing is saved", async () => {
    const base = { issueId: "PAR-10114", pngBase64: PNG, acceptanceRunId: RUN_ID, step: `drive-journey-${RUN_ID}` };
    expect((await call(env(null), base)).error).toMatch(/No acceptance run/);
    expect((await call(env({ status: "passed", clientRef: CANARY }), base)).error).toMatch(/is passed/);
    expect((await call(env({ status: "running", clientRef: "company:acme" }), base)).error).toMatch(/not on the canary/);
    expect((await call(env({ status: "running", clientRef: CANARY }), { ...base, step: "login" })).error).toMatch(/must contain the run id/);
    expect(fakeDriveSave).not.toHaveBeenCalled();
  });
});

describe("rehearsalEvidenceClient", () => {
  it("gives the run's canary record id", () => {
    expect(rehearsalEvidenceClient({ id: RUN_ID, status: "running", clientRef: CANARY }, RUN_ID, `x-${RUN_ID}`)).toEqual({ client: { kind: "company", ref: "canary-9f8e7d6c" } });
  });
});
