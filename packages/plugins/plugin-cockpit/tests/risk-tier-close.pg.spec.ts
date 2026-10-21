import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds } from "./helpers/hybrid.js";
import { listRepairs } from "../src/repairs.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

d("risk-tier close (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  it("(a) low-tier issue closes with CR and DF pass when enabled, evidence ids exact", async () => {
    const w = await worlds.make({
      savedConfigs: { [COMPANY]: { riskTierClose: { enabled: true } } },
      agents: [
        { id: "ap", companyId: COMPANY, name: "Planner", role: "Planner", status: "active" },
        { id: "acr", companyId: COMPANY, name: "CR", role: "Code Reviewer", status: "active" },
        { id: "adf", companyId: COMPANY, name: "DF", role: "Dogfood Tester", status: "active" },
      ],
    });
    const id = uuid(), now = new Date().toISOString();
    await w.pg.addIssueToDb({ id, companyId: COMPANY, identifier: "PAR-1", title: "Low", status: "in_review", description: "Risk tier: low" });
    const issue: any = { id, companyId: COMPANY, identifier: "PAR-1", title: "Low", status: "in_review", description: "Risk tier: low", assigneeAgentId: null, assigneeUserId: null, createdAt: now, updatedAt: now, createdByAgentId: "ap" };
    w.issues.set(id, issue);
    const cid1 = uuid(), cid2 = uuid();
    w.comments.push({ id: cid1, issueId: id, companyId: COMPANY, authorAgentId: "acr", authorUserId: null, body: "REVIEW: PASS sha=abc123def456 ci=green", createdAt: now });
    w.comments.push({ id: cid2, issueId: id, companyId: COMPANY, authorAgentId: "adf", authorUserId: null, body: "DOGFOOD: PASS", createdAt: now });
    await w.fire("issue.comment.created", { companyId: COMPANY, entityId: id });
    expect(w.issues.get(id)?.status).toBe("done");
    const cc = w.comments.filter((c) => c.issueId === id && c.body.includes("Closed by Cockpit"));
    expect(cc.length).toBe(1);
    expect(cc[0]?.body).toContain(cid1);
    expect(cc[0]?.body).toContain(cid2);
    expect((await listRepairs(w.env.ctx, COMPANY, { kind: "risk_tier_close" })).length).toBe(1);
  });

  it("switch off: no-op", async () => {
    const w = await worlds.make({ agents: [{ id: "ap", companyId: COMPANY, name: "Planner", role: "Planner", status: "active" }, { id: "acr", companyId: COMPANY, name: "CR", role: "Code Reviewer", status: "active" }, { id: "adf", companyId: COMPANY, name: "DF", role: "Dogfood Tester", status: "active" }] });
    const id = uuid(), now = new Date().toISOString();
    await w.pg.addIssueToDb({ id, companyId: COMPANY, identifier: "PAR-2", title: "Low", status: "in_review", description: "Risk tier: low" });
    const issue: any = { id, companyId: COMPANY, identifier: "PAR-2", title: "Low", status: "in_review", description: "Risk tier: low", assigneeAgentId: null, assigneeUserId: null, createdAt: now, updatedAt: now, createdByAgentId: "ap" };
    w.issues.set(id, issue);
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "acr", authorUserId: null, body: "REVIEW: PASS sha=abc123def456 ci=green", createdAt: now });
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "adf", authorUserId: null, body: "DOGFOOD: PASS", createdAt: now });
    await w.fire("issue.comment.created", { companyId: COMPANY, entityId: id });
    expect(w.issues.get(id)?.status).toBe("in_review");
  });

  it("high tier: never closes", async () => {
    const w = await worlds.make({ savedConfigs: { [COMPANY]: { riskTierClose: { enabled: true } } }, agents: [{ id: "ap", companyId: COMPANY, name: "Planner", role: "Planner", status: "active" }, { id: "acr", companyId: COMPANY, name: "CR", role: "Code Reviewer", status: "active" }, { id: "adf", companyId: COMPANY, name: "DF", role: "Dogfood Tester", status: "active" }] });
    const id = uuid(), now = new Date().toISOString();
    await w.pg.addIssueToDb({ id, companyId: COMPANY, identifier: "PAR-3", title: "High", status: "in_review" });
    const issue: any = { id, companyId: COMPANY, identifier: "PAR-3", title: "High", status: "in_review", description: "", assigneeAgentId: null, assigneeUserId: null, createdAt: now, updatedAt: now, createdByAgentId: "ap" };
    w.issues.set(id, issue);
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "acr", authorUserId: null, body: "REVIEW: PASS sha=abc123def456 ci=green", createdAt: now });
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "adf", authorUserId: null, body: "DOGFOOD: PASS", createdAt: now });
    await w.fire("issue.comment.created", { companyId: COMPANY, entityId: id });
    expect(w.issues.get(id)?.status).toBe("in_review");
  });

  it("host refuses: one warn, no comment/repair, no retry", async () => {
    const w = await worlds.make({ savedConfigs: { [COMPANY]: { riskTierClose: { enabled: true } } }, agents: [{ id: "ap", companyId: COMPANY, name: "Planner", role: "Planner", status: "active" }, { id: "acr", companyId: COMPANY, name: "CR", role: "Code Reviewer", status: "active" }, { id: "adf", companyId: COMPANY, name: "DF", role: "Dogfood Tester", status: "active" }] });
    const id = uuid(), now = new Date().toISOString();
    await w.pg.addIssueToDb({ id, companyId: COMPANY, identifier: "PAR-4", title: "Low", status: "in_review", description: "Risk tier: low" });
    const issue: any = { id, companyId: COMPANY, identifier: "PAR-4", title: "Low", status: "in_review", description: "Risk tier: low", assigneeAgentId: null, assigneeUserId: null, createdAt: now, updatedAt: now, createdByAgentId: "ap" };
    w.issues.set(id, issue);
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "acr", authorUserId: null, body: "REVIEW: PASS sha=abc123def456 ci=green", createdAt: now });
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "adf", authorUserId: null, body: "DOGFOOD: PASS", createdAt: now });
    let calls = 0;
    const orig = w.ctx.issues.update.bind(w.ctx.issues);
    (w.ctx.issues as any).update = async () => { calls++; throw new Error("Refused"); };
    await w.fire("issue.comment.created", { companyId: COMPANY, entityId: id });
    expect(calls).toBe(1);
    expect(w.comments.filter((c) => c.issueId === id && c.body.includes("Closed")).length).toBe(0);
    w.ctx.issues.update = orig;
    calls = 0;
    (w.ctx.issues as any).update = async () => { calls++; };
    await w.fire("issue.updated", { companyId: COMPANY, entityId: id });
    expect(calls).toBe(0);
  });

  it("(e) second event: no-op", async () => {
    const w = await worlds.make({ savedConfigs: { [COMPANY]: { riskTierClose: { enabled: true } } }, agents: [{ id: "ap", companyId: COMPANY, name: "Planner", role: "Planner", status: "active" }, { id: "acr", companyId: COMPANY, name: "CR", role: "Code Reviewer", status: "active" }, { id: "adf", companyId: COMPANY, name: "DF", role: "Dogfood Tester", status: "active" }] });
    const id = uuid(), now = new Date().toISOString();
    await w.pg.addIssueToDb({ id, companyId: COMPANY, identifier: "PAR-5", title: "Low", status: "in_review", description: "Risk tier: low" });
    const issue: any = { id, companyId: COMPANY, identifier: "PAR-5", title: "Low", status: "in_review", description: "Risk tier: low", assigneeAgentId: null, assigneeUserId: null, createdAt: now, updatedAt: now, createdByAgentId: "ap" };
    w.issues.set(id, issue);
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "acr", authorUserId: null, body: "REVIEW: PASS sha=abc123def456 ci=green", createdAt: now });
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "adf", authorUserId: null, body: "DOGFOOD: PASS", createdAt: now });
    let calls = 0;
    const orig = w.ctx.issues.update.bind(w.ctx.issues);
    (w.ctx.issues as any).update = async (issueId: string, patch: any, cid: string) => { calls++; const r = await orig(issueId, patch, cid); const i = w.issues.get(issueId); if (i) i.status = "done"; return r; };
    await w.fire("issue.comment.created", { companyId: COMPANY, entityId: id });
    expect(calls).toBe(1);
    w.ctx.issues.update = orig;
    calls = 0;
    (w.ctx.issues as any).update = async () => { calls++; };
    await w.fire("issue.updated", { companyId: COMPANY, entityId: id });
    expect(calls).toBe(0);
    expect(w.comments.filter((c) => c.issueId === id && c.body.includes("Closed by Cockpit")).length).toBe(1);
  });

  it("(f) verdicts arriving after first event: first event no-op, second event closes", async () => {
    const w = await worlds.make({ savedConfigs: { [COMPANY]: { riskTierClose: { enabled: true } } }, agents: [{ id: "ap", companyId: COMPANY, name: "Planner", role: "Planner", status: "active" }, { id: "acr", companyId: COMPANY, name: "CR", role: "Code Reviewer", status: "active" }, { id: "adf", companyId: COMPANY, name: "DF", role: "Dogfood Tester", status: "active" }] });
    const id = uuid(), now = new Date().toISOString();
    await w.pg.addIssueToDb({ id, companyId: COMPANY, identifier: "PAR-6", title: "Low", status: "in_review", description: "Risk tier: low" });
    const issue: any = { id, companyId: COMPANY, identifier: "PAR-6", title: "Low", status: "in_review", description: "Risk tier: low", assigneeAgentId: null, assigneeUserId: null, createdAt: now, updatedAt: now, createdByAgentId: "ap" };
    w.issues.set(id, issue);
    await w.fire("issue.comment.created", { companyId: COMPANY, entityId: id });
    expect(w.issues.get(id)?.status).toBe("in_review");
    expect(w.comments.filter((c) => c.issueId === id && c.body.includes("Closed by Cockpit")).length).toBe(0);
    expect((await listRepairs(w.env.ctx, COMPANY, { kind: "risk_tier_close" })).length).toBe(0);
    const cid1 = uuid(), cid2 = uuid();
    w.comments.push({ id: cid1, issueId: id, companyId: COMPANY, authorAgentId: "acr", authorUserId: null, body: "REVIEW: PASS sha=abc123def456 ci=green", createdAt: now });
    w.comments.push({ id: cid2, issueId: id, companyId: COMPANY, authorAgentId: "adf", authorUserId: null, body: "DOGFOOD: PASS", createdAt: now });
    await w.fire("issue.comment.created", { companyId: COMPANY, entityId: id });
    expect(w.issues.get(id)?.status).toBe("done");
    expect(w.comments.filter((c) => c.issueId === id && c.body.includes("Closed by Cockpit")).length).toBe(1);
    expect((await listRepairs(w.env.ctx, COMPANY, { kind: "risk_tier_close" })).length).toBe(1);
  });

  it("(g) PASS from non-role agent: does not close, not in evidence", async () => {
    const w = await worlds.make({ savedConfigs: { [COMPANY]: { riskTierClose: { enabled: true } } }, agents: [{ id: "ap", companyId: COMPANY, name: "Planner", role: "Planner", status: "active" }, { id: "acr", companyId: COMPANY, name: "CR", role: "Code Reviewer", status: "active" }, { id: "adf", companyId: COMPANY, name: "DF", role: "Dogfood Tester", status: "active" }, { id: "other", companyId: COMPANY, name: "Other", status: "active" }] });
    const id = uuid(), now = new Date().toISOString();
    await w.pg.addIssueToDb({ id, companyId: COMPANY, identifier: "PAR-7", title: "Low", status: "in_review", description: "Risk tier: low" });
    const issue: any = { id, companyId: COMPANY, identifier: "PAR-7", title: "Low", status: "in_review", description: "Risk tier: low", assigneeAgentId: null, assigneeUserId: null, createdAt: now, updatedAt: now, createdByAgentId: "ap" };
    w.issues.set(id, issue);
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "other", authorUserId: null, body: "REVIEW: PASS sha=abc123def456 ci=green", createdAt: now });
    w.comments.push({ id: uuid(), issueId: id, companyId: COMPANY, authorAgentId: "other", authorUserId: null, body: "DOGFOOD: PASS", createdAt: now });
    await w.fire("issue.comment.created", { companyId: COMPANY, entityId: id });
    expect(w.issues.get(id)?.status).toBe("in_review");
    expect((await listRepairs(w.env.ctx, COMPANY, { kind: "risk_tier_close" })).length).toBe(0);
  });
});
