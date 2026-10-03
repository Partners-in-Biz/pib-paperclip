import { describe, expect, it, vi } from "vitest";
import type { DoneCheckIssue } from "@partnersinbiz/pib-plugin-kit";
import {
  checkLeadFollowUp,
  checkQuoteDeal,
  checkReply,
  checkSendFailed,
  checkStep,
  checkWonClient,
  closeStands,
  CRM_DONE_CHECKS,
} from "../src/done-checks.js";
import { CRM_ORIGINS, originFor, parseStepRef, WORK_ORIGIN_RE } from "../src/origins.js";
import { CO, ago, boot, contact, crmIssues, deal, seed, setRoles, tool, toolRaw, type Harness } from "./helpers/crm.js";
import type { Row, Store } from "./helpers/fake-db.js";

/** An issue the CRM opened an hour ago, as the kit's done-check sees it. */
function issue(originId: string, extra: Partial<DoneCheckIssue> = {}): DoneCheckIssue {
  return { id: "iss-1", companyId: CO, identifier: "PIB-1", title: "Work", originId, assigneeAgentId: "am-1", createdAt: ago(60), ...extra };
}

let seq = 0;
function activity(recordType: string, recordId: string, kind: string, minutesAgo: number, extra: Row = {}): Row {
  seq += 1;
  return { id: `a-${seq}`, company_id: CO, record_type: recordType, record_id: recordId, kind, body: kind, issue_id: null, meta: null, source_key: null, created_at: ago(minutesAgo), ...extra };
}

function fact(recordId: string, fieldKey: string, minutesAgo: number, extra: Row = {}): Row {
  seq += 1;
  return { id: `f-${seq}`, company_id: CO, record_type: "contact", record_id: recordId, field_key: fieldKey, value: "x", source: "agent", refused: false, created_at: ago(minutesAgo), ...extra };
}

function enrollment(extra: Row = {}): Row {
  return { id: "e1", company_id: CO, sequence_id: "seq-intro", contact_id: "ada", status: "running", step_position: 1, next_due_at: null, open_issue_id: "iss-1", sending_key: null, mail_thread_id: null, mail_last_message_id: null, created_at: ago(200), ...extra };
}

async function run(store: Store) {
  return (await boot({ store })).harness.ctx;
}

describe("origin ids", () => {
  it("every kind of CRM work has its own crm: prefix, and step ids carry the enrollment and step", () => {
    const prefixes = CRM_DONE_CHECKS.map((rule) => rule.originPrefix);
    expect(prefixes).toEqual(["crm:lead-followup:", "crm:reply:", "crm:step:", "crm:send-failed:", "crm:won-client:", "crm:quote-deal:", "crm:pipeline-check:", "crm:duplicates:", "crm:client-lead:", "crm:service-onboard:", "crm:client-report:", "crm:support-case:", "crm:support-breach:", "crm:client-action-stale:", "crm:churn-risk:", "crm:feedback-low:", "crm:site-down:", "crm:site-tls:", "crm:site-domain:"]);
    for (const prefix of prefixes) expect(prefixes.filter((other) => other !== prefix && other.startsWith(prefix))).toEqual([]);
    expect(originFor.step("e1", 2)).toBe("crm:step:e1:2");
    expect(parseStepRef("crm:step:e1:2", CRM_ORIGINS.step)).toEqual({ enrollmentId: "e1", position: 2 });
    expect(parseStepRef("crm:step:e1", CRM_ORIGINS.step)).toBeNull();
    // Campaigns opens reply: and send-failed: issues too: a CRM rule never matches them.
    expect(CRM_DONE_CHECKS.some((rule) => "reply:m-1".startsWith(rule.originPrefix) || "send-failed:k".startsWith(rule.originPrefix))).toBe(false);
  });

  it("the Account Manager adopts old and new work ids, never approvals or hires", () => {
    for (const id of ["lead:mail:x", "reply:m", "crm:lead-followup:mail:x", "crm:reply:m", "crm:step:e1:1", "crm:send-failed:e1:1", "crm:won-client:d", "crm:quote-deal:q", "crm:sequence-refused:i"]) expect(WORK_ORIGIN_RE.test(id)).toBe(true);
    for (const id of ["crm:sequence-email:s1", "sequence-email:s1", "hire:account-manager"]) expect(WORK_ORIGIN_RE.test(id)).toBe(false);
  });
});

describe("lead follow-up check", () => {
  const origin = originFor.leadFollowUp("mail:g-1");
  const leadStore = (extra: Row = {}): Store => {
    const store = seed();
    store.contacts!.push(contact("nina", "Nina New", { emails: ["nina@new.test"], ...extra }));
    store.activities = [activity("contact", "nina", "lead_captured", 61, { source_key: "lead:mail:g-1" })];
    return store;
  };

  it("reopens with both gaps when nothing was done", async () => {
    const result = await checkLeadFollowUp(await run(leadStore()), issue(origin));
    expect(result.done).toBe(false);
    expect(result.missing).toEqual([
      "Nothing is logged on Nina New (`contact:nina`) since the lead came in: log what you learned with `log-activity`.",
      "Nina New has no next step: set a next action (`update-contact` nextActionKind and nextActionDueAt), create a deal (`create-deal`), or set lifecycle prospect (qualified) or churned (not a fit).",
    ]);
  });

  it("a logged call alone is not enough; work logged before the lead came in never counts", async () => {
    const store = leadStore();
    store.activities!.push(activity("contact", "nina", "call", 90), activity("contact", "nina", "call", 10));
    const result = await checkLeadFollowUp(await run(store), issue(origin));
    expect(result.missing).toHaveLength(1);
    expect(result.missing![0]).toMatch(/^Nina New has no next step/);
    store.activities!.pop();
    expect((await checkLeadFollowUp(await run(store), issue(origin))).missing).toHaveLength(2);
  });

  it("passes with work logged plus a next action, a deal, or a lifecycle decision", async () => {
    const logged = (extra: Row = {}) => {
      const store = leadStore(extra);
      store.activities!.push(activity("contact", "nina", "note", 5));
      return store;
    };
    expect(await checkLeadFollowUp(await run(logged({ next_action_kind: "call", next_action_due_at: "2026-10-01" })), issue(origin))).toEqual({ done: true });
    expect(await checkLeadFollowUp(await run(logged({ lifecycle: "prospect" })), issue(origin))).toEqual({ done: true });
    expect(await checkLeadFollowUp(await run(logged({ lifecycle: "churned" })), issue(origin))).toEqual({ done: true });
    const withDeal = logged();
    withDeal.deals!.push(deal("d-nina", "Nina logo", { contact_id: "nina" }));
    expect(await checkLeadFollowUp(await run(withDeal), issue(origin))).toEqual({ done: true });
  });

  it("counts work logged on the lead's company or deal", async () => {
    const store = leadStore({ next_action_kind: "email" });
    store.contact_companies!.push({ id: "l9", company_id: CO, contact_id: "nina", account_id: "globex", role_label: "owner", created_at: ago(500) });
    store.activities!.push(activity("company", "globex", "meeting", 5));
    expect(await checkLeadFollowUp(await run(store), issue(origin))).toEqual({ done: true });
  });

  it("finished another way: they opted out, or the contact is gone", async () => {
    expect(await checkLeadFollowUp(await run(leadStore({ email_status: "unsubscribed" })), issue(origin))).toEqual({ done: true });
    const gone = leadStore();
    gone.contacts = gone.contacts!.filter((row) => row.id !== "nina");
    expect(await checkLeadFollowUp(await run(gone), issue(origin))).toEqual({ done: true });
  });
});

describe("contact reply check", () => {
  const origin = originFor.reply("m-1");
  const replyStore = (extra: Row = {}): Store => {
    const store = seed();
    Object.assign(store.contacts!.find((row) => row.id === "ada")!, extra);
    store.activities = [activity("contact", "ada", "email_received", 61, { source_key: "mail:m-1" }), activity("contact", "ada", "reply_classified", 61, { source_key: "reply:m-1" })];
    return store;
  };

  it("reopens when nothing shows since the reply came in", async () => {
    const result = await checkReply(await run(replyStore()), issue(origin));
    expect(result).toEqual({
      done: false,
      missing: ["Nothing shows on Ada Lovelace (`contact:ada`) since the reply came in: answer it from the Mailbox and log it (`log-activity`), or record what you decided (a next action, a deal move, or `set-email-status` when they opted out)."],
    });
  });

  it("passes on a logged answer, a next action set since, or a deal move", async () => {
    const answered = replyStore();
    answered.activities!.push(activity("contact", "ada", "email", 3));
    expect(await checkReply(await run(answered), issue(origin))).toEqual({ done: true });
    const decided = replyStore();
    decided.facts = [fact("ada", "nextActionDueAt", 2)];
    expect(await checkReply(await run(decided), issue(origin))).toEqual({ done: true });
    const moved = replyStore();
    moved.activities!.push(activity("deal", "d-acme", "deal_moved", 2));
    expect(await checkReply(await run(moved), issue(origin))).toEqual({ done: true });
  });

  it("a refused write or an older decision is not evidence", async () => {
    const store = replyStore();
    store.facts = [fact("ada", "nextActionDueAt", 2, { refused: true }), fact("ada", "lifecycle", 120)];
    expect((await checkReply(await run(store), issue(origin))).done).toBe(false);
  });

  it("finished another way: the contact opted out", async () => {
    expect(await checkReply(await run(replyStore({ email_status: "unsubscribed" })), issue(origin))).toEqual({ done: true });
  });
});

describe("sequence step and failed email checks", () => {
  const stepStore = (row: Row = {}, contactExtra: Row = {}): Store => {
    const store = seed();
    store.enrollments = [enrollment(row)];
    Object.assign(store.contacts!.find((c) => c.id === "ada")!, contactExtra);
    return store;
  };

  it("a step reopens until it is logged on the contact", async () => {
    const origin = originFor.step("e1", 1);
    expect(await checkStep(await run(stepStore()), issue(origin))).toEqual({
      done: false,
      missing: ['Nothing is logged on Ada Lovelace (`contact:ada`) since step "Say hello" opened: do the step, log it with `log-activity`, then close this issue.'],
    });
    const logged = stepStore();
    logged.activities = [activity("contact", "ada", "call", 4)];
    expect(await checkStep(await run(logged), issue(origin))).toEqual({ done: true });
  });

  it("a step is finished another way when the sequence stopped, moved on or is gone", async () => {
    const origin = originFor.step("e1", 1);
    expect(await checkStep(await run(stepStore({ status: "stopped" })), issue(origin))).toEqual({ done: true });
    expect(await checkStep(await run(stepStore({ step_position: 2 })), issue(origin))).toEqual({ done: true });
    const gone = seed();
    expect(await checkStep(await run(gone), issue(origin))).toEqual({ done: true });
  });

  it("a failed email passes once the address is fixed, the contact was reached, or the address is marked dead", async () => {
    const origin = originFor.sendFailed("e1", 1);
    const open = await checkSendFailed(await run(stepStore()), issue(origin));
    expect(open.done).toBe(false);
    expect(open.missing![0]).toMatch(/^The email for step "Say hello" never reached Ada Lovelace/);
    const fixed = stepStore();
    fixed.facts = [fact("ada", "emails", 5)];
    expect(await checkSendFailed(await run(fixed), issue(origin))).toEqual({ done: true });
    const reached = stepStore();
    reached.activities = [activity("contact", "ada", "message", 5)];
    expect(await checkSendFailed(await run(reached), issue(origin))).toEqual({ done: true });
    expect(await checkSendFailed(await run(stepStore({}, { email_status: "bounced" })), issue(origin))).toEqual({ done: true });
    expect(await checkSendFailed(await run(stepStore({ status: "stopped" })), issue(origin))).toEqual({ done: true });
  });
});

describe("won deal and accepted quote checks", () => {
  it("a won deal without a client reopens until it is linked, unless it is no longer won or gone", async () => {
    const origin = originFor.wonClient("d-orphan");
    const orphan = (extra: Row = {}) => {
      const store = seed();
      store.deals!.push(deal("d-orphan", "Mystery deal", { stage_id: "st-won", ...extra }));
      return store;
    };
    expect(await checkWonClient(await run(orphan()), issue(origin))).toEqual({
      done: false,
      missing: ['The won deal "Mystery deal" (`d-orphan`) still has no client: link it with `update-deal` (dealId, companyRecordId or contactId).'],
    });
    expect(await checkWonClient(await run(orphan({ account_id: "acme" })), issue(origin))).toEqual({ done: true });
    expect(await checkWonClient(await run(orphan({ stage_id: "st-open" })), issue(origin))).toEqual({ done: true });
    expect(await checkWonClient(await run(seed()), issue(origin))).toEqual({ done: true });
  });

  const quoteStore = (): Store => {
    const store = seed();
    store.deals!.push(deal("d-acme-2", "Acme website", { account_id: "acme" }));
    store.activities = [activity("company", "acme", "quote_accepted", 61, { issue_id: "iss-1", meta: { quoteId: "q1", number: "Q-0001", key: "billing:quote:q1:accepted" }, source_key: "quote:billing:quote:q1:accepted" })];
    return store;
  };

  it("an accepted quote reopens until a deal carries it", async () => {
    const origin = originFor.quoteDeal("q1");
    expect(await checkQuoteDeal(await run(quoteStore()), issue(origin))).toEqual({
      done: false,
      missing: ["Quote Q-0001 is not linked to a deal yet: move the deal it closes to won with `move-deal` (dealId, stageId won, quoteId `q1`)."],
    });

    // move-deal with the quoteId links it: the deal records the quote and its timeline says so.
    const store = quoteStore();
    const { harness } = await boot({ store });
    const bad = await toolRaw(harness, "move-deal", { dealId: "d-acme-2", stageId: "Proposal", quoteId: "q1" });
    expect(bad.error).toBe("quoteId goes with stageId won: an accepted quote closes the deal.");
    const moved = await tool(harness, "move-deal", { dealId: "d-acme-2", stageId: "won", quoteId: "q1" });
    expect(moved).toMatchObject({ stageKind: "won", custom: { quoteId: "q1", quoteNumber: "Q-0001" } });
    expect(store.activities!.find((row) => row.record_id === "d-acme-2" && row.kind === "quote_accepted")).toMatchObject({ body: "Quote Q-0001 accepted: it closes this deal.", source_key: "quote-deal:q1" });
    expect(await checkQuoteDeal(harness.ctx, issue(origin))).toEqual({ done: true });
  });

  it("finished another way: one of the client's deals was won since, or none is left open", async () => {
    const origin = originFor.quoteDeal("q1");
    const wonSince = quoteStore();
    Object.assign(wonSince.deals!.find((row) => row.id === "d-acme-2")!, { stage_id: "st-won", won_at: ago(5) });
    expect(await checkQuoteDeal(await run(wonSince), issue(origin))).toEqual({ done: true });
    const allLost = quoteStore();
    for (const row of allLost.deals!.filter((d) => d.account_id === "acme")) row.stage_id = "st-lost";
    expect(await checkQuoteDeal(await run(allLost), issue(origin))).toEqual({ done: true });
    // A win before the quote came in does not count.
    const oldWin = quoteStore();
    oldWin.deals!.push(deal("d-acme-old", "Old", { account_id: "acme", stage_id: "st-won", won_at: ago(500) }));
    expect((await checkQuoteDeal(await run(oldWin), issue(origin))).done).toBe(false);
  });
});

describe("closing through the kit loop (issue.updated)", () => {
  const MAILBOX_LEAD = "plugin.partnersinbiz.mailbox.lead.captured";

  async function close(harness: Harness, issueId: string, actorType: "agent" | "user") {
    const current = (await crmIssues(harness)).find((row) => row.id === issueId)!;
    // The issue opened an hour ago; the work below happens after that.
    harness.seed({ issues: [{ ...current, status: "done", createdAt: new Date(Date.parse(ago(60))) }] });
    await harness.emit("issue.updated", {}, { companyId: CO, entityId: issueId, actorType, actorId: actorType === "agent" ? "am-1" : "user-peet" });
    return (await crmIssues(harness)).find((row) => row.id === issueId)!;
  }

  it("an agent's early close of a lead follow-up is reopened with what is missing; the finished work stays done", async () => {
    const { harness } = await boot();
    await setRoles(harness, { team: { "account-manager": { agentId: "am-1", status: "idle" } } });
    await harness.emit(MAILBOX_LEAD, { key: "mail:g-1", source: "email", name: "Nina New", email: "nina@new.test", text: "Quote for a website?", capturedAt: ago(61) }, { companyId: CO });
    const [followUp] = await crmIssues(harness);
    expect(followUp).toMatchObject({ originId: "crm:lead-followup:mail:g-1", assigneeAgentId: "am-1" });
    expect(followUp!.description).toContain("**Done when** something is logged on them since the lead came in");

    const comments = vi.spyOn(harness.ctx.issues, "createComment");
    const reopened = await close(harness, followUp!.id, "agent");
    expect(reopened.status).toBe("todo");
    expect(String(comments.mock.calls[0]![1])).toMatch(/^\*\*Not done yet\*\* \(Lead follow-up\):\n- Nothing is logged on Nina New/);

    const nina = (await tool<{ results: Array<{ id: string }> }>(harness, "find-records", { query: "nina@new.test" })).results[0]!;
    await tool(harness, "log-activity", { recordType: "contact", recordId: nina.id, kind: "email", body: "Asked about pages and budget." });
    await tool(harness, "update-contact", { contactId: nina.id, nextActionKind: "call", nextActionDueAt: "2026-10-01" });
    expect((await close(harness, followUp!.id, "agent")).status).toBe("done");
  });

  it("a person's close is never checked", async () => {
    const { harness } = await boot();
    await harness.emit(MAILBOX_LEAD, { key: "mail:g-2", source: "email", name: "Zed", email: "zed@new.test", text: "Hi", capturedAt: ago(61) }, { companyId: CO });
    const [followUp] = await crmIssues(harness);
    expect((await close(harness, followUp!.id, "user")).status).toBe("done");
  });

  it("an agent's early close of a step is reopened and the contact stays on that step", async () => {
    const store = seed();
    store.enrollments = [enrollment({ open_issue_id: null, next_due_at: ago(5) })];
    const { harness } = await boot({ store });
    await setRoles(harness, { team: { "account-manager": { agentId: "am-1", status: "idle" } } });
    await harness.runJob("open-due-steps");
    const [step] = await crmIssues(harness);
    expect(step!.originId).toBe("crm:step:e1:1");
    expect((await close(harness, step!.id, "agent")).status).toBe("todo");
    expect(store.enrollments![0]).toMatchObject({ step_position: 1, open_issue_id: step!.id });
    // A person may still close it by hand: the contact moves on.
    await close(harness, step!.id, "user");
    expect(store.enrollments![0]).toMatchObject({ step_position: 2, open_issue_id: null });
  });

  it("a broken check never holds a step up", async () => {
    const { harness } = await boot();
    const failing = { ...harness.ctx, db: { ...harness.ctx.db, query: async () => { throw new Error("db down"); } } } as typeof harness.ctx;
    expect(await closeStands(failing, issue(originFor.step("e1", 1)))).toBe(true);
    expect(await closeStands(harness.ctx, issue("crm:sequence-email:s1"))).toBe(true);
  });
});
