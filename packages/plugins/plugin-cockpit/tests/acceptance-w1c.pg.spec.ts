/**
 * W1c canary acceptance journey (Postgres): an owner-only check nobody answers
 * past a short canary deadline never holds the engineering issue behind it; the
 * recommended option is applied and logged; a planted over-strict blocker edge
 * is announced by the edge watch, and the Operator's documented fix names it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepAskDeadlines } from "../src/register-w1c-deadlines.js";
import { getAsk } from "../src/asks.js";
import { listRepairs } from "../src/repairs.js";
import { writeOwnerDefaults } from "../src/owner-defaults-store.js";
import { STALLS_REFERENCE } from "../src/skill-references.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ENG = "aaaaaaaa-0000-4000-8000-0000000000a2";
const NOW = "2026-10-05T01:00:00.000Z";
const RUN = { agentId: ENG, runId: "run-w1c", companyId: A, projectId: "" };
const id = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;

d("W1c canary journey: stall-proof chain (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  it("applies the recommended option after the canary deadline, leaves the engineering issue unblocked, then announces a planted over-strict edge", async () => {
    const w = await worlds.make(
      {
        savedConfigs: { [A]: { healthIssue: true, edgeWatch: { enabled: true } } },
        prefixes: { [A]: "PAR" },
        agents: [
          { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
          { id: ENG, companyId: A, name: "Sam", status: "active", role: "general" },
        ],
      },
      NOW,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");

    // Canary tree: a root and the engineering issue behind the owner-only check.
    const rootId = id(1);
    const engId = id(2);
    const mk = async (issueId: string, identifier: string, title: string, parentId: string | null) => {
      w.issues.set(issueId, { id: issueId, companyId: A, identifier, title, description: "", status: "in_progress", assigneeAgentId: ENG });
      await w.client.query(
        `INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, parent_id) VALUES ($1, $2, $3, $4, 'in_progress', $5, $6)`,
        [issueId, A, identifier, title, ENG, parentId],
      );
    };
    await mk(rootId, "PAR-901", "Canary root", null);
    await mk(engId, "PAR-902", "Canary engineering work", rootId);

    // Short canary deadline: the policy floor (minHours) is lowered to 1h.
    await writeOwnerDefaults(w.env.ctx, A, { enabled: true, name: "Canary policy", rootIssueIds: [rootId], classes: ["engineering-decision"], minHours: 1 });

    const created = (await w.tools.get("ask-owner")!(
      {
        issueId: engId,
        question: "Use the staging copy for the canary?",
        why: "Owner-only check; engineering must not wait on it",
        kind: "decision",
        options: ["Yes", "No"],
        links: [{ label: "Issue", href: "/PAR/issues/PAR-902" }],
        defaultAfterHours: 1,
        recommended: "Yes",
        policyClass: "engineering-decision",
      },
      RUN,
    )) as { error?: string; data: { askId: string } };
    expect(created.error).toBeUndefined();
    const askId = created.data.askId;

    // Before the deadline: nothing is applied, the issue is not blocked.
    const early = await sweepAskDeadlines(w.env, new Date(Date.parse(NOW) + 30 * 60_000));
    expect(early.errors).toBe(0);
    expect(early.applied).toBe(0);
    expect((await getAsk(w.env, A, askId))?.status).toBe("open");

    // Past the deadline, still unanswered: the recommended option is applied and logged.
    const late = await sweepAskDeadlines(w.env, new Date(Date.parse(NOW) + 90 * 60_000));
    expect(late.errors).toBe(0);
    expect(late.applied).toBe(1);
    const ask = await getAsk(w.env, A, askId);
    expect(ask?.status).toBe("answered");
    expect(ask?.answer).toBe("Yes");
    const repairs = await listRepairs(w.env.ctx, A, { kind: "ask_deadline" });
    expect(repairs.filter((r) => r.action === "apply_default" && r.targetId === askId)).toHaveLength(1);

    // The engineering issue was never blocked or held by the owner check.
    const rows = await w.client.query(`SELECT status FROM public.issues WHERE id = $1`, [engId]);
    expect((rows.rows[0] as { status: string }).status).toBe("in_progress");

    // Planted over-strict edge: an owner-assigned check blocks the engineering issue.
    const ownerCheck = id(3);
    const nowIso = new Date(Date.parse(NOW)).toISOString();
    await w.pg.addIssueToDb({ id: ownerCheck, companyId: A, identifier: "PAR-903", title: "Owner approves scope", status: "todo", assigneeUserId: "owner" });
    w.issues.set(ownerCheck, { id: ownerCheck, companyId: A, identifier: "PAR-903", title: "Owner approves scope", status: "todo", assigneeUserId: "owner", assigneeAgentId: null, description: "", createdAt: nowIso, updatedAt: nowIso });
    const edgeAt = new Date(Date.parse(NOW) + 2 * 3600_000).toISOString();
    w.clock.set(edgeAt);
    await w.pg.addRelationToDb(A, ownerCheck, engId, edgeAt);
    await w.fire("issue.relations.updated", { companyId: A, entityId: engId, payload: { blockedByIssueIds: [ownerCheck] } });

    const onEng = w.comments.filter((c) => c.issueId === engId && c.body.includes("<!-- edge-watch:"));
    expect(onEng).toHaveLength(1);
    expect(onEng[0]?.body).toContain("PAR-903");
    expect(onEng[0]?.body).toContain("waiting on a person");
    expect(onEng[0]?.body).toContain("Remove this edge");

    // The documented Operator-fix path names the exact edge to drop and leaves the edit to the assignee.
    expect(STALLS_REFERENCE).toContain("Over-strict owner edge");
    expect(STALLS_REFERENCE).toContain("blockedByIssueIds");
    expect(STALLS_REFERENCE).toContain("Never patch another agent's issue fields directly");
  });
});
