/**
 * Ask deadline sweep: every 15 minutes, find asks with expired deadlines
 * and apply standing policy or escalate to owner.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepAskDeadlines } from "../src/register-w1c-deadlines.js";
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

d("ask deadline sweep (Postgres)", () => {
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
    const issue = { id, companyId: A, identifier, title: `Issue ${identifier}`, description: "", status: "in_progress", assigneeAgentId: SEO };
    w.issues.set(id, issue);
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
    opts: {
      issueId: string;
      kind?: string;
      policyClass?: string;
      defaultAfterHours?: number;
      recommended?: string;
      effect?: any;
      links?: Array<{ label: string; href: string }>;
      steps?: string[];
    },
  ) {
    const card = {
      issueId: opts.issueId,
      question: "What should we do?",
      why: "Need a decision",
      kind: opts.kind ?? "decision",
      options: ["Yes", "No"],
      links: opts.links ?? [{ label: "Issue", href: "/PAR/issues/PAR-1" }],
      ...(opts.steps && { steps: opts.steps }),
      ...(opts.defaultAfterHours && { defaultAfterHours: opts.defaultAfterHours }),
      ...(opts.recommended && { recommended: opts.recommended }),
      ...(opts.policyClass && { policyClass: opts.policyClass }),
      ...(opts.effect && { effect: opts.effect }),
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

  async function sweepAt(w: Hybrid, time: Date) {
    const result = await sweepAskDeadlines(w.env, time);
    if (result.errors > 0) {
      console.log("Sweep result with errors:", result);
    }
    return result;
  }

  it("applies ask when policy covers root issue", async () => {
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
    const result = await sweepAt(w, deadlineTime);

    expect(result.errors).toBe(0);
    expect(result.processed).toBe(1);
    expect(result.applied).toBe(1);

    const ask = await getAsk(w.env, A, askId);
    expect(ask?.status).toBe("answered");
    expect(ask?.answer).toBe("Yes");
  });

  it("policy does not cover: waits, then the 24-hour rule applies the recommended answer and says so", async () => {
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
    const result = await sweepAt(w, deadlineTime);

    // Past its own deadline but not 24 hours old: nothing happens, and nothing is escalated.
    expect(result).toMatchObject({ errors: 0, escalated: 0, applied: 0, processed: 0 });
    expect((await getAsk(w.env, A, askId))?.status).toBe("open");

    const after = await sweepAt(w, new Date(Date.parse(NOW) + 24 * 3600000 + 60_000));
    expect(after).toMatchObject({ errors: 0, escalated: 0, applied: 1 });
    const ask = await getAsk(w.env, A, askId);
    expect(ask).toMatchObject({ status: "answered", answer: "Yes", defaultPolicy: "24-hour default" });
    expect(ask?.defaultAppliedAt).toBeTruthy();
    const said = w.comments.filter((c) => c.issueId === child.id).map((c) => c.body);
    expect(said.some((b) => b.startsWith("No reply in 24 hours, so the recommended answer was applied: **Yes**"))).toBe(true);
    // The agent is woken with its own answer, not told the owner replied.
    expect(w.wakeReasons.at(-1)?.reason).toContain("Nobody replied");

    // Once only.
    const again = await sweepAt(w, new Date(Date.parse(NOW) + 30 * 3600000));
    expect(again).toMatchObject({ applied: 0, escalated: 0 });
  });

  it("the 24-hour rule needs no deadline from the agent: the first option is the recommended one", async () => {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    const issue = await createIssueWithParent(w);
    const askId = await createAsk(w, { issueId: issue.id });
    const row = await getAsk(w.env, A, askId);
    expect(row).toMatchObject({ recommended: "Yes", defaultAfterHours: 24 });
    expect(row?.deadlineAt).toBe(new Date(Date.parse(NOW) + 24 * 3600000).toISOString());
    // The card tells the owner what happens.
    expect(w.comments.find((c) => c.issueId === issue.id)?.body).toContain("With no reply in 24 hours the recommended answer applies by itself: **Yes**");

    expect((await sweepAt(w, new Date(Date.parse(NOW) + 23 * 3600000))).applied).toBe(0);
    expect((await sweepAt(w, new Date(Date.parse(NOW) + 24 * 3600000 + 60_000))).applied).toBe(1);
    expect((await getAsk(w.env, A, askId))?.answer).toBe("Yes");
  });

  it("a hard stop never applies: by its words, by its kind, or named by the asker", async () => {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    const ask = async (extra: Record<string, unknown>) => {
      const issue = await createIssueWithParent(w);
      const result = (await w.tools.get("ask-owner")!(
        { issueId: issue.id, question: "What should we do?", why: "Need a decision", kind: "decision", options: ["Yes", "No"], links: [{ label: "Issue", href: "/PAR/issues/PAR-1" }], ...extra },
        RUN,
      )) as { error?: string; data: { askId: string; hardStop: string | null; autoApply: unknown } };
      if (result.error) throw new Error(result.error);
      return { issue, ...result.data };
    };
    const byWords = await ask({ question: "Send quote Q-HUN-001 for R 6,860.00 to Hunt and Gun?" });
    const byKind = await ask({ kind: "money", question: "Approve the spend?", links: [{ label: "Billing", href: "/PAR/billing" }] });
    const named = await ask({ hardStop: "client-production" });
    expect([byWords.hardStop, byKind.hardStop, named.hardStop]).toEqual(["money", "money", "client-production"]);
    for (const a of [byWords, byKind, named]) {
      expect(a.autoApply).toBeNull();
      // No deadline, and the card does not promise an answer.
      expect((await getAsk(w.env, A, a.askId))?.deadlineAt).toBeNull();
      expect(w.comments.find((c) => c.issueId === a.issue.id)?.body).not.toContain("applies by itself");
    }
    const result = await sweepAt(w, new Date(Date.parse(NOW) + 72 * 3600000));
    expect(result).toMatchObject({ applied: 0, errors: 0 });
    for (const a of [byWords, byKind, named]) expect((await getAsk(w.env, A, a.askId))?.status).toBe("open");
  });


  it("applies idempotently: second sweep does nothing", async () => {
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

    let result = await sweepAt(w, deadlineTime);
    expect(result.errors).toBe(0);
    expect(result.applied).toBe(1);

    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline" });
    expect(repairs.filter((r) => r.action === "apply_default" && r.targetId === askId)).toHaveLength(1);

    result = await sweepAt(w, deadlineTime);
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(0);
  });

  it("escalates effect asks", async () => {
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
      effect: { key: "mailbox.delegate", params: { accountId: "acc-1" } },
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);
    const result = await sweepAt(w, deadlineTime);

    expect(result.errors).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.applied).toBe(0);

    const ask = await getAsk(w.env, A, askId);
    expect(ask?.status).toBe("open");
  });

  it("escalates unsafe kinds", async () => {
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

    const grantId = await createAsk(w, {
      issueId: child.id,
      kind: "grant",
      defaultAfterHours: 4,
      recommended: "Yes",
      links: [{ label: "Grant", href: "/PAR/settings" }],
      steps: ["Open Settings", "Click Grant"],
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);
    const result = await sweepAt(w, deadlineTime);

    expect(result.errors).toBe(0);
    expect(result.escalated).toBe(1);

    const ask = await getAsk(w.env, A, grantId);
    expect(ask?.status).toBe("open");
  });

  it("concurrent sweeps apply atomically", async () => {
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

    const [result1, result2] = await Promise.all([sweepAt(w, deadlineTime), sweepAt(w, deadlineTime)]);

    const totalApplied = result1.applied + result2.applied;
    expect(totalApplied).toBe(1);
    expect(result1.errors + result2.errors).toBe(0);

    const ask = await getAsk(w.env, A, askId);
    expect(ask?.status).toBe("answered");

    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline" });
    expect(repairs.filter((r) => r.action === "apply_default" && r.targetId === askId)).toHaveLength(1);
    // When concurrent sweep succeeds on apply, no escalate_ask should be written for this ask
    expect(repairs.filter((r) => r.action === "escalate_ask" && r.targetId === askId)).toHaveLength(0);
  });
});
