/**
 * An answer must be an effect (RC5), end to end against a real Postgres for
 * the Cockpit's asks and the host's issues, with the fake host for issues,
 * grants and events: a card that carries what a yes does, the owner's reply
 * announcing it to the plugin that handles it, the agent woken only when the
 * result is in, a failure that reaches the owner, re-announcing, a timeout,
 * and the safety rules (only a person's yes runs it; the card is complete).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASK_EVENTS, askAnsweredKey, MEMORY_AGENT_TOOLS, MEMORY_TOOLS_GRANT, type AskAnswered, type AskEffectResult } from "@partnersinbiz/pib-plugin-kit";
import { describeEffect } from "../src/ask-model.js";
import { effectWaitingItems, EFFECT_REANNOUNCE_MS, EFFECT_TIMEOUT_MS, onAskComment, onEffectResult, reannounceEffects } from "../src/asks.js";
import { ensureGrantAsk } from "../src/effects.js";
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

d("asks that do something when answered (Postgres)", () => {
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

  const CARD = {
    question: "May the Operator read and draft in the shared mailbox?",
    why: "Four inbound replies wait behind it.",
    kind: "grant",
    options: ["Yes: read and draft (never send)", "No"],
    links: [{ label: "Mailbox delegations", href: "/PAR/mailbox?tab=delegations" }],
    steps: ["Open the Mailbox page, Delegations tab.", "Add the Operator with read and draft."],
    effect: { key: "mailbox.delegate", params: { accountId: "acc-1", agentId: OP, scope: "read+draft" } },
  };

  let n = 0;
  /** An issue the agent works on, in the fake host and (same uuid) in the stand-in core table the Needs-you query joins. */
  async function agentIssue(w: Hybrid) {
    n += 1;
    const id = `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const issue = { id, companyId: A, identifier: `PAR-${100 + n}`, title: "Reply to the Covalonic enquiry", description: "", status: "in_progress", assigneeAgentId: SEO };
    w.issues.set(id, issue);
    await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id) VALUES ($1, $2, $3, $4, 'in_progress', $5)`, [id, A, issue.identifier, issue.title, SEO]);
    return issue;
  }

  async function ask(w: Hybrid, card: Record<string, unknown> = CARD) {
    const issue = await agentIssue(w);
    const result = (await w.tools.get("ask-owner")!({ issueId: issue.id, ...card }, RUN)) as { error?: string; data: { askId: string } };
    return { issue, result };
  }

  const row = async (w: Hybrid) => (await w.client.query(`SELECT * FROM ${NAMESPACE}.asks WHERE company_id = $1 ORDER BY asked_at DESC LIMIT 1`, [A])).rows[0] as Record<string, any>;
  const rowOf = async (w: Hybrid, issueId: string) => (await w.client.query(`SELECT * FROM ${NAMESPACE}.asks WHERE company_id = $1 AND issue_id = $2`, [A, issueId])).rows[0] as Record<string, any>;
  const openCount = async (w: Hybrid) => Number(((await w.client.query(`SELECT count(*) AS n FROM ${NAMESPACE}.asks WHERE company_id = $1 AND status = 'open'`, [A])).rows[0] as Record<string, any>).n);
  const reply = (w: Hybrid, issueId: string, text: string, user = "user-owner") => {
    const commentId = w.userComment(issueId, text, user);
    return onAskComment(w.env, { companyId: A, entityId: issueId, entityType: "issue", actorType: "user", actorId: user, payload: { commentId } } as never);
  };
  const answered = (w: Hybrid) => w.emitted.filter((e) => e.name === ASK_EVENTS.answered).map((e) => e.payload as AskAnswered);
  const result = (a: AskAnswered, extra: Partial<AskEffectResult> = {}): AskEffectResult => ({ key: a.key, askId: a.askId, effectKey: a.effect.key, plugin: "partnersinbiz.mailbox", status: "applied", detail: "Delegation created for the Operator: read and draft.", verified: true, at: NOW, ...extra });

  describe("the card", () => {
    it("carries what a yes does, in the comment the owner answers and in the Needs-you list", async () => {
      const w = await make();
      const { issue, result: r } = await ask(w);
      expect(r.error).toBeUndefined();
      const stored = await row(w);
      expect(stored).toMatchObject({ source: "agent", kind: "grant", status: "open", effect_status: null });
      expect(stored.effect).toEqual(CARD.effect);
      const comment = w.comments.find((c) => c.issueId === issue.id)!.body;
      expect(comment).toContain(`**If you say yes to the first option:** ${describeEffect(CARD.effect)} It is checked afterwards, and Sam is told what happened.`);
      expect(comment).toContain("Runs mailbox.delegate with accountId=acc-1, agentId=" + OP + ", scope=read+draft when you say yes.");
      expect(w.issues.get(issue.id)).toMatchObject({ assigneeUserId: "user-owner", status: "in_review" });
    });

    it("refuses a card the owner would have to hunt through: no link, a grant with no steps, an effect on a money question, a bad key", async () => {
      const w = await make();
      const refused = async (patch: Record<string, unknown>) => (await ask(w, { ...CARD, ...patch })).result.error ?? "";
      expect(await refused({ links: undefined })).toContain("The question is not ready to send");
      expect(await refused({ links: undefined })).toContain("Add at least one link");
      expect(await refused({ links: [{ label: "The issue", href: "/PAR/issues/PAR-1" }] })).toContain("must link the exact screen");
      expect(await refused({ steps: [] })).toContain("A grant ask needs steps");
      expect(await refused({ kind: "money" })).toContain("An ask with an effect (mailbox.delegate) is a grant or a decision, not money");
      expect(await refused({ effect: { key: "Mailbox Delegate" } })).toContain('effect must be {key, params}: key is "<plugin>.<action>"');
      expect(await refused({ effect: { key: "fridge.open" } })).toContain("effect must be {key, params}");
      expect(await refused({ effect: { key: "mailbox.delegate", params: { a: { nested: true } } } })).toContain("must be text, a number or true/false");
      expect(await refused({ effect: { key: "cockpit.attest", params: { key: "signup_closed" } } })).toContain("is not an effect an agent may ask for");
      expect(await refused({ effect: { key: "cockpit.invent" } })).toContain("is not an effect the Cockpit knows");
      expect((await w.client.query(`SELECT 1 FROM ${NAMESPACE}.asks`)).rows).toHaveLength(0);
    });

    it("every ask needs a link now, a plain decision may link its own issue", async () => {
      const w = await make();
      const plain = await ask(w, { question: "Which colour?", why: "The brief is silent.", kind: "decision", links: [{ label: "The issue", href: "/PAR/issues/PAR-1" }] });
      expect(plain.result.error).toBeUndefined();
      const none = await ask(w, { question: "Which colour?", why: "The brief is silent.", kind: "decision" });
      expect(none.result.error).toContain("Add at least one link");
    });
  });

  describe("another plugin's effect", () => {
    it("a yes is announced to the plugin, and the agent is NOT woken until the result is in", async () => {
      const w = await make();
      const { issue } = await ask(w);
      expect(await reply(w, issue.id, "Yes")).toBe("answered");
      const [event] = answered(w);
      expect(event).toMatchObject({ askId: (await row(w)).id, issueId: issue.id, kind: "grant", answer: "Yes", answeredByUserId: "user-owner", returnAgentId: SEO, effect: CARD.effect });
      expect(event!.key).toBe(askAnsweredKey(event!.askId, (await row(w)).closed_at.toISOString()));
      expect(await row(w)).toMatchObject({ status: "answered", effect_status: "pending", effect_key: event!.key, effect_announced_count: 1, handed_back_at: null });
      expect(w.wakeups).toEqual([]);
      expect(w.issues.get(issue.id)!.assigneeAgentId).toBeFalsy(); // still with the owner
    });

    it("an applied result is said on the issue and wakes the agent with what happened; a repeat or a stale result changes nothing", async () => {
      const w = await make();
      const { issue } = await ask(w);
      await reply(w, issue.id, "Yes");
      const [event] = answered(w);
      expect(await onEffectResult(w.env, A, result(event!, { key: "ask:other:key" }))).toBe("ignored"); // not this announcement
      expect(await onEffectResult(w.env, A, result(event!))).toBe("settled");
      expect(await onEffectResult(w.env, A, result(event!))).toBe("ignored");
      expect(await row(w)).toMatchObject({ effect_status: "applied", effect_detail: "Delegation created for the Operator: read and draft." });
      expect(w.comments.filter((c) => c.issueId === issue.id && c.body.startsWith("**Applied and checked:**"))).toHaveLength(1);
      expect(w.issues.get(issue.id)).toMatchObject({ assigneeAgentId: SEO, status: "todo" });
      expect(w.wakeups).toEqual([issue.id]);
      expect(w.wakeReasons[0]!.reason).toContain("What the answer was meant to do: applied: Delegation created for the Operator: read and draft.");
    });

    it("the result arrives through the event the plugin emits", async () => {
      const w = await make();
      const { issue } = await ask(w);
      await reply(w, issue.id, "Yes");
      const [event] = answered(w);
      await w.fire("plugin.partnersinbiz.mailbox.ask.effect.result", { companyId: A, payload: result(event!) });
      expect(await row(w)).toMatchObject({ effect_status: "applied" });
      expect(w.wakeups).toEqual([issue.id]);
    });

    it("a failed or refused effect reaches the owner as a Needs-you item, and tells the agent not to ask again", async () => {
      const w = await make();
      const { issue } = await ask(w);
      await reply(w, issue.id, "Yes");
      const [event] = answered(w);
      await onEffectResult(w.env, A, result(event!, { status: "failed", verified: false, detail: "Could not apply it: the mailbox is not connected." }));
      expect(w.comments.some((c) => c.issueId === issue.id && c.body.startsWith("**Could not apply it:** Could not apply it: the mailbox is not connected."))).toBe(true);
      expect(w.comments.some((c) => c.body.includes("Do not ask again: a person has to look at why it failed."))).toBe(true);
      expect(w.wakeReasons[0]!.reason).toContain("failed: Could not apply it: the mailbox is not connected.");
      const items = await effectWaitingItems(w.env, A);
      expect(items).toEqual([expect.objectContaining({ key: `ask-effect:${(await row(w)).id}`, kind: "judgement", issueId: issue.id, title: 'The answer to "May the Operator read and draft in the shared mailbox?" could not be applied' })]);
      expect(items[0]!.why).toBe("mailbox.delegate: failed. Could not apply it: the mailbox is not connected. A person has to look at why; the agent was told not to ask again.");
      // closing the issue clears the item: nothing is left for anyone to do
      await w.client.query(`UPDATE public.issues SET status = 'done' WHERE id = $1`, [issue.id]);
      expect(await effectWaitingItems(w.env, A)).toEqual([]);
    });

    it("a refused effect is listed the same way, with the safety check named", async () => {
      const w = await make();
      const { issue } = await ask(w);
      await reply(w, issue.id, "Yes");
      await onEffectResult(w.env, A, result(answered(w)[0]!, { status: "refused", verified: false, detail: "Nothing was changed: account acc-1 does not belong to this company." }));
      const [item] = await effectWaitingItems(w.env, A);
      expect(item!.why).toBe("mailbox.delegate: was refused by a safety check. Nothing was changed: account acc-1 does not belong to this company. A person has to look at why; the agent was told not to ask again.");
      // an old failure (over 14 days) is not nagged about
      w.clock.set("2026-10-30T12:00:00.000Z");
      expect(await effectWaitingItems(w.env, A)).toEqual([]);
    });

    it("announces a no as well: the plugin that handles the effect reads the answer, and its declined result hands the issue back with the reason", async () => {
      const w = await make();
      const { issue } = await ask(w);
      await reply(w, issue.id, "No, not now");
      const [event] = answered(w);
      expect(event!.answer).toBe("No, not now");
      expect(w.wakeups).toEqual([]);
      await onEffectResult(w.env, A, result(event!, { status: "declined", verified: true, detail: "The owner declined, so nothing was changed." }));
      expect(await row(w)).toMatchObject({ effect_status: "declined", effect_detail: "The owner declined, so nothing was changed." });
      expect(w.issues.get(issue.id)).toMatchObject({ assigneeAgentId: SEO, status: "todo" });
      expect(w.wakeReasons[0]!.reason).toContain("declined: The owner declined, so nothing was changed.");
      expect(await effectWaitingItems(w.env, A)).toEqual([]); // a no is an answer, not a failure
    });

    it("an answer with no person behind it is announced with that fact, and nothing the plugin applies can come from an agent's comment", async () => {
      const w = await make();
      const { issue } = await ask(w);
      await reply(w, issue.id, "Yes", "local-board");
      expect(answered(w)[0]).toMatchObject({ answeredByUserId: "local-board" });
      // an agent's comment is never an answer at all
      const second = await ask(w);
      const commentId = w.userComment(second.issue.id, "Yes", "user-owner");
      expect(await onAskComment(w.env, { companyId: A, entityId: second.issue.id, entityType: "issue", actorType: "agent", actorId: SEO, payload: { commentId } } as never)).toBe("ignored");
      expect((await w.client.query(`SELECT status FROM ${NAMESPACE}.asks WHERE issue_id = $1`, [second.issue.id])).rows[0]).toMatchObject({ status: "open" });
    });

    it("a reply that also closes the issue still runs the effect, and the issue stays closed", async () => {
      const w = await make();
      const { issue } = await ask(w);
      w.issues.get(issue.id)!.status = "done";
      expect(await reply(w, issue.id, "Yes")).toBe("answered");
      expect(await row(w)).toMatchObject({ status: "resolved", effect_status: "pending" });
      expect(answered(w)).toHaveLength(1);
      await onEffectResult(w.env, A, result(answered(w)[0]!));
      expect(w.issues.get(issue.id)!.status).toBe("done");
      expect(w.wakeups).toEqual([]);
    });
  });

  describe("re-announcing and the timeout", () => {
    it("re-sends an answer nobody confirmed, with the same key, never more often than every five minutes", async () => {
      const w = await make();
      const { issue } = await ask(w);
      await reply(w, issue.id, "Yes");
      const [first] = answered(w);
      expect(await reannounceEffects(w.env, A)).toEqual({ resent: 0, timedOut: 0 }); // just announced
      w.clock.set(new Date(Date.parse(NOW) + EFFECT_REANNOUNCE_MS + 1000).toISOString());
      expect(await reannounceEffects(w.env, A)).toEqual({ resent: 1, timedOut: 0 });
      expect(answered(w)).toHaveLength(2);
      expect(answered(w)[1]).toEqual(first);
      expect(await row(w)).toMatchObject({ effect_announced_count: 2, effect_status: "pending" });
      expect(await reannounceEffects(w.env, A)).toEqual({ resent: 0, timedOut: 0 });
      await onEffectResult(w.env, A, result(first!));
      expect(await reannounceEffects(w.env, A)).toEqual({ resent: 0, timedOut: 0 }); // settled: nothing to send
    });

    it("gives up after three hours with a failure the owner can see, and hands the issue back", async () => {
      const w = await make();
      const { issue } = await ask(w);
      await reply(w, issue.id, "Yes");
      w.clock.set(new Date(Date.parse(NOW) + EFFECT_TIMEOUT_MS + 60_000).toISOString());
      expect(await reannounceEffects(w.env, A)).toEqual({ resent: 0, timedOut: 1 });
      const stored = await row(w);
      expect(stored).toMatchObject({ effect_status: "timeout" });
      expect(stored.effect_detail).toContain("Nothing answered in 3 hours: the plugin that handles mailbox.delegate is missing, switched off, or its settings are not saved");
      expect(w.issues.get(issue.id)).toMatchObject({ assigneeAgentId: SEO, status: "todo" });
      expect((await effectWaitingItems(w.env, A))[0]!.why).toContain("got no answer from the plugin that handles it");
      expect(w.comments.some((c) => c.body.startsWith("**Could not apply it:**"))).toBe(true);
    });
  });

  describe("the memory grant (the Cockpit handles it itself)", () => {
    const grantCard = (agentIds: string) => ({ ...CARD, question: "May Sam use company memory?", options: ["Yes: memory tools only", "No"], links: [{ label: "Agents", href: "/PAR/agents" }], effect: { key: "cockpit.grant-memory-tools", params: { agentIds } } });

    it("a yes grants the four memory tools and nothing else, checks it, and wakes the agent with the result", async () => {
      const w = await make();
      const { issue } = await ask(w, grantCard(SEO));
      await reply(w, issue.id, "Yes");
      expect(w.grants.get(SEO)).toEqual([{ permissionKey: MEMORY_TOOLS_GRANT.permissionKey, scope: { toolNames: [...MEMORY_AGENT_TOOLS] } }]);
      expect(await row(w)).toMatchObject({ effect_status: "applied" });
      expect((await row(w)).effect_detail).toContain("Sam: memory tools granted");
      expect(answered(w)).toEqual([]); // handled here, nothing announced
      expect(w.wakeReasons[0]!.reason).toContain("applied:");
      expect(w.comments.some((c) => c.body.startsWith("**Applied and checked:**"))).toBe(true);
    });

    it("refuses an agent id that is not an agent of this company, and writes nothing", async () => {
      const w = await make();
      const { issue } = await ask(w, grantCard("cccccccc-0000-4000-8000-000000000009"));
      await reply(w, issue.id, "Yes");
      expect(await row(w)).toMatchObject({ effect_status: "refused" });
      expect((await row(w)).effect_detail).toContain("is not an active agent of this company");
      expect(w.grants.has("cccccccc-0000-4000-8000-000000000009")).toBe(false);
      expect(w.grants.get(SEO)).toBeUndefined();
    });

    it("applies nothing for a no, for an answer that adds a condition, or for an answer with no person behind it", async () => {
      const w = await make();
      const a = await ask(w, grantCard(SEO));
      await reply(w, a.issue.id, "No, not now");
      expect(await rowOf(w, a.issue.id)).toMatchObject({ effect_status: "declined", effect_detail: "The owner declined, so nothing was changed." });
      expect(w.wakeReasons.at(-1)!.reason).toContain("declined:");
      const b = await ask(w, grantCard(SEO));
      await reply(w, b.issue.id, "Yes, and also let it send mail");
      expect(await rowOf(w, b.issue.id)).toMatchObject({ effect_status: "unclear" });
      expect(w.wakeReasons.at(-1)!.reason).toContain("unclear: The answer was not a clear yes or no to the first option, so nothing was changed.");
      const c = await ask(w, grantCard(SEO));
      await reply(w, c.issue.id, "Yes", "local-board");
      expect(await rowOf(w, c.issue.id)).toMatchObject({ status: "answered", effect_status: "refused" });
      expect((await rowOf(w, c.issue.id)).effect_detail).toContain("this answer has no person behind it");
      expect(w.wakeReasons.at(-1)!.reason).toContain("refused:");
      expect(w.grants.get(SEO)).toBeUndefined();
    });
  });

  describe("the question the Cockpit asks about memory access on its own account", () => {
    it("asks once for every agent that cannot use memory, applies it on a yes and closes its own issue", async () => {
      const w = await make();
      (w.agents[1] as { adapterConfig: unknown }).adapterConfig = { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/company-os"] } };
      const opened = await ensureGrantAsk(w.env, A);
      expect(opened.action).toBe("opened");
      const stored = await row(w);
      expect(stored).toMatchObject({ source: "cockpit", kind: "grant", agent_id: null, return_agent_id: OP });
      expect(stored.question).toBe("May Sam use company memory? They carry PiB skills but cannot call the memory tools.");
      expect(stored.options[0]).toBe("Yes: memory tools only (memory-recall, memory-search, memory-add, memory-feedback)");
      expect(stored.effect).toEqual({ key: "cockpit.grant-memory-tools", params: { agentIds: SEO } });
      expect(w.issues.get(stored.issue_id)).toMatchObject({ title: "Let 1 agent use company memory", assigneeUserId: "user-owner", status: "in_review" });
      expect((await ensureGrantAsk(w.env, A)).action).toBe("none"); // the same agents, asked about already
      expect(await openCount(w)).toBe(1);
      await reply(w, stored.issue_id, "Yes");
      expect(w.grants.get(SEO)![0]!.scope).toEqual({ toolNames: [...MEMORY_AGENT_TOOLS] });
      expect(w.issues.get(stored.issue_id)!.status).toBe("done");
      expect(w.wakeups).toEqual([]);
      // nothing left to ask; and a new agent is a new question
      expect((await ensureGrantAsk(w.env, A)).action).toBe("none");
      w.agents.push({ id: "bbbbbbbb-0000-4000-8000-000000000001", companyId: A, name: "Penny", status: "active", role: "general", adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/company-os"] } } } as never);
      expect((await ensureGrantAsk(w.env, A)).action).toBe("opened");
    });

    it("does not ask again, for 14 days, about agents the owner already said no to", async () => {
      const w = await make();
      (w.agents[1] as { adapterConfig: unknown }).adapterConfig = { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/company-os"] } };
      await ensureGrantAsk(w.env, A);
      const stored = await row(w);
      await reply(w, stored.issue_id, "No");
      w.clock.set("2026-10-10T12:00:00.000Z");
      expect((await ensureGrantAsk(w.env, A)).action).toBe("none");
      w.clock.set("2026-10-20T12:00:00.000Z");
      expect((await ensureGrantAsk(w.env, A)).action).toBe("opened");
    });

    it("without an owner there is nobody to ask", async () => {
      const w = await make();
      await w.client.query(`UPDATE ${NAMESPACE}.roles SET owner_user_id = NULL`);
      (w.agents[1] as { adapterConfig: unknown }).adapterConfig = { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/company-os"] } };
      expect(await ensureGrantAsk(w.env, A)).toMatchObject({ action: "skipped", reason: "No owner is set, so there is nobody to ask." });
    });
  });
});
