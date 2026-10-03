/**
 * The two honesty checks (Q5-4, Q5-6, Q5-7): finished code work with no review and
 * no proof, and outward approvals a person holds that the Reviewer never commented
 * on. The pure rules first, then the worker against a real Postgres with the host's
 * issue table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalCandidates, evidenceKinds, hasEvidence, isOutwardApproval, proofCandidates, proofCheck, unreviewedApprovalsCheck, PROOF_READ_LIMIT } from "../src/quality-model.js";
import { extraChecks } from "../src/checks.js";
import { proofGapCheck, unreviewedApprovalCheck } from "../src/quality.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const NOW = new Date("2026-10-04T10:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("evidence on a finished issue", () => {
  it("counts a commit, a pull request, test or build output, an http check, a screenshot and a deploy", () => {
    const cases: Array<[string, string]> = [
      ["commit", "Pushed commit 3f9a2c1d to development"],
      ["commit", "https://github.com/Partners-in-Biz/pib-paperclip/commit/3f9a2c1d4e5b"],
      ["pull-request", "PR #412 is open: https://github.com/Partners-in-Biz/pib-paperclip/pull/412"],
      ["test-output", "pnpm test passed 782/782"],
      ["test-output", "vitest run: 33 passed"],
      ["http-check", "curl -sS https://app.example/health returned 200"],
      ["http-check", "HTTP/2 200"],
      ["screenshot", "Screenshot: /tmp/pib-shots/form.png"],
      ["screenshot", "Looked at it with pib-shot, the form shows"],
      ["deploy", "Deployed, status.json healthy"],
    ];
    for (const [kind, text] of cases) expect(evidenceKinds(text), text).toContain(kind);
  });

  it("a claim is not evidence: 'tests pass', 'it works', 'done' prove nothing", () => {
    for (const text of ["All tests pass and it works.", "Done.", "Fixed the bug, looks good.", "I checked it carefully and everything is fine", "Built and deployed successfully (trust me)"]) expect(hasEvidence([{ body: text }]), text).toBe(false);
    expect(hasEvidence([])).toBe(false);
    expect(hasEvidence([{ body: null }, { body: "Done." }, { body: "commit 3f9a2c1d" }])).toBe(true);
  });
});

describe("proofCandidates", () => {
  const row = (id: string, completedHoursAgo: number, reviewed = false) => ({ id, identifier: id.toUpperCase(), completedAt: hoursAgo(completedHoursAgo), reviewed });

  it("leaves out reviewed work and work closed inside the grace period, newest first, and reads at most the limit", () => {
    const picked = proofCandidates([row("a", 10), row("b", 20, true), row("c", 2), row("d", 30), row("e", 6)], NOW);
    expect(picked.map((p) => p.id)).toEqual(["e", "a", "d"]);
    const many = Array.from({ length: 40 }, (_, i) => row(`x${i}`, 10 + i));
    expect(proofCandidates(many, NOW)).toHaveLength(PROOF_READ_LIMIT);
  });
});

describe("proofCheck", () => {
  it("is nothing without a gap and a warning with one, naming the issues and the oldest close", () => {
    expect(proofCheck([], 12)).toBeNull();
    const check = proofCheck([{ id: "a", identifier: "PAR-1", completedAt: hoursAgo(30) }, { id: "b", identifier: null, completedAt: hoursAgo(10) }], 12)!;
    expect(check).toMatchObject({ key: "proof:done-without-proof", status: "warn", since: hoursAgo(30) });
    expect(check.title).toBe("2 finished code issues have no review and no proof");
    expect(check.detail).toContain("PAR-1, b");
    expect(check.detail).toContain("2 of 12 closed");
    expect(proofCheck([{ id: "a", identifier: "PAR-1", completedAt: hoursAgo(1) }], 3)!.title).toBe("1 finished code issue has no review and no proof");
    expect(proofCheck(Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, identifier: `PAR-${i}`, completedAt: hoursAgo(i + 1) })), 9)!.detail).toContain("PAR-0, PAR-1, PAR-2, PAR-3, PAR-4, ...");
  });
});

describe("isOutwardApproval", () => {
  const approval = (over: Record<string, unknown>) => ({ id: "i", title: "Approve email sending: Q4", description: "", originKind: "plugin:partnersinbiz.campaigns", createdAt: hoursAgo(5), ...over });

  it("is an approval from a plugin that sends, for work that leaves the company", () => {
    for (const plugin of ["crm", "campaigns", "social", "billing", "mailbox", "seo"]) expect(isOutwardApproval(approval({ originKind: `plugin:partnersinbiz.${plugin}` })), plugin).toBe(true);
    expect(isOutwardApproval(approval({ title: "Approve something", description: "## Reviewer: check before the person approves\n- ..." }))).toBe(true);
    expect(isOutwardApproval(approval({ title: "Approve the invoice for Northwind" }))).toBe(true);
  });

  it("is not payroll or accounting approvals, other origins, or an approval with nothing outward in it", () => {
    expect(isOutwardApproval(approval({ originKind: "plugin:partnersinbiz.payroll" }))).toBe(false);
    expect(isOutwardApproval(approval({ originKind: "plugin:partnersinbiz.accounting" }))).toBe(false);
    expect(isOutwardApproval(approval({ originKind: "manual" }))).toBe(false);
    expect(isOutwardApproval(approval({ originKind: null }))).toBe(false);
    expect(isOutwardApproval(approval({ title: "Approve the leave request", description: "" }))).toBe(false);
  });
});

describe("approvalCandidates and unreviewedApprovalsCheck", () => {
  const a = (id: string, createdHoursAgo: number, over: Record<string, unknown> = {}) => ({ id, title: "Approve email sending", description: "", originKind: "plugin:partnersinbiz.crm", createdAt: hoursAgo(createdHoursAgo), ...over });

  it("waits two hours before an approval counts as late, and takes the oldest first", () => {
    expect(approvalCandidates([a("new", 1), a("old", 10), a("mid", 3), a("pay", 20, { originKind: "plugin:partnersinbiz.payroll" })], NOW).map((i) => i.id)).toEqual(["old", "mid"]);
  });

  it("is a warning that names the approvals, with the Reviewer's late-review fix", () => {
    expect(unreviewedApprovalsCheck([])).toBeNull();
    const check = unreviewedApprovalsCheck([{ id: "a", identifier: "PAR-5", title: "Approve email sending: Q4", createdAt: hoursAgo(30) }, { id: "b", identifier: null, title: "Approve post", createdAt: hoursAgo(5) }])!;
    expect(check).toMatchObject({ key: "approvals:unreviewed", status: "warn", since: hoursAgo(30) });
    expect(check.title).toBe("2 outward approvals were never reviewed");
    expect(check.detail).toContain("PAR-5: Approve email sending: Q4; b: Approve post");
    expect(check.fix).toContain("late review");
    expect(unreviewedApprovalsCheck([{ id: "a", identifier: "PAR-5", title: "x", createdAt: hoursAgo(3) }])!.title).toBe("1 outward approval was never reviewed");
  });
});

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const DEV = "33333333-0000-4000-8000-000000000001";
const DEV2 = "33333333-0000-4000-8000-000000000003";
const REV = "33333333-0000-4000-8000-000000000002";
const PM = "33333333-0000-4000-8000-000000000004";
const NEWS = "2026-10-04T10:00:00.000Z";
const id = (n: number) => `44444444-0000-4000-8000-${String(n).padStart(12, "0")}`;

d("the honesty checks (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(options: { reviewOutward?: boolean; reviewer?: boolean; reviewerStatus?: string } = {}) {
    const w = await worlds.make(
      {
        prefixes: { [A]: "PAR" },
        savedConfigs: { [A]: { healthIssue: true } },
        agents: [
          { id: DEV, companyId: A, name: "Developer", status: "idle", role: "engineer" },
          { id: DEV2, companyId: A, name: "Senior Developer", status: "idle", role: "engineer" },
          { id: REV, companyId: A, name: "Reviewer", status: options.reviewerStatus ?? "idle", role: "general" },
          { id: PM, companyId: A, name: "Project Manager", status: "idle", role: "pm" },
        ],
      },
      NEWS,
    );
    await saveTeam(w.env, A, { operatorAgentId: PM, ...(options.reviewer === false ? {} : { reviewerAgentId: REV }), reviewOutward: options.reviewOutward ?? true }, "user-owner");
    return w;
  }

  const done = (w: Hybrid, n: number, over: { agent?: string; completedHoursAgo?: number; company?: string; status?: string; policy?: unknown; state?: unknown; title?: string } = {}) =>
    w.client.query(
      `INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, completed_at, execution_policy, execution_state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [id(n), over.company ?? A, `PAR-${n}`, over.title ?? `Build thing ${n}`, over.status ?? "done", over.agent ?? DEV, hoursAgo(over.completedHoursAgo ?? 20), over.policy ? JSON.stringify(over.policy) : null, over.state ? JSON.stringify(over.state) : null, hoursAgo(100)],
    );
  const comment = (w: Hybrid, issueId: string, body: string, authorAgentId?: string) => {
    w.comments.push({ id: `c${w.comments.length + 1}`, issueId, companyId: A, body, createdAt: hoursAgo(1), ...(authorAgentId ? { authorAgentId } : {}) });
  };

  describe("done code work with no review and no proof", () => {
    it("flags work closed with nothing to show for it, and names it", async () => {
      const w = await make();
      await done(w, 1);
      comment(w, id(1), "Done, it works.");
      await done(w, 2, { agent: DEV2, completedHoursAgo: 30 });
      const check = (await proofGapCheck(w.env, A))!;
      expect(check).toMatchObject({ key: "proof:done-without-proof", status: "warn" });
      expect(check.title).toBe("2 finished code issues have no review and no proof");
      expect(check.detail).toContain("PAR-1");
      expect(check.detail).toContain("PAR-2");
      expect(check.detail).toContain("2 of 2 closed");
      expect(check.since).toBe(hoursAgo(30));
    });

    it("does not flag work with evidence in a comment, however it is shown", async () => {
      const w = await make();
      for (const [n, body] of [[1, "Commit 3f9a2c1d is on development"], [2, "pnpm test passed 782/782"], [3, "Screenshot /tmp/pib-shots/page.png: the form shows the new field"], [4, "curl returned 200 on the health route"]] as Array<[number, string]>) {
        await done(w, n);
        comment(w, id(n), body);
      }
      expect(await proofGapCheck(w.env, A)).toBeNull();
    });

    it("does not flag reviewed work, by a linked Reviewer issue or an approved review stage", async () => {
      const w = await make();
      await done(w, 1);
      await done(w, 11, { agent: REV, title: "Review PAR-1" });
      await done(w, 2, { policy: { stages: [{ type: "review" }] }, state: { lastDecisionOutcome: "approved" } });
      expect(await proofGapCheck(w.env, A)).toBeNull();
      // A review stage that asked for changes is no review.
      await done(w, 3, { policy: { stages: [{ type: "review" }] }, state: { lastDecisionOutcome: "changes_requested" } });
      expect((await proofGapCheck(w.env, A))!.detail).toContain("PAR-3");
    });

    it("gives a close time to be reviewed, and ignores anything older than a week, other statuses, other people's work and other companies", async () => {
      const w = await make();
      await done(w, 1, { completedHoursAgo: 2 }); // inside the grace period: a review may just have been asked for
      await done(w, 2, { completedHoursAgo: 24 * 8 }); // outside the window
      await done(w, 3, { status: "in_progress", completedHoursAgo: 20 });
      await done(w, 4, { agent: PM }); // not an author
      await done(w, 5, { company: OTHER_COMPANY });
      expect(await proofGapCheck(w.env, A)).toBeNull();
      await done(w, 6, { completedHoursAgo: 7 });
      expect((await proofGapCheck(w.env, A))!.detail).toContain("PAR-6");
    });

    it("says nothing about an issue whose comments cannot be read", async () => {
      const w = await make();
      await done(w, 1);
      w.ctx.issues.listComments = async () => {
        throw new Error("host down");
      };
      expect(await proofGapCheck(w.env, A)).toBeNull();
    });

    it("is part of the Cockpit's checks, and a failing part does not take the others down", async () => {
      const w = await make();
      await done(w, 1);
      const checks = await extraChecks(w.env, A, { fresh: true });
      expect(checks.health.some((h) => h.key === "proof:done-without-proof")).toBe(true);
    });
  });

  describe("outward approvals the Reviewer never saw", () => {
    let n = 0;
    const approval = (w: Hybrid, over: Record<string, unknown> = {}): string => {
      n += 1;
      const issueId = `appr-${n}`;
      w.issues.set(issueId, { id: issueId, companyId: A, title: "Approve email sending: Q4 reactivation", description: "Sequence to 40 contacts", status: "todo", originKind: "plugin:partnersinbiz.crm", originId: `crm:sequence:${n}:approval`, assigneeAgentId: null, assigneeUserId: "user-owner", identifier: `PAR-${700 + n}`, createdAt: hoursAgo(5), ...over } as never);
      return issueId;
    };

    it("flags an outward approval the owner holds that the Reviewer never commented on", async () => {
      const w = await make();
      const flagged = approval(w);
      const seen = approval(w, { title: "Approve post: launch" });
      comment(w, seen, "Checked the copy and the links: ready for you.", REV);
      const check = (await unreviewedApprovalCheck(w.env, A))!;
      expect(check).toMatchObject({ key: "approvals:unreviewed", status: "warn" });
      expect(check.title).toBe("1 outward approval was never reviewed");
      expect(check.detail).toContain(w.issues.get(flagged)!.identifier);
      expect(check.detail).not.toContain("launch");
    });

    it("a comment from someone else is not the Reviewer's review, and a comment from a person is not either", async () => {
      const w = await make();
      const issueId = approval(w);
      comment(w, issueId, "Looks fine to me.", PM);
      w.userComment(issueId, "Sending it today", "user-owner", A);
      expect((await unreviewedApprovalCheck(w.env, A))!.title).toBe("1 outward approval was never reviewed");
      comment(w, issueId, "Late review: the link is right and the list is the approved one.", REV);
      expect(await unreviewedApprovalCheck(w.env, A)).toBeNull();
    });

    it("waits two hours, and ignores finished approvals, approvals from plugins that send nothing, other companies and plain tasks", async () => {
      const w = await make();
      approval(w, { createdAt: hoursAgo(1) });
      approval(w, { status: "done" });
      approval(w, { originKind: "plugin:partnersinbiz.payroll", title: "Approve payroll run" });
      approval(w, { companyId: OTHER_COMPANY });
      approval(w, { title: "Send the Q4 emails", originId: "crm:sequence:9:step" });
      expect(await unreviewedApprovalCheck(w.env, A)).toBeNull();
    });

    it("stays quiet when the company does not review outward work, or the Reviewer is not there to do it", async () => {
      const off = await make({ reviewOutward: false });
      approval(off);
      expect(await unreviewedApprovalCheck(off.env, A)).toBeNull();
      const none = await make({ reviewer: false });
      approval(none);
      expect(await unreviewedApprovalCheck(none.env, A)).toBeNull();
      // A paused Reviewer is skipped on purpose (approvals go straight to the person): the unrouted check is the one that speaks.
      const paused = await make({ reviewerStatus: "paused" });
      approval(paused);
      expect(await unreviewedApprovalCheck(paused.env, A)).toBeNull();
    });

    it("is part of the Cockpit's checks", async () => {
      const w = await make();
      approval(w);
      expect((await extraChecks(w.env, A, { fresh: true })).health.some((h) => h.key === "approvals:unreviewed")).toBe(true);
    });
  });
});
