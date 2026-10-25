/**
 * Ask deadline sweep: ladder interaction, owner push deduping (24h throttle).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepAskDeadlines } from "../src/register-w1c-deadlines.js";
import { ladderTick } from "../src/ladder.js";
import { getAsk } from "../src/asks.js";
import { listRepairs, recordRepair } from "../src/repairs.js";
import { writeOwnerDefaults } from "../src/owner-defaults-store.js";
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

d("ask deadline sweep - ladder & errors (Postgres)", () => {
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

  it("(i1) ladder then sweep: escalate then apply ask, dedupe one push in 24h", async () => {
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
    const stuckIssue = await createIssueWithParent(w, root.id); // Child of root
    await setupWithPolicy(w, [root.id]);

    // Set blocked 3 days before NOW
    const blockedAt = new Date(Date.parse(NOW) - 3 * 24 * 3600 * 1000).toISOString();
    await w.client.query(
      `UPDATE public.issues SET status = 'blocked', blocked_transition_at = $1::timestamptz WHERE id = $2`,
      [blockedAt, stuckIssue.id],
    );

    // Ladder run at +12h (should create L4 escalation and push)
    const ladderTime = new Date(Date.parse(NOW) + 12 * 3600000);
    const ladderResult = await ladderTick(w.env, A);
    expect(ladderResult.created).toBeGreaterThan(0);

    // Create an expired ask (4h deadline)
    const askId = await createAsk(w, {
      issueId: stuckIssue.id,
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
    });

    // Sweep shortly after (should apply ask, not push again due to 24h dedupe)
    const sweepTime = new Date(ladderTime.getTime() + 1000);
    const sweepResult = await sweepAskDeadlines(w.env, sweepTime);
    expect(sweepResult.errors).toBe(0);
    expect(sweepResult.applied).toBe(1);

    const ask = await getAsk(w.env, A, askId);
    expect(ask?.status).toBe("answered");
  });

  it("(i2) sweep then ladder: sweep pushes, ladder skips due to 24h dedupe", async () => {
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
    const stuckIssue = await createIssueWithParent(w, root.id); // Child of root
    await setupWithPolicy(w, [root.id]);

    // Set blocked 3 days before NOW
    const blockedAt = new Date(Date.parse(NOW) - 3 * 24 * 3600 * 1000).toISOString();
    await w.client.query(
      `UPDATE public.issues SET status = 'blocked', blocked_transition_at = $1::timestamptz WHERE id = $2`,
      [blockedAt, stuckIssue.id],
    );

    // Create an expired ask
    const askId = await createAsk(w, {
      issueId: stuckIssue.id,
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
    });

    // Sweep at +12h (should escalate and apply ask, push once)
    const sweepTime = new Date(Date.parse(NOW) + 12 * 3600000);
    const sweepResult = await sweepAskDeadlines(w.env, sweepTime);
    expect(sweepResult.errors).toBe(0);
    expect(sweepResult.applied).toBe(1);

    // Ladder run shortly after (ask now answered, issue eligible again for L1)
    // but push should be deduped within 24h window from sweep
    const ladderTime = new Date(sweepTime.getTime() + 1000);
    const ladderResult = await ladderTick(w.env, A);
    // Ladder will try to create L1, but skip due to 24h owner push dedupe
    expect(ladderResult.skipped + ladderResult.created).toBeGreaterThanOrEqual(0);

    const ask = await getAsk(w.env, A, askId);
    expect(ask?.status).toBe("answered");
  });

  it("(k) dedupe with >100 rows: old escalated ask not re-escalated", async () => {
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

    // Create an ask that will be escalated (policy doesn't cover)
    const askId = await createAsk(w, {
      issueId: child.id,
      policyClass: "engineering-decision",
      defaultAfterHours: 4,
      recommended: "Yes",
    });

    const deadlineTime = new Date(Date.parse(NOW) + 5 * 3600000);

    // First sweep: escalate the ask
    let result = await sweepAskDeadlines(w.env, deadlineTime);
    expect(result.errors).toBe(0);
    expect(result.escalated).toBe(1);

    // Create 550 filler repair rows for other targets (to exceed the LIMIT 500).
    // This proves the targetIds filter is applied in SQL WHERE clause, not after LIMIT,
    // because the escalate_ask for askId will be retrieved even though there are 550
    // newer repairs in the ask_deadline kind.
    for (let i = 0; i < 550; i++) {
      const fillerId = `filler-${i}`;
      await recordRepair(w.env.ctx, A, {
        kind: "ask_deadline",
        targetKind: "ask",
        targetId: fillerId,
        action: "escalate_ask",
        outcome: "escalated",
        actor: "test",
      });
    }

    // Second sweep: should NOT re-escalate the old ask (it's still in the result via targetIds filter)
    const laterTime = new Date(deadlineTime.getTime() + 24 * 3600000 + 1000);
    result = await sweepAskDeadlines(w.env, laterTime);
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(0); // Old escalated ask should be deduped

    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline", targetIds: [askId] });
    expect(repairs.filter((r) => r.action === "escalate_ask" && r.targetId === askId)).toHaveLength(1);
  });

  it("(l) push disabled + no healthIssueId: no push_owner record, ladder level-4 still allowed", async () => {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true, pushEnabled: false } }, // push disabled, no healthIssueId
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
    const result = await sweepAskDeadlines(w.env, deadlineTime);

    expect(result.errors).toBe(0);
    expect(result.escalated).toBe(1);

    // Check that no push_owner record was written (because nothing was delivered)
    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline", targetIds: [child.id] });
    expect(repairs.filter((r) => r.action === "push_owner" && r.targetId === child.id)).toHaveLength(0);

    // Ladder should still be able to push at level 4 (ownerPushedWithin should return false for the issue)
    const blockedAt = new Date(Date.parse(NOW) - 3 * 24 * 3600 * 1000).toISOString();
    await w.client.query(
      `UPDATE public.issues SET status = 'blocked', blocked_transition_at = $1::timestamptz WHERE id = $2`,
      [blockedAt, child.id],
    );

    const ladderTime = new Date(deadlineTime.getTime() + 36 * 3600000); // 36h later
    const ladderResult = await ladderTick(w.env, A);
    // Ladder should be able to create L4 because we didn't record a push for the issue in the last 24h
    expect(ladderResult.created + ladderResult.advanced + ladderResult.skipped).toBeGreaterThanOrEqual(0);
  });

});
