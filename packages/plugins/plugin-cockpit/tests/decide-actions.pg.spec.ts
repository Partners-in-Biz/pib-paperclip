/**
 * The Decide actions (PAR-15315, T2) on a real Postgres with the fake host: `decide.ask`, `decide.approval` and
 * `decide.card` act as the owner, re-read their record before they write, answer `already_decided` when it moved on,
 * and refuse every caller but the owner's session before any host call. Also the hourly hand-back of an answered ask
 * whose hand-back was lost.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_AGENT_TOOLS, MEMORY_TOOLS_GRANT } from "@partnersinbiz/pib-plugin-kit";
import { onAskComment, reconcileAsks } from "../src/asks.js";
import { LOCAL_BOARD_USER_ID } from "../src/constants.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const OWNER = "user-owner";
const OTHER = "user-other";
const NOW = "2026-11-28T12:00:00.000Z";
const RUN_ID = "run-77";

type Ctx = { companyId: string; actor: Record<string, unknown> };
const base = { agentId: null, runId: null, companyId: A, onBehalfOfRestricted: false };
/** The actor shapes the real route hands the worker (server test plugin-cockpit-decide-actors.test.ts proves them). */
const SHAPES = {
  owner: { companyId: A, actor: { ...base, type: "user", userId: OWNER, onBehalfOfUserId: OWNER } },
  otherMember: { companyId: A, actor: { ...base, type: "user", userId: OTHER, onBehalfOfUserId: OTHER } },
  agentKey: { companyId: A, actor: { ...base, type: "agent", userId: null, agentId: DEV, onBehalfOfUserId: OWNER } },
  runJwt: { companyId: A, actor: { ...base, type: "agent", userId: null, agentId: DEV, runId: RUN_ID, onBehalfOfUserId: OWNER } },
  localBoard: { companyId: A, actor: { ...base, type: "user", userId: LOCAL_BOARD_USER_ID, onBehalfOfUserId: null } },
} satisfies Record<string, Ctx>;

const CARD = {
  why: "Work waits on it.",
  kind: "grant",
  question: "May Dev use company memory?",
  options: ["Yes: memory tools only", "No"],
  links: [{ label: "Agents", href: "/PAR/agents" }],
  steps: ["Open Agents, Dev, Permissions.", "Grant the memory tools."],
  effect: { key: "cockpit.grant-memory-tools", params: { agentIds: DEV } },
};

d("the Decide actions (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  interface Calls {
    personComments: Array<{ issueId: string; body: string; actorUserId: string }>;
    approvalsGet: string[];
    decide: Array<{ id: string; input: Record<string, unknown> }>;
    listInteractions: string[];
    respond: Array<{ issueId: string; interactionId: string; input: Record<string, unknown> }>;
    issueGets: number;
  }

  async function make(options: { approvals?: Array<Record<string, unknown>> } = {}) {
    const approvals = (options.approvals ?? []).map((a) => ({ ...a }));
    const w = await worlds.make(
      {
        savedConfigs: { [A]: { healthIssue: true } },
        prefixes: { [A]: "PAR" },
        agents: [
          { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
          { id: DEV, companyId: A, name: "Dev", status: "active", role: "engineer" },
        ],
        approvals,
      },
      NOW,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP }, OWNER);
    const calls: Calls = { personComments: [], approvalsGet: [], decide: [], listInteractions: [], respond: [], issueGets: 0 };
    const issues = w.ctx.issues as unknown as Record<string, (...args: any[]) => Promise<any>>;
    const createComment = issues.createComment!;
    issues.createComment = async (issueId: string, body: string, companyId: string, opts?: { authorAgentId?: string; actorUserId?: string }) => {
      if (opts?.actorUserId) {
        calls.personComments.push({ issueId, body, actorUserId: opts.actorUserId });
        if (personCommentFails) throw new Error("actorUserId is not an active human member");
        const id = `comment-${w.comments.length + 1}`;
        w.comments.push({ id, issueId, body, companyId, authorUserId: opts.actorUserId, createdAt: new Date().toISOString() });
        return { id };
      }
      return createComment(issueId, body, companyId, opts);
    };
    const get = issues.get!;
    issues.get = async (...args: unknown[]) => {
      calls.issueGets += 1;
      if (beforeIssueRead) await beforeIssueRead();
      return get(...args);
    };
    let personCommentFails = false;
    let beforeIssueRead: (() => Promise<void>) | null = null;
    let interactions: Record<string, Array<Record<string, unknown>>> = {};
    let respondApplied = true;
    issues.listInteractions = async (issueId: string) => {
      calls.listInteractions.push(issueId);
      return (interactions[issueId] ?? []).map((c) => ({ ...c }));
    };
    issues.respondInteraction = async (issueId: string, interactionId: string, input: Record<string, unknown>) => {
      calls.respond.push({ issueId, interactionId, input });
      const card = (interactions[issueId] ?? []).find((c) => c.id === interactionId)!;
      if (respondApplied) card.status = input.action === "accept" ? "accepted" : "rejected";
      return { interaction: { ...card }, applied: respondApplied };
    };
    let decideApplied = true;
    (w.ctx as unknown as { approvals: Record<string, unknown> }).approvals = {
      list: async () => approvals,
      get: async (id: string) => {
        calls.approvalsGet.push(id);
        const a = approvals.find((x) => x.id === id);
        return a ? { ...a } : null;
      },
      decide: async (id: string, input: Record<string, unknown>) => {
        calls.decide.push({ id, input });
        const a = approvals.find((x) => x.id === id)!;
        if (!decideApplied || a.status !== "pending") return { approval: { ...a }, applied: false };
        a.status = input.action === "approve" ? "approved" : "rejected";
        return { approval: { ...a }, applied: true };
      },
    };
    return {
      ...w,
      calls,
      approvals,
      failPersonComment: () => (personCommentFails = true),
      onIssueRead: (fn: (() => Promise<void>) | null) => (beforeIssueRead = fn),
      setInteractions: (byIssue: Record<string, Array<Record<string, unknown>>>) => (interactions = byIssue),
      respondNotApplied: () => (respondApplied = false),
      decideNotApplied: () => (decideApplied = false),
    };
  }
  type World = Awaited<ReturnType<typeof make>>;

  let n = 0;
  async function issue(w: Hybrid, title = "Pricing page copy") {
    n += 1;
    const id = `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const identifier = `PAR-${700 + n}`;
    w.issues.set(id, { id, companyId: A, identifier, title, description: "", status: "in_progress", assigneeAgentId: DEV, assigneeUserId: null });
    await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id) VALUES ($1, $2, $3, $4, 'in_progress', $5)`, [id, A, identifier, title, DEV]);
    return { id, identifier };
  }

  async function ask(w: World, body: Record<string, unknown> = { question: "Which headline?", kind: "decision", options: ["A", "B"], links: [{ label: "The task", href: "/PAR/issues/PAR-1" }] }) {
    const i = await issue(w);
    const result = (await w.tools.get("ask-owner")!({ issueId: i.id, why: "Work waits on it.", ...body }, { agentId: DEV, runId: "run-1", companyId: A, projectId: "" })) as { error?: string; data: { askId: string } };
    if (result.error) throw new Error(result.error);
    expect(w.issues.get(i.id)).toMatchObject({ assigneeUserId: OWNER, status: "in_review" });
    return { issueId: i.id, askId: result.data.askId };
  }

  const act = (w: World, key: string, params: Record<string, unknown>, context: Ctx = SHAPES.owner) => w.actions.get(key)!(params, context) as Promise<{ result: string }>;
  const row = async (w: World, askId: string) => (await w.client.query(`SELECT * FROM ${NAMESPACE}.asks WHERE id = $1`, [askId])).rows[0] as Record<string, any>;
  const handBacks = (w: World, issueId: string) => w.comments.filter((c) => c.issueId === issueId && c.body.startsWith("Answer recorded.")).length;

  // -------------------------------------------------------------------------
  // decide.ask
  // -------------------------------------------------------------------------

  describe("decide.ask", () => {
    it("answers as the owner: the answer is the option, the comment is the owner's and comes after the claim, the issue goes back", async () => {
      const w = await make();
      const { issueId, askId } = await ask(w);
      expect(await act(w, "decide.ask", { askId, option: "B" })).toEqual({ result: "ok" });
      const stored = await row(w, askId);
      expect(stored).toMatchObject({ status: "answered", answer: "B", answered_by_user_id: OWNER });
      expect(w.calls.personComments).toEqual([{ issueId, body: "B\n\n_Answered in Cockpit → Decide._", actorUserId: OWNER }]);
      expect(stored.answer_comment_id).toBe(w.comments.find((c) => c.authorUserId === OWNER && c.issueId === issueId)!.id);
      expect(w.issues.get(issueId)).toMatchObject({ assigneeAgentId: DEV, assigneeUserId: null, status: "todo" });
      expect(handBacks(w, issueId)).toBe(1);
      expect(w.wakeups).toEqual([issueId]);
    });

    it("a second call after success answers already_decided, with no second comment and exactly one hand-back", async () => {
      const w = await make();
      const { issueId, askId } = await ask(w);
      await act(w, "decide.ask", { askId, option: "A" });
      expect(await act(w, "decide.ask", { askId, option: "B" })).toEqual({ result: "already_decided" });
      expect((await row(w, askId)).answer).toBe("A");
      expect(w.calls.personComments).toHaveLength(1);
      expect(handBacks(w, issueId)).toBe(1);
      expect(w.wakeups).toEqual([issueId]);
    });

    it("loses the claim (another path closed it after the read): already_decided, no comment, no hand-back", async () => {
      const w = await make();
      const { issueId, askId } = await ask(w);
      // The issue read inside applyAnswer runs before closeAsk: a reply lands in between and closes the ask.
      w.onIssueRead(async () => {
        w.onIssueRead(null);
        await w.client.query(`UPDATE ${NAMESPACE}.asks SET status = 'answered', answer = 'by reply', closed_at = $2 WHERE id = $1`, [askId, NOW]);
      });
      expect(await act(w, "decide.ask", { askId, option: "A" })).toEqual({ result: "already_decided" });
      expect((await row(w, askId)).answer).toBe("by reply");
      expect(w.calls.personComments).toEqual([]);
      expect(handBacks(w, issueId)).toBe(0);
      expect(w.wakeups).toEqual([]);
    });

    it("refuses an option that is not one of the ask's (exact text), and writes nothing", async () => {
      const w = await make();
      const { issueId, askId } = await ask(w);
      await expect(act(w, "decide.ask", { askId, option: "a" })).rejects.toThrow("not one of the question's options");
      await expect(act(w, "decide.ask", { askId, option: "Something else" })).rejects.toThrow("not one of the question's options");
      expect((await row(w, askId)).status).toBe("open");
      expect(w.calls.personComments).toEqual([]);
      expect(handBacks(w, issueId)).toBe(0);
    });

    it("a comment that cannot be posted is logged, and the issue is still handed back", async () => {
      const w = await make();
      const { issueId, askId } = await ask(w);
      w.failPersonComment();
      expect(await act(w, "decide.ask", { askId, option: "A" })).toEqual({ result: "ok" });
      expect(await row(w, askId)).toMatchObject({ status: "answered", answer: "A", answer_comment_id: null });
      expect(w.calls.personComments).toHaveLength(1);
      expect(w.issues.get(issueId)).toMatchObject({ assigneeAgentId: DEV, status: "todo" });
      expect(handBacks(w, issueId)).toBe(1);
    });

    it("issue cancelled: the ask is cancelled, no effect, no comment, no hand-back", async () => {
      const w = await make();
      const { issueId, askId } = await ask(w, CARD);
      w.issues.get(issueId)!.status = "cancelled";
      expect(await act(w, "decide.ask", { askId, option: CARD.options[0] })).toEqual({ result: "issue_closed" });
      expect(await row(w, askId)).toMatchObject({ status: "cancelled", effect_status: null });
      expect(w.grants.get(DEV)).toBeUndefined();
      expect(w.calls.personComments).toEqual([]);
      expect(handBacks(w, issueId)).toBe(0);
      expect(w.issues.get(issueId)!.status).toBe("cancelled");
    });

    it("issue done: the ask is resolved, the effect runs as today, no comment, no hand-back", async () => {
      const w = await make();
      const { issueId, askId } = await ask(w, CARD);
      w.issues.get(issueId)!.status = "done";
      expect(await act(w, "decide.ask", { askId, option: CARD.options[0] })).toEqual({ result: "issue_closed" });
      expect(await row(w, askId)).toMatchObject({ status: "resolved", effect_status: "applied" });
      expect(w.grants.get(DEV)).toEqual([{ permissionKey: MEMORY_TOOLS_GRANT.permissionKey, scope: { toolNames: [...MEMORY_AGENT_TOOLS] } }]);
      expect(w.calls.personComments).toEqual([]);
      expect(handBacks(w, issueId)).toBe(0);
      expect(w.issues.get(issueId)!.status).toBe("done");
    });

    it("a real effect ask with its stored labels: the first option runs the effect, \"No\" declines it (not unclear)", async () => {
      const w = await make();
      const yes = await ask(w, CARD);
      expect(await act(w, "decide.ask", { askId: yes.askId, option: "Yes: memory tools only" })).toEqual({ result: "ok" });
      expect(await row(w, yes.askId)).toMatchObject({ status: "answered", effect_status: "applied" });
      expect(w.grants.get(DEV)).toHaveLength(1);
      const no = await ask(w, CARD);
      expect(await act(w, "decide.ask", { askId: no.askId, option: "No" })).toEqual({ result: "ok" });
      expect(await row(w, no.askId)).toMatchObject({ status: "answered", effect_status: "declined" });
      expect(w.grants.get(DEV)).toHaveLength(1);
      expect(w.wakeReasons.at(-1)!.reason).toContain("declined:");
    });

    it("an issue.comment.created event for the posted comment, delivered after the claim, answers nothing", async () => {
      const w = await make();
      const { issueId, askId } = await ask(w);
      await act(w, "decide.ask", { askId, option: "A" });
      const commentId = (await row(w, askId)).answer_comment_id as string;
      // The host logs it as `plugin`; even a `user` event (worst case) finds the ask closed.
      for (const actorType of ["plugin", "user"] as const) {
        expect(await onAskComment(w.env, { companyId: A, entityId: issueId, entityType: "issue", actorType, actorId: OWNER, payload: { commentId } } as never)).toBe("ignored");
      }
      await w.fire("issue.comment.created", { companyId: A, entityId: issueId, entityType: "issue", actorType: "user", actorId: OWNER, payload: { commentId } } as never);
      expect(await row(w, askId)).toMatchObject({ status: "answered", answer: "A" });
      expect(handBacks(w, issueId)).toBe(1);
      expect(w.wakeups).toEqual([issueId]);
    });

    it("an ask that is not open, or gone, answers already_decided", async () => {
      const w = await make();
      expect(await act(w, "decide.ask", { askId: "q-missing", option: "A" })).toEqual({ result: "already_decided" });
      expect(w.calls.personComments).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // decide.approval
  // -------------------------------------------------------------------------

  const SEEDED = [
    { id: "ap-board", companyId: A, type: "request_board_approval", status: "pending", payload: { title: "Plan the quarter" }, createdAt: "2026-11-21T08:00:00.000Z" },
    { id: "ap-board-2", companyId: A, type: "request_board_approval", status: "pending", payload: { title: "Second" }, createdAt: "2026-11-21T08:00:00.000Z" },
    { id: "ap-hire", companyId: A, type: "hire_agent", status: "pending", payload: { name: "New agent" }, createdAt: "2026-11-22T08:00:00.000Z" },
    { id: "ap-budget", companyId: A, type: "budget_override_required", status: "pending", payload: {}, createdAt: "2026-11-22T08:00:00.000Z" },
  ];

  describe("decide.approval", () => {
    it("approves and rejects a seeded request_board_approval as the owner", async () => {
      const w = await make({ approvals: SEEDED });
      expect(await act(w, "decide.approval", { approvalId: "ap-board", action: "approve", note: "Go." })).toEqual({ result: "ok" });
      expect(await act(w, "decide.approval", { approvalId: "ap-board-2", action: "reject" })).toEqual({ result: "ok" });
      expect(w.calls.decide).toEqual([
        { id: "ap-board", input: { action: "approve", actorUserId: OWNER, decisionNote: "Go." } },
        { id: "ap-board-2", input: { action: "reject", actorUserId: OWNER, decisionNote: null } },
      ]);
      expect(w.approvals.map((a) => a.status).slice(0, 2)).toEqual(["approved", "rejected"]);
    });

    it("already decided on the re-read, or applied:false from the host: already_decided; a decided one is never sent again", async () => {
      const w = await make({ approvals: SEEDED });
      await act(w, "decide.approval", { approvalId: "ap-board", action: "approve" });
      expect(await act(w, "decide.approval", { approvalId: "ap-board", action: "reject" })).toEqual({ result: "already_decided" });
      expect(w.calls.decide).toHaveLength(1);
      expect(await act(w, "decide.approval", { approvalId: "ap-missing", action: "approve" })).toEqual({ result: "already_decided" });
      w.decideNotApplied();
      expect(await act(w, "decide.approval", { approvalId: "ap-board-2", action: "approve" })).toEqual({ result: "already_decided" });
    });

    it("refuses hire_agent and budget_override_required (Open only) and a bad action, with no decide call", async () => {
      const w = await make({ approvals: SEEDED });
      await expect(act(w, "decide.approval", { approvalId: "ap-hire", action: "approve" })).rejects.toThrow("decided on its own page");
      await expect(act(w, "decide.approval", { approvalId: "ap-budget", action: "approve" })).rejects.toThrow("decided on its own page");
      await expect(act(w, "decide.approval", { approvalId: "ap-board", action: "maybe" })).rejects.toThrow("approve or reject");
      expect(w.calls.decide).toEqual([]);
      expect(w.approvals.find((a) => a.id === "ap-hire")!.status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  // decide.card
  // -------------------------------------------------------------------------

  describe("decide.card", () => {
    const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "request_confirmation", status: "pending", title: "Share the folder", payload: {}, createdAt: "2026-11-22T09:00:00.000Z", ...extra });

    it("accepts and rejects a pending request_confirmation for nobody or the owner, as the owner", async () => {
      const w = await make();
      const i = await issue(w);
      w.setInteractions({ [i.id]: [card("c-1"), card("c-2", { addresseeUserId: OWNER })] });
      expect(await act(w, "decide.card", { issueId: i.id, interactionId: "c-1", action: "accept" })).toEqual({ result: "ok" });
      expect(await act(w, "decide.card", { issueId: i.id, interactionId: "c-2", action: "reject", note: "Not this one." })).toEqual({ result: "ok" });
      expect(w.calls.respond).toEqual([
        { issueId: i.id, interactionId: "c-1", input: { action: "accept", actorUserId: OWNER, reason: null } },
        { issueId: i.id, interactionId: "c-2", input: { action: "reject", actorUserId: OWNER, reason: "Not this one." } },
      ]);
    });

    it("decided elsewhere (re-read not pending, gone, or applied:false): already_decided", async () => {
      const w = await make();
      const i = await issue(w);
      w.setInteractions({ [i.id]: [card("c-done", { status: "accepted" }), card("c-race")] });
      expect(await act(w, "decide.card", { issueId: i.id, interactionId: "c-done", action: "accept" })).toEqual({ result: "already_decided" });
      expect(await act(w, "decide.card", { issueId: i.id, interactionId: "c-gone", action: "accept" })).toEqual({ result: "already_decided" });
      expect(w.calls.respond).toEqual([]);
      w.respondNotApplied();
      expect(await act(w, "decide.card", { issueId: i.id, interactionId: "c-race", action: "accept" })).toEqual({ result: "already_decided" });
    });

    it("refuses a card for another person or an agent, another kind, and a reject that needs a reason, with no respond call", async () => {
      const w = await make();
      const i = await issue(w);
      w.setInteractions({ [i.id]: [card("c-other", { addresseeUserId: OTHER }), card("c-agent", { addresseeAgentId: OP }), card("c-form", { kind: "ask_user_questions" }), card("c-box", { kind: "request_checkbox_confirmation" }), card("c-why", { payload: { rejectRequiresReason: true } })] });
      await expect(act(w, "decide.card", { issueId: i.id, interactionId: "c-other", action: "accept" })).rejects.toThrow("for someone else");
      await expect(act(w, "decide.card", { issueId: i.id, interactionId: "c-agent", action: "accept" })).rejects.toThrow("for someone else");
      await expect(act(w, "decide.card", { issueId: i.id, interactionId: "c-form", action: "accept" })).rejects.toThrow("answered on its task");
      await expect(act(w, "decide.card", { issueId: i.id, interactionId: "c-box", action: "accept" })).rejects.toThrow("answered on its task");
      await expect(act(w, "decide.card", { issueId: i.id, interactionId: "c-why", action: "reject" })).rejects.toThrow("needs a reason");
      expect(w.calls.respond).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Who may decide
  // -------------------------------------------------------------------------

  describe("only the owner's session gets through, before any host call", () => {
    const REFUSED: Array<[string, Ctx]> = [
      ["another member", SHAPES.otherMember],
      ["an agent key (type agent, userId null, on behalf of the owner)", SHAPES.agentKey],
      ["a run JWT (type agent, userId null, a run id)", SHAPES.runJwt],
      ["the local board user", SHAPES.localBoard],
    ];

    async function setup() {
      const w = await make({ approvals: SEEDED });
      const a = await ask(w);
      const i = await issue(w);
      w.setInteractions({ [i.id]: [{ id: "c-1", kind: "request_confirmation", status: "pending", title: "Share", payload: {}, createdAt: NOW }] });
      const gets = w.calls.issueGets;
      const calls = [
        { key: "decide.ask", params: { askId: a.askId, option: "A" } },
        { key: "decide.approval", params: { approvalId: "ap-board", action: "approve" } },
        { key: "decide.card", params: { issueId: i.id, interactionId: "c-1", action: "accept" } },
      ];
      const untouched = async () => {
        expect(w.calls.personComments).toEqual([]);
        expect(w.calls.approvalsGet).toEqual([]);
        expect(w.calls.decide).toEqual([]);
        expect(w.calls.listInteractions).toEqual([]);
        expect(w.calls.respond).toEqual([]);
        expect(w.calls.issueGets).toBe(gets);
        expect((await row(w, a.askId)).status).toBe("open");
      };
      return { w, a, calls, untouched };
    }

    for (const [who, context] of REFUSED) {
      it(`refuses ${who} on all three actions`, async () => {
        const { w, calls, untouched } = await setup();
        for (const c of calls) await expect(act(w, c.key, c.params, context)).rejects.toThrow(/owner/);
        await untouched();
      });
    }

    it("refuses when the owner cannot be read (getRoles throws): fails closed", async () => {
      const { w, calls, untouched } = await setup();
      const db = w.ctx.db;
      const failing = Object.create(db) as typeof db;
      failing.query = (async (sql: string, params?: unknown[]) => {
        if (/\.roles\b/.test(sql)) throw new Error("db down");
        return db.query(sql, params as never);
      }) as typeof db.query;
      (w.ctx as unknown as { db: unknown }).db = failing;
      for (const c of calls) await expect(act(w, c.key, c.params)).rejects.toThrow("Could not check who owns this company");
      (w.ctx as unknown as { db: unknown }).db = db;
      await untouched();
    });

    it("refuses the owner on an ask routed to another person", async () => {
      const { w, a, untouched } = await setup();
      await w.client.query(`UPDATE ${NAMESPACE}.asks SET owner_user_id = $2 WHERE id = $1`, [a.askId, OTHER]);
      await expect(act(w, "decide.ask", { askId: a.askId, option: "A" })).rejects.toThrow("for someone else");
      await untouched();
    });

    it("the owner's session gets through on all three", async () => {
      const { w, calls } = await setup();
      for (const c of calls) expect(await act(w, c.key, c.params)).toEqual({ result: "ok" });
    });
  });

  // -------------------------------------------------------------------------
  // The hourly hand-back of a lost hand-back
  // -------------------------------------------------------------------------

  describe("reconcileAsks hands back an answered ask whose hand-back was lost", () => {
    const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
    /** An answered ask as a crash between the claim and the hand-back leaves it: closed, no hand-back, issue still with the owner. */
    async function stranded(w: World, closedMinutesAgo: number, body?: Record<string, unknown>) {
      const a = await ask(w, body);
      await w.client.query(`UPDATE ${NAMESPACE}.asks SET status = 'answered', answer = 'A', answered_by_user_id = $2, closed_at = $3, handed_back_at = NULL WHERE id = $1`, [a.askId, OWNER, closedMinutesAgo === 0 ? NOW : minutesAgo(closedMinutesAgo)]);
      return a;
    }

    it("hands it back once (closed 30 minutes ago, no effect, issue open and with the owner)", async () => {
      const w = await make();
      const a = await stranded(w, 30);
      expect(await reconcileAsks(w.env, A)).toEqual({ answered: 0, closed: 0, open: 0, handedBack: 1 });
      expect(w.issues.get(a.issueId)).toMatchObject({ assigneeAgentId: DEV, status: "todo" });
      expect((await row(w, a.askId)).handed_back_at).not.toBeNull();
      expect(await reconcileAsks(w.env, A)).toEqual({ answered: 0, closed: 0, open: 0 });
      expect(handBacks(w, a.issueId)).toBe(1);
      expect(w.wakeups).toEqual([a.issueId]);
    });

    it("leaves it alone when closed under 10 minutes or over 24 hours ago, with an effect, the issue closed, or with an agent", async () => {
      const w = await make();
      const fresh = await stranded(w, 5);
      const old = await stranded(w, 25 * 60);
      const effect = await stranded(w, 30, CARD);
      const closed = await stranded(w, 30);
      w.issues.get(closed.issueId)!.status = "done";
      const agent = await stranded(w, 30);
      Object.assign(w.issues.get(agent.issueId)!, { assigneeAgentId: OP, assigneeUserId: null, status: "todo" });
      expect(await reconcileAsks(w.env, A)).toEqual({ answered: 0, closed: 0, open: 0 });
      for (const a of [fresh, old, effect, closed, agent]) {
        expect((await row(w, a.askId)).handed_back_at).toBeNull();
        expect(handBacks(w, a.issueId)).toBe(0);
      }
      expect(w.wakeups).toEqual([]);
    });
  });
});
