import { describe, expect, it } from "vitest";
import { COCKPIT_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { DRIFT_HEALTH_KEY, driftTitle, refreshDriftIssue, templateDrift } from "../src/drift-job.js";
import manifest, { JOBS } from "../src/manifest.js";
import { varsFor } from "../src/new-company.js";
import { renderHash } from "../src/render-hash.js";
import { saveModules } from "../src/service.js";
import { loadPack } from "../src/templates.js";
import { renderInstructions } from "../src/templates-render.js";
import { registerSetup } from "../src/register.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const A = "company-a";
const B = "company-b";
const templates = loadPack().templates;
const ceoTemplate = templates.find((t) => t.key === "ceo")!;
const companies = { [A]: { name: "Test Co", issuePrefix: "TST" }, [B]: { name: "Empty Co", issuePrefix: "EMP" } };

async function currentHash(ctx: Parameters<typeof varsFor>[0]): Promise<string> {
  const { vars } = await varsFor(ctx, { companyId: A, key: null });
  return renderHash(renderInstructions(ceoTemplate, vars));
}

const ceo = (extra: Record<string, unknown> = {}) => ({
  id: "agent-ceo",
  name: "CEO",
  title: null,
  role: "ceo",
  status: "idle",
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-5-5", effort: "medium", timeoutSec: 3600, maxTurnsPerRun: 300 },
  metadata: null,
  ...extra,
});

const pibPack = (hash: string) => ({ pack: "Q7-5", version: 2, key: "ceo", hash, appliedAt: "2026-10-20T10:00:00.000Z" });

function healthOf(emitted: Array<{ name: string; companyId: string; payload: unknown }>, companyId: string) {
  const events = emitted.filter((e) => e.name === COCKPIT_EVENTS.snapshot && e.companyId === companyId);
  const last = events[events.length - 1]?.payload as { health: Array<{ key: string; status: string }> } | undefined;
  return last?.health.find((h) => h.key === DRIFT_HEALTH_KEY);
}

describe("template drift job", () => {
  it("is declared at :30 every hour in the manifest and registered", () => {
    expect(manifest.jobs?.find((job: { jobKey: string }) => job.jobKey === JOBS.templateDrift)?.schedule).toBe("30 * * * *");
    const { ctx, jobs } = fakeCtx({ companies });
    registerSetup(ctx);
    expect(jobs.has(JOBS.templateDrift)).toBe(true);
  });

  it("opens one issue for a drifted agent, with the work list and the hash from template-get's render", async () => {
    const { ctx, issues, emitted } = fakeCtx({ companies, agents: { [A]: [ceo()] } });
    const out = await refreshDriftIssue(ctx, A, templates);
    expect(out).toEqual({ result: "created", drifted: 1 });
    expect(issues.size).toBe(1);
    const issue = [...issues.values()][0]!;
    expect(issue.title).toBe(driftTitle(1));
    expect(issue.description).toContain("agent-ceo");
    expect(issue.description).toContain(await currentHash(ctx));
    expect(healthOf(emitted, A)?.status).toBe("warn");
  });

  it("a second run updates or leaves the issue and never opens a duplicate", async () => {
    const { ctx, issues } = fakeCtx({ companies, agents: { [A]: [ceo()] } });
    await refreshDriftIssue(ctx, A, templates);
    expect((await refreshDriftIssue(ctx, A, templates)).result).toBe("unchanged");
    expect(issues.size).toBe(1);
  });

  it("updates the open issue when the list changes", async () => {
    const agents = { [A]: [ceo()] as unknown[] };
    const { ctx, issues } = fakeCtx({ companies, agents });
    await refreshDriftIssue(ctx, A, templates);
    agents[A] = [ceo({ metadata: { pibPack: { ...pibPack("0000000000000000") } } })];
    expect((await refreshDriftIssue(ctx, A, templates)).result).toBe("updated");
    expect(issues.size).toBe(1);
    expect([...issues.values()][0]!.description).toContain("expected");
  });

  it("closes the issue by itself at zero and reports ok", async () => {
    const agents = { [A]: [ceo()] as unknown[] };
    const { ctx, issues, emitted } = fakeCtx({ companies, agents });
    await refreshDriftIssue(ctx, A, templates);
    agents[A] = [ceo({ metadata: { pibPack: pibPack(await currentHash(ctx)) } })];
    expect((await refreshDriftIssue(ctx, A, templates)).result).toBe("closed");
    expect([...issues.values()][0]!.status).toBe("done");
    expect(healthOf(emitted, A)?.status).toBe("ok");
    expect((await refreshDriftIssue(ctx, A, templates)).result).toBe("none");
    expect(issues.size).toBe(1);
  });

  it("flags a mid-run agent but does not count it as failing", async () => {
    const { ctx, issues, emitted } = fakeCtx({ companies, agents: { [A]: [ceo({ status: "running" })] } });
    await refreshDriftIssue(ctx, A, templates);
    expect([...issues.values()][0]!.description).toContain("running now");
    expect(healthOf(emitted, A)?.status).toBe("ok");
  });

  it("a company with no pack agents gets no issue", async () => {
    const { ctx, issues } = fakeCtx({ companies, agents: { [B]: [{ id: "x", name: "Someone", title: null, role: "general", status: "idle" }] } });
    expect(await refreshDriftIssue(ctx, B, templates)).toEqual({ result: "none", drifted: 0 });
    expect(issues.size).toBe(0);
  });

  it("the job skips a company whose Setup settings are not saved, and runs for one that is", async () => {
    const { ctx, issues } = fakeCtx({ companies, agents: { [A]: [ceo()] }, savedConfigs: { [A]: { ownerCompany: true } } });
    await saveModules(ctx, { companyId: A, modules: { seo: false }, userId: "user-1" });
    await saveModules(ctx, { companyId: B, modules: { seo: false }, userId: "user-1" });
    const counts = await templateDrift(ctx);
    expect(counts.created).toBe(1);
    expect(counts.skipped ?? 0).toBeLessThanOrEqual(1);
    const drift = () => [...issues.values()].filter((issue) => issue.originId?.startsWith("template-drift:"));
    expect(drift()).toHaveLength(1);
    await templateDrift(ctx);
    expect(drift()).toHaveLength(1);
  });

  it("with a long body (list cuts descriptions), a second run is unchanged and close keeps the full work list", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ceo({ id: `agent-${i}`, name: `CEO ${i}` }));
    const agents = { [A]: many as unknown[] };
    const { ctx, issues } = fakeCtx({ companies, agents });
    // Only one agent matches the ceo template, so give each template a matching agent instead.
    agents[A] = templates.filter((t) => !t.hostOwned).map((t, i) => ({ id: `agent-${i}`, name: t.name, title: t.title ?? null, role: t.role ?? "general", status: "idle", metadata: null }));
    const first = await refreshDriftIssue(ctx, A, templates);
    const issue = [...issues.values()][0]!;
    expect(issue.description.length).toBeGreaterThan(1200);
    expect((await refreshDriftIssue(ctx, A, templates)).result).toBe("unchanged");
    expect(first.drifted).toBeGreaterThan(1);
    agents[A] = [];
    expect((await refreshDriftIssue(ctx, A, templates)).result).toBe("closed");
    expect(issue.status).toBe("done");
    expect(issue.description).toContain("```json");
    expect(issue.description).toContain("Closed by the Setup plugin");
  });

  it("closes an open issue when no agent matches any template any more, and reports ok", async () => {
    const agents = { [A]: [ceo()] as unknown[] };
    const { ctx, issues, emitted } = fakeCtx({ companies, agents });
    await refreshDriftIssue(ctx, A, templates);
    agents[A] = [];
    expect((await refreshDriftIssue(ctx, A, templates)).result).toBe("closed");
    expect([...issues.values()][0]!.status).toBe("done");
    expect(healthOf(emitted, A)?.status).toBe("ok");
  });
});
