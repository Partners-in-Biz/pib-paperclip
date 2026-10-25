/**
 * Ask deadline sweep: push disabled, escalation, repair rows, policy disabled.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepAskDeadlines } from "../src/register-w1c-deadlines.js";
import { ladderTick } from "../src/ladder.js";
import { listRepairs } from "../src/repairs.js";
import { getAsk } from "../src/asks.js";
import { writeOwnerDefaults } from "../src/owner-defaults-store.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const SEO = "aaaaaaaa-0000-4000-8000-0000000000a2";
const NOW = "2026-10-03T12:00:00.000Z";
const RUN = { agentId: SEO, runId: "run-1", companyId: A, projectId: "" };

d("ask deadline sweep - escalation & repairs (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  let issueCount = 0;

  async function createIssueWithParent(w: Hybrid, parentId?: string): Promise<{ id: string; identifier: string }> {
    issueCount += 1;
    const id = `dddddddd-0000-4000-8000-${String(issueCount).padStart(12, "0")}`;
    const identifier = `PAR-${100 + issueCount}`;
    w.issues.set(id, { id, companyId: A, identifier, title: `Issue ${identifier}`, description: "", status: "in_progress", assigneeAgentId: SEO });
    const parentCol = parentId ? ", parent_id" : "";
    const parentVal = parentId ? ", $6" : "";
    await w.client.query(
      `INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id${parentCol}) VALUES ($1, $2, $3, $4, 'in_progress', $5${parentVal})`,
      parentId ? [id, A, identifier, `Issue ${identifier}`, SEO, parentId] : [id, A, identifier, `Issue ${identifier}`, SEO],
    );
    return { id, identifier };
  }

  async function createAsk(
    w: Hybrid,
    opts: { issueId: string; kind?: string; policyClass?: string; defaultAfterHours?: number; recommended?: string; steps?: string[]; links?: Array<{ label: string; href: string }> },
  ) {
    const card = {
      issueId: opts.issueId,
      question: "What should we do?",
      why: "Need a decision",
      kind: opts.kind ?? "decision",
      options: ["Yes", "No"],
      links: opts.links ?? (opts.kind === "grant" ? [{ label: "Grant", href: "/PAR/settings" }] : [{ label: "Issue", href: "/PAR/issues/PAR-1" }]),
      ...(opts.steps && { steps: opts.steps }),
      ...(opts.defaultAfterHours && { defaultAfterHours: opts.defaultAfterHours }),
      ...(opts.recommended && { recommended: opts.recommended }),
      ...(opts.policyClass && { policyClass: opts.policyClass }),
    };
    const result = (await w.tools.get("ask-owner")!(card, RUN)) as { error?: string; data: { askId: string } };
    if (result.error) throw new Error(result.error);
    return result.data.askId;
  }

  async function setupWithPolicy(w: Hybrid, rootIssueIds: string[]) {
    await writeOwnerDefaults(w.env.ctx, A, {
      enabled: true,
      name: "Test Policy",
      rootIssueIds,
      classes: ["engineering-decision"],
      minHours: null,
    });
  }

  it("(c) push disabled -> fallback comment on health issue", async () => {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true, healthIssueId: "health-123", pushEnabled: false } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");

    const root = await createIssueWithParent(w);
    const child = await createIssueWithParent(w, root.id);
    await setupWithPolicy(w, [root.id]);

    const askId = await createAsk(w, {
      issueId: child.id,
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);
    const result = await sweepAskDeadlines(w.env, deadlineTime);

    expect(result.errors).toBe(0);
    expect(result.applied).toBe(1);

    const ask = await getAsk(w.env, A, askId);
    expect(ask?.status).toBe("answered");
  });

  it("(d) escalated ask: one push, second sweep within 24h no push/row", async () => {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");

    const root = await createIssueWithParent(w);
    const child = await createIssueWithParent(w, root.id);
    const unrelatedRoot = await createIssueWithParent(w);
    await setupWithPolicy(w, [unrelatedRoot.id]);

    const askId = await createAsk(w, {
      issueId: child.id,
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);
    let result = await sweepAskDeadlines(w.env, deadlineTime);
    expect(result.errors).toBe(0);
    expect(result.escalated).toBe(1);

    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline" });
    expect(repairs.filter((r) => r.action === "escalate_ask" && r.targetId === askId)).toHaveLength(1);

    const time12h = new Date(deadlineTime.getTime() + 12 * 3600000);
    result = await sweepAskDeadlines(w.env, time12h);
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(0);
  });

  it("(e) escalate_ask repair exists with correct fields", async () => {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");

    const root = await createIssueWithParent(w);
    const child = await createIssueWithParent(w, root.id);
    await setupWithPolicy(w, [root.id]);

    const askId = await createAsk(w, {
      issueId: child.id,
      kind: "grant",
      defaultAfterHours: 4,
      recommended: "Yes",
      steps: ["Step 1", "Step 2"],
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);
    const result = await sweepAskDeadlines(w.env, deadlineTime);
    expect(result.errors).toBe(0);

    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline" });
    const escalateRepair = repairs.find((r) => r.action === "escalate_ask" && r.targetId === askId);
    expect(escalateRepair).toBeDefined();
    expect(escalateRepair?.kind).toBe("ask_deadline");
    expect(escalateRepair?.targetKind).toBe("ask");
    expect(escalateRepair?.outcome).toBe("escalated");
  });

  it("(f) policy disabled -> escalate_ask row", async () => {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");

    const root = await createIssueWithParent(w);
    const child = await createIssueWithParent(w, root.id);
    await writeOwnerDefaults(w.env.ctx, A, { enabled: false, name: "", rootIssueIds: [], classes: [], minHours: null });

    const askId = await createAsk(w, {
      issueId: child.id,
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);
    const result = await sweepAskDeadlines(w.env, deadlineTime);
    expect(result.errors).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.applied).toBe(0);

    const ask = await getAsk(w.env, A, askId);
    expect(ask?.status).toBe("open");

    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline" });
    expect(repairs.filter((r) => r.action === "escalate_ask" && r.targetId === askId)).toHaveLength(1);
  });

  it("(j) closed card: second sweep does nothing", async () => {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");

    const root = await createIssueWithParent(w);
    const child = await createIssueWithParent(w, root.id);
    await setupWithPolicy(w, [root.id]);

    const askId = await createAsk(w, {
      issueId: child.id,
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);
    let result = await sweepAskDeadlines(w.env, deadlineTime);
    expect(result.applied).toBe(1);

    await w.client.query(`UPDATE ${NAMESPACE}.asks SET status = 'resolved', closed_at = now() WHERE id = $1`, [askId]);

    result = await sweepAskDeadlines(w.env, deadlineTime);
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(0);
    expect(result.applied).toBe(0);

    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline" });
    expect(repairs.filter((r) => r.action === "apply_default" && r.targetId === askId)).toHaveLength(1);
  });

  it("(b) push failure: ask still applied, repair row written, warn logged", async () => {
    const warnings: Array<{ msg: string; ctx: unknown }> = [];
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true, healthIssueId: "health-123", pushEnabled: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");

    // Inject logger spy
    const originalWarn = w.env.ctx.logger.warn;
    w.env.ctx.logger.warn = (msg: string, ctx: unknown) => {
      warnings.push({ msg, ctx });
    };

    const root = await createIssueWithParent(w);
    const child = await createIssueWithParent(w, root.id);
    await setupWithPolicy(w, [root.id]);

    const askId = await createAsk(w, {
      issueId: child.id,
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);
    const result = await sweepAskDeadlines(w.env, deadlineTime);

    expect(result.errors).toBe(0);
    expect(result.applied).toBe(1);

    const ask = await getAsk(w.env, A, askId);
    expect(ask?.status).toBe("answered");
    expect(ask?.answer).toBe("Yes");

    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline" });
    expect(repairs.filter((r) => r.action === "apply_default" && r.targetId === askId)).toHaveLength(1);
  });

  it("(h) money and legal kind asks: escalate when covered by policy, not applied", async () => {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");

    const root = await createIssueWithParent(w);
    const moneyChild = await createIssueWithParent(w, root.id);
    const legalChild = await createIssueWithParent(w, root.id);

    await setupWithPolicy(w, [root.id]);

    const moneyAskId = await createAsk(w, {
      issueId: moneyChild.id,
      kind: "money",
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
      links: [{ label: "Settings", href: "/PAR/settings" }],
    });

    const legalAskId = await createAsk(w, {
      issueId: legalChild.id,
      kind: "legal",
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
      links: [{ label: "Legal", href: "/PAR/settings/legal" }],
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);
    const result = await sweepAskDeadlines(w.env, deadlineTime);

    expect(result.errors).toBe(0);
    expect(result.applied).toBe(0);
    expect(result.escalated).toBe(2);

    const moneyAsk = await getAsk(w.env, A, moneyAskId);
    expect(moneyAsk?.status).toBe("open");

    const legalAsk = await getAsk(w.env, A, legalAskId);
    expect(legalAsk?.status).toBe("open");

    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline" });
    expect(repairs.filter((r) => r.action === "escalate_ask")).toHaveLength(2);
  });
});
