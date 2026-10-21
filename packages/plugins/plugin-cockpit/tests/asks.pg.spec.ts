/**
 * Ask defaults: ask-owner fields (deadline_at, recommended, default_after_hours,
 * default_policy) and answerAskByPolicy for policy-driven auto-answers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerAskByPolicy, askOwner, getAsk, onAskComment } from "../src/asks.js";
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

d("ask defaults (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: SEO, companyId: A, name: "Sam", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    return w;
  }

  let n = 0;
  async function issue(w: Hybrid) {
    n += 1;
    const id = `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const iss = { id, companyId: A, identifier: `PAR-${100 + n}`, title: "Test", description: "", status: "in_progress", assigneeAgentId: SEO };
    w.issues.set(id, iss);
    await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id) VALUES ($1, $2, $3, $4, 'in_progress', $5)`, [id, A, iss.identifier, iss.title, SEO]);
    return iss;
  }

  const row = async (w: Hybrid, askId: string) =>
    (await w.client.query(`SELECT * FROM ${NAMESPACE}.asks WHERE company_id = $1 AND id = $2`, [A, askId])).rows[0] as Record<string, any>;
  it("round-trip new fields via askOwner", async () => {
    const w = await make();
    const iss = await issue(w);
    const r = (await w.tools.get("ask-owner")!({
      issueId: iss.id,
      question: "Approve?",
      why: "Team waits.",
      kind: "decision",
      options: ["Yes", "No"],
      links: [{ label: "Link", href: "/PAR/issues/PAR-1" }],
      defaultAfterHours: 24,
      recommended: "Yes",
      policyClass: "engineering-decision",
    }, RUN)) as { data: { askId: string } };
    const stored = await row(w, r.data.askId);
    expect(stored.default_after_hours).toBe(24);
    expect(stored.recommended).toBe("Yes");
    expect(stored.default_policy).toBe("engineering-decision");
    expect(stored.deadline_at).toBeTruthy();
    expect(Date.parse(stored.deadline_at) - Date.parse(stored.asked_at)).toBe(24 * 3_600_000);
  });
  it("re-ask without deadline keeps first deadline_at (FIRST DEADLINE WINS)", async () => {
    const w = await make();
    const iss = await issue(w);
    const r1 = (await w.tools.get("ask-owner")!({
      issueId: iss.id,
      question: "First?",
      why: "Test",
      kind: "decision",
      links: [{ label: "L", href: "/PAR/issues/PAR-1" }],
      defaultAfterHours: 24,
    }, RUN)) as { data: { askId: string } };
    const ask1 = await row(w, r1.data.askId);
    const deadline1 = ask1.deadline_at;

    const r2 = (await w.tools.get("ask-owner")!({
      issueId: iss.id,
      question: "Updated?",
      why: "Test",
      kind: "decision",
      links: [{ label: "L", href: "/PAR/issues/PAR-1" }],
    }, RUN)) as { data: { askId: string } };
    const ask2 = await row(w, r2.data.askId);
    expect(ask2.deadline_at).toEqual(deadline1);
    expect(ask2.default_after_hours).toBe(24);
  });
  it("re-ask with deadline on no-deadline ask sets deadline", async () => {
    const w = await make();
    const iss = await issue(w);
    const r1 = (await w.tools.get("ask-owner")!({
      issueId: iss.id,
      question: "First?",
      why: "Test",
      kind: "decision",
      links: [{ label: "L", href: "/PAR/issues/PAR-1" }],
    }, RUN)) as { data: { askId: string } };
    const ask1 = await row(w, r1.data.askId);
    expect(ask1.deadline_at).toBeNull();

    const r2 = (await w.tools.get("ask-owner")!({
      issueId: iss.id,
      question: "Updated?",
      why: "Test",
      kind: "decision",
      links: [{ label: "L", href: "/PAR/issues/PAR-1" }],
      defaultAfterHours: 12,
    }, RUN)) as { data: { askId: string } };
    const ask2 = await row(w, r2.data.askId);
    expect(ask2.deadline_at).toBeTruthy();
    expect(ask2.default_after_hours).toBe(12);
  });
  it.each([
    ["survives when still in options", ["A", "B"], ["A", "B"], "A"],
    ["becomes NULL when excluded", ["A", "B"], ["X", "Y"], null],
  ] as const)("recommended %s", async (_, opts1, opts2, expected) => {
    const w = await make();
    const iss = await issue(w);
    await w.tools.get("ask-owner")!({
      issueId: iss.id,
      question: "Choose?",
      why: "Test",
      kind: "decision",
      options: opts1,
      links: [{ label: "L", href: "/PAR/issues/PAR-1" }],
      recommended: "A",
    }, RUN);
    const r2 = (await w.tools.get("ask-owner")!({
      issueId: iss.id,
      question: "Choose again?",
      why: "Test",
      kind: "decision",
      options: opts2,
      links: [{ label: "L", href: "/PAR/issues/PAR-1" }],
    }, RUN)) as { data: { askId: string } };
    const ask2 = await row(w, r2.data.askId);
    expect(ask2.recommended).toBe(expected);
  });
  it.each([
    ["recommended not in options", { recommended: "B", options: ["A"], policyClass: undefined, defaultAfterHours: undefined, err: "must be one of" }],
    ["no options", { recommended: "B", options: undefined, policyClass: undefined, defaultAfterHours: undefined, err: "requires options" }],
    ["bad policyClass", { recommended: undefined, options: undefined, policyClass: "bad", defaultAfterHours: undefined, err: "must be one of" }],
    ["defaultAfterHours=0", { recommended: undefined, options: undefined, policyClass: undefined, defaultAfterHours: 0, err: "positive" }],
    ["defaultAfterHours=1.5", { recommended: undefined, options: undefined, policyClass: undefined, defaultAfterHours: 1.5, err: "positive" }],
  ] as const)("validation: %s", async (_, { recommended, options, policyClass, defaultAfterHours, err }) => {
    const w = await make();
    const params: Record<string, unknown> = {
      issueId: (await issue(w)).id,
      question: "Q?",
      why: "W",
      kind: "decision",
      links: [{ label: "L", href: "/PAR/issues/PAR-1" }],
    };
    if (recommended !== undefined) params.recommended = recommended;
    if (options !== undefined) params.options = options;
    if (policyClass !== undefined) params.policyClass = policyClass;
    if (defaultAfterHours !== undefined) params.defaultAfterHours = defaultAfterHours;
    const result = (await w.tools.get("ask-owner")!(params, RUN)) as { error?: string };
    expect(result.error).toContain(err);
  });
  it("migration: old INSERT on new schema succeeds with new columns NULL", async () => {
    const w = await make();
    const askId = "q" + "0".repeat(12);
    await w.client.query(
      `INSERT INTO ${NAMESPACE}.asks (id, company_id, issue_id, issue_identifier, issue_title, agent_id, return_agent_id, run_id, question, options, why, kind, links, steps, client_ref, due_by, owner_user_id, status, asked_at, updated_at, source, effect)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22::jsonb)`,
      [askId, A, "iss", "PAR-1", "T", SEO, SEO, "r1", "Q?", JSON.stringify([]), "W", "decision", JSON.stringify([]), JSON.stringify([]), null, null, OP, "open", NOW, NOW, "agent", null],
    );
    const stored = await row(w, askId);
    expect(stored).toBeTruthy();
    expect(stored.default_after_hours).toBeNull();
    expect(stored.recommended).toBeNull();
    expect(stored.default_applied_at).toBeNull();
    expect(stored.default_policy).toBeNull();
    expect(stored.deadline_at).toBeNull();
  });

  it("answerAskByPolicy: answer, idempotent, userId null, missing null", async () => {
    const w = await make();
    const askId = ((await w.tools.get("ask-owner")!({
      issueId: (await issue(w)).id,
      question: "Q?",
      why: "W",
      kind: "decision",
      links: [{ label: "L", href: "/PAR/issues/PAR-1" }],
    }, RUN)) as { data: { askId: string } }).data.askId;

    const r1 = await answerAskByPolicy(w.env, A, askId, "hire", "Yes");
    expect(r1?.answer).toBe("Yes");
    expect(r1?.defaultPolicy).toBe("hire");
    expect(r1?.answeredByUserId).toBeNull();

    const r2 = await answerAskByPolicy(w.env, A, askId, "other", "No");
    expect(r2?.answer).toBe("Yes");
    expect(r2?.defaultPolicy).toBe("hire");

    expect(await answerAskByPolicy(w.env, A, "missing", "hire", "Yes")).toBeNull();
  });

  it("owner-reply: answer, no policy metadata", async () => {
    const w = await make();
    const iss = await issue(w);
    const r = (await w.tools.get("ask-owner")!({
      issueId: iss.id,
      question: "Q?",
      why: "W",
      kind: "decision",
      links: [{ label: "L", href: "/PAR/issues/PAR-1" }],
    }, RUN)) as { data: { askId: string } };
    const cid = w.userComment(iss.id, "Yes", "user-owner");
    await onAskComment(w.env, { companyId: A, entityId: iss.id, entityType: "issue", actorType: "user", actorId: "user-owner", payload: { commentId: cid } } as never);
    const u = await getAsk(w.env, A, r.data.askId);
    expect(u?.answer).toBe("Yes");
    expect(u?.answeredByUserId).toBe("user-owner");
    expect(u?.defaultPolicy).toBeNull();
  });
});
