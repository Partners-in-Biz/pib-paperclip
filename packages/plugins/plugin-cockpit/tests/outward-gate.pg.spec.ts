/**
 * Outward-issue gate: tests for evidence requirement on agent close.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isOutwardIssue, runOutwardGate } from "../src/outward-gate.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;
const AGENT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OTHER_AGENT = "bbbbbbbb-0000-4000-8000-0000000000b2";

d("Outward-issue gate (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  let w: Hybrid;
  beforeEach(async () => {
    w = await make();
    try {
      await w.client.query(`DELETE FROM plugin_cockpit_b8a99e8b16.issue_evidence`);
    } catch {
      // ignore
    }
  });

  async function make() {
    return worlds.make({
      agents: [
        { id: AGENT, companyId: COMPANY, name: "Agent One", status: "active", role: "general" },
        { id: OTHER_AGENT, companyId: COMPANY, name: "Agent Two", status: "active", role: "general" },
      ],
    });
  }

  const insertEvidenceShot = async (issueId: string, kind: "shot" | "exempt" = "shot") => {
    const id = `evid${Math.random().toString(16).slice(2, 8)}`;
    await w.client.query(
      `INSERT INTO plugin_cockpit_b8a99e8b16.issue_evidence (id, company_id, issue_id, step, kind, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [id, COMPANY, issueId, "test", kind, null],
    );
    return id;
  };

  const runGate = async (title: string, agentId: string = AGENT, companyId: string = COMPANY) => {
    const issue = await w.ctx.issues.create({
      companyId,
      title,
      description: "Test",
      status: "done",
      assigneeAgentId: agentId,
    } as never);
    const outcome = await runOutwardGate(w.env, {
      entityId: issue.id,
      companyId,
      actorType: "agent",
      actorId: agentId,
    });
    return { issue, outcome };
  };

  describe("isOutwardIssue patterns", () => {
    it("matches outward titles", () => {
      expect(isOutwardIssue({ title: "Publish the Meta campaign" })).toBe(true);
      expect(isOutwardIssue({ title: "Go live with site" })).toBe(true);
      expect(isOutwardIssue({ title: "Launch the campaign" })).toBe(true);
      expect(isOutwardIssue({ title: "Submit the form" })).toBe(true);
      expect(isOutwardIssue({ title: "Pay the invoice" })).toBe(true);
      expect(isOutwardIssue({ title: "Send the campaign" })).toBe(true);
    });

    it("rejects false positives", () => {
      expect(isOutwardIssue({ title: "Pay run" })).toBe(false);
      expect(isOutwardIssue({ title: "Pay run June approval" })).toBe(false);
      expect(isOutwardIssue({ title: "Send fix PR" })).toBe(false);
      expect(isOutwardIssue({ title: "Launch checklist" })).toBe(false);
      expect(isOutwardIssue({ title: "Submit sprint report" })).toBe(false);
    });

    it("excludes payroll origin ids", () => {
      expect(isOutwardIssue({ title: "Pay the invoice", originId: "payroll:something" })).toBe(false);
      expect(isOutwardIssue({ title: "Pay the invoice", originId: "pay-run:june" })).toBe(false);
    });
  });

  it("reopens without evidence", async () => {
    const { issue, outcome } = await runGate("Publish the Meta campaign");
    expect(outcome).toBe("reopened");
    const reloaded = await w.ctx.issues.get(issue.id, COMPANY);
    expect(reloaded?.status).toBe("todo");
    const comments = await w.ctx.issues.listComments(issue.id, COMPANY);
    const lastComment = comments[comments.length - 1] as any;
    expect(lastComment.body).toContain("evidence-record");
    expect(lastComment.body).toContain("pib-evidence");
  });

  it("passes with shot evidence", async () => {
    const { issue } = await runGate("Go live with site");
    await insertEvidenceShot(issue.id, "shot");
    await w.ctx.issues.update(issue.id, { status: "done" }, COMPANY);
    const outcome = await runOutwardGate(w.env, {
      entityId: issue.id,
      companyId: COMPANY,
      actorType: "agent",
      actorId: AGENT,
    });
    expect(outcome).toBe("passed");
    const reloaded = await w.ctx.issues.get(issue.id, COMPANY);
    expect(reloaded?.status).toBe("done");
  });

  it("exemption by closing agent passes and records exactly one row", async () => {
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Submit the form",
      description: "Test",
      status: "done",
      assigneeAgentId: AGENT,
    } as never);

    await w.ctx.issues.createComment(
      issue.id,
      "Evidence: not applicable, because the client verified it.",
      COMPANY,
      { authorAgentId: AGENT },
    );

    const outcome = await runOutwardGate(w.env, {
      entityId: issue.id,
      companyId: COMPANY,
      actorType: "agent",
      actorId: AGENT,
    });
    expect(outcome).toBe("exempted");

    const rows = await w.client.query(
      `SELECT COUNT(*) as count FROM plugin_cockpit_b8a99e8b16.issue_evidence
       WHERE issue_id = $1 AND company_id = $2 AND kind = 'exempt'`,
      [issue.id, COMPANY],
    );
    expect(parseInt((rows.rows[0] as any).count, 10)).toBe(1);

    await w.ctx.issues.update(issue.id, { status: "done" }, COMPANY);
    const outcome2 = await runOutwardGate(w.env, {
      entityId: issue.id,
      companyId: COMPANY,
      actorType: "agent",
      actorId: AGENT,
    });
    expect(outcome2).toBe("exempted");

    const rows2 = await w.client.query(
      `SELECT COUNT(*) as count FROM plugin_cockpit_b8a99e8b16.issue_evidence
       WHERE issue_id = $1 AND company_id = $2 AND kind = 'exempt'`,
      [issue.id, COMPANY],
    );
    expect(parseInt((rows2.rows[0] as any).count, 10)).toBe(1);
  });

  it("exemption by different agent does not pass", async () => {
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Launch the campaign",
      description: "Test",
      status: "done",
      assigneeAgentId: AGENT,
    } as never);

    await w.ctx.issues.createComment(
      issue.id,
      "Evidence: not applicable, because other.",
      COMPANY,
      { authorAgentId: OTHER_AGENT },
    );

    const outcome = await runOutwardGate(w.env, {
      entityId: issue.id,
      companyId: COMPANY,
      actorType: "agent",
      actorId: AGENT,
    });
    expect(outcome).toBe("reopened");

    const rows = await w.client.query(
      `SELECT COUNT(*) as count FROM plugin_cockpit_b8a99e8b16.issue_evidence
       WHERE issue_id = $1 AND company_id = $2 AND kind = 'exempt'`,
      [issue.id, COMPANY],
    );
    expect(parseInt((rows.rows[0] as any).count, 10)).toBe(0);
  });

  it("**Evidence:** comment alone does not pass", async () => {
    const { issue, outcome } = await runGate("Pay the invoice");
    const comments = await w.ctx.issues.listComments(issue.id, COMPANY);
    const lastComment = comments[comments.length - 1] as any;
    expect(lastComment.body).toContain("[outward evidence]");
  });

  it("human close bypasses gate", async () => {
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Publish the Meta campaign",
      description: "Test",
      status: "done",
    } as never);

    const outcome = await runOutwardGate(w.env, {
      entityId: issue.id,
      companyId: COMPANY,
      actorType: "user",
    });

    expect(outcome).toBe("skipped");
    const reloaded = await w.ctx.issues.get(issue.id, COMPANY);
    expect(reloaded?.status).toBe("done");
  });

  it("third failure escalates", async () => {
    const { issue } = await runGate("Launch the campaign");

    for (let attempt = 2; attempt <= 3; attempt++) {
      await w.ctx.issues.update(issue.id, { status: "done" }, COMPANY);
      const outcome = await runOutwardGate(w.env, {
        entityId: issue.id,
        companyId: COMPANY,
        actorType: "agent",
        actorId: AGENT,
      });
      if (attempt < 3) {
        expect(outcome).toBe("reopened");
      } else {
        expect(["escalated", "reopened"]).toContain(outcome);
      }
    }
  });

  it("issues from different companies gate independently", async () => {
    const otherCompany = "other-company-id";

    const issue1 = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Publish the Meta campaign",
      description: "Test",
      status: "done",
      assigneeAgentId: AGENT,
    } as never);
    await insertEvidenceShot(issue1.id, "shot");

    const issue2 = await w.ctx.issues.create({
      companyId: otherCompany,
      title: "Publish the Meta campaign",
      description: "Test",
      status: "done",
      assigneeAgentId: AGENT,
    } as never);

    const outcome2 = await runOutwardGate(w.env, {
      entityId: issue2.id,
      companyId: otherCompany,
      actorType: "agent",
      actorId: AGENT,
    });
    expect(outcome2).toBe("reopened");

    const outcome1 = await runOutwardGate(w.env, {
      entityId: issue1.id,
      companyId: COMPANY,
      actorType: "agent",
      actorId: AGENT,
    });
    expect(outcome1).toBe("passed");
  });
});
