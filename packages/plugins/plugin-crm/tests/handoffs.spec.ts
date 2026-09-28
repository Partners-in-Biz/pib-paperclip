import { describe, expect, it } from "vitest";
import { statusFor } from "../src/handoffs.js";
import { BOARD, CO, ago, boot, crmIssues, seed, setRoles, tool, toolRaw } from "./helpers/crm.js";

const BILLING = "plugin.partnersinbiz.billing";

const emitted = (emit: { mock: { calls: unknown[][] } }, name: string) =>
  emit.mock.calls.filter(([event]) => event === name).map(([, , payload]) => payload as Record<string, any>);

describe("a won deal", () => {
  it("makes the client a customer, logs it and tells Billing and the Cockpit (first win)", async () => {
    const { harness, store, emit } = await boot();
    const moved = await tool(harness, "move-deal", { dealId: "d-acme", stageId: "won" });
    expect(moved).toMatchObject({ stageKind: "won", stageName: "Won", won: { firstWin: true, emitted: true } });
    expect(moved.next).toMatch(/First win: the Cockpit opens onboarding/);
    expect(store.companies!.find((c) => c.id === "acme")!.lifecycle).toBe("customer");
    expect(store.contacts!.find((c) => c.id === "ada")!.lifecycle).toBe("customer");
    expect(store.deals!.find((d) => d.id === "d-acme")!.won_at).toBeTruthy();
    expect(store.activities!.find((a) => a.kind === "deal_won")).toMatchObject({ record_type: "company", record_id: "acme" });
    const [won] = emitted(emit, "deal.won");
    expect(won).toMatchObject({
      key: "crm:deal:d-acme:won", dealId: "d-acme", title: "Acme SEO retainer", valueMinor: 100_000, currency: "ZAR",
      clientKind: "company", clientRef: "acme", clientName: "Acme Plumbing", contactEmail: "ada@acme.co.za", firstWin: true,
    });
    // The contact's sequences stop.
    expect(store.handoffs).toEqual([expect.objectContaining({ key: "crm:deal:d-acme:won", event: "deal.won" })]);
  });

  it("a customer's next win is not a first win; a sole trader contact is the client", async () => {
    const store = seed();
    store.deals!.push({ ...store.deals![1]!, id: "d-solo-2", title: "Solo SEO" });
    const { harness, emit } = await boot({ store });
    await tool(harness, "move-deal", { dealId: "d-solo-2", stageId: "st-won" });
    expect(emitted(emit, "deal.won")[0]).toMatchObject({ clientKind: "contact", clientRef: "solo", firstWin: false, contactEmail: "sipho@solo.test" });
    // Moving an already won deal again changes nothing.
    await tool(harness, "move-deal", { dealId: "d-solo-2", stageId: "Won" });
    expect(emitted(emit, "deal.won")).toHaveLength(1);
  });

  it("a won deal without a client opens a hand-off for the Account Manager", async () => {
    const store = seed();
    store.deals!.push({ ...store.deals![0]!, id: "d-orphan", title: "Mystery deal", account_id: null, contact_id: null });
    const { harness, emit } = await boot({ store });
    await setRoles(harness, { team: { "account-manager": { agentId: "am-1", status: "idle" } } });
    const moved = await tool(harness, "move-deal", { dealId: "d-orphan", stageId: "won" });
    expect(moved.won).toMatchObject({ emitted: false, issueId: expect.any(String) });
    const issue = (await crmIssues(harness)).find((i) => i.originId === "crm:won-client:d-orphan")!;
    expect(issue).toMatchObject({ assigneeAgentId: "am-1", title: 'Hand-off: link the won deal "Mystery deal" to its client' });
    expect(emitted(emit, "deal.won")).toEqual([]);
  });

  it("moving by stage name works; an unknown stage lists the real ones", async () => {
    const { harness } = await boot();
    expect(await tool(harness, "move-deal", { dealId: "d-acme", stageId: "discovery" })).toMatchObject({ stageName: "Discovery", stageKind: "open" });
    expect((await toolRaw(harness, "move-deal", { dealId: "d-acme", stageId: "Pitch" })).error).toMatch(/No stage Pitch\. Stages: Discovery, Proposal, Won, Lost/);
  });
});

describe("Billing: quote accepted", () => {
  const quote = (extra: Record<string, unknown> = {}) => ({ key: "billing:quote:q1:accepted", quoteId: "q1", number: "Q-0001", dealId: null, clientKind: "company", clientRef: "acme", totalMinor: 250_000, currency: "ZAR", acceptedAt: "2026-09-27T08:00:00Z", ...extra });

  it("moves the linked deal to won (once)", async () => {
    const { harness, store, emit } = await boot();
    await harness.emit(`${BILLING}.quote.accepted`, quote({ dealId: "d-acme" }), { companyId: CO });
    await harness.emit(`${BILLING}.quote.accepted`, quote({ dealId: "d-acme" }), { companyId: CO });
    expect(store.deals!.find((d) => d.id === "d-acme")!.stage_id).toBe("st-won");
    expect(emitted(emit, "deal.won")).toHaveLength(1);
    expect(store.activities!.filter((a) => a.kind === "quote_accepted")).toEqual([expect.objectContaining({ record_type: "deal", record_id: "d-acme", body: "Quote Q-0001 accepted (R 2,500.00)." })]);
  });

  it("without a deal id, uses the client's only open deal", async () => {
    const { harness, store } = await boot();
    await harness.emit(`${BILLING}.quote.accepted`, quote(), { companyId: CO });
    expect(store.deals!.find((d) => d.id === "d-acme")!.stage_id).toBe("st-won");
  });

  it("with no open deal, records the sale as a won deal", async () => {
    const { harness, store, emit } = await boot();
    await harness.emit(`${BILLING}.quote.accepted`, quote({ key: "billing:quote:q2:accepted", quoteId: "q2", number: "Q-0002", clientRef: "globex" }), { companyId: CO });
    const created = store.deals!.find((d) => d.title === "Quote Q-0002")!;
    expect(created).toMatchObject({ account_id: "globex", stage_id: "st-won", amount_minor: 250_000 });
    expect(emitted(emit, "deal.won")[0]).toMatchObject({ dealId: created.id, clientRef: "globex", firstWin: true });
  });

  it("with several open deals, asks the Account Manager to pick", async () => {
    const store = seed();
    store.deals!.push({ ...store.deals![0]!, id: "d-acme-2", title: "Acme website" });
    const { harness, emit } = await boot({ store });
    await setRoles(harness, { team: { "account-manager": { agentId: "am-1", status: "idle" } } });
    await harness.emit(`${BILLING}.quote.accepted`, quote(), { companyId: CO });
    const issue = (await crmIssues(harness)).find((i) => i.originId === "crm:quote-deal:q1")!;
    expect(issue).toMatchObject({ assigneeAgentId: "am-1", title: "Hand-off: pick the deal for accepted quote Q-0001 (company:acme)" });
    expect(issue.description).toContain("`d-acme`");
    expect(issue.description).toContain("`d-acme-2`");
    expect(emitted(emit, "deal.won")).toEqual([]);
  });
});

describe("Billing: invoice paid", () => {
  it("logs it on the client and makes sure the lifecycle is customer", async () => {
    const { harness, store } = await boot();
    const paid = { key: "billing:invoice:i1:paid", invoiceId: "i1", number: "INV-0001", dealId: null, clientKind: "company", clientRef: "globex", totalMinor: 99_900, currency: "ZAR", paidAt: "2026-09-27T08:00:00Z" };
    await harness.emit(`${BILLING}.invoice.paid`, paid, { companyId: CO });
    await harness.emit(`${BILLING}.invoice.paid`, paid, { companyId: CO });
    expect(store.companies!.find((c) => c.id === "globex")!.lifecycle).toBe("customer");
    expect(store.activities!.filter((a) => a.kind === "invoice_paid")).toEqual([expect.objectContaining({ record_id: "globex", body: "Invoice INV-0001 paid (R 999.00). Lifecycle set to customer." })]);
  });
});

describe("suppression", () => {
  const running = (id: string, contactId: string) => ({ id, company_id: CO, sequence_id: "seq-intro", contact_id: contactId, status: "running", step_position: 1, next_due_at: "2099-01-01T00:00:00Z", open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null, created_at: "2026-09-01T00:00:00Z" });

  it("an opt-out from Campaigns sets the email status and stops the contact's sequences, once", async () => {
    const store = seed();
    store.enrollments = [running("e1", "ada")];
    const { harness, emit } = await boot({ store });
    const payload = { key: "suppress:ada@acme.co.za:unsubscribed", email: "ADA@acme.co.za", reason: "unsubscribed", scope: "marketing", source: "partnersinbiz.campaigns", at: "2026-09-27T08:00:00Z" };
    await harness.emit("plugin.partnersinbiz.campaigns.contact.suppressed", payload, { companyId: CO });
    await harness.emit("plugin.partnersinbiz.campaigns.contact.suppressed", payload, { companyId: CO });
    expect(store.contacts!.find((c) => c.id === "ada")!.email_status).toBe("unsubscribed");
    expect(store.enrollments![0]!.status).toBe("stopped");
    expect(store.activities!.filter((a) => a.kind === "email_suppressed")).toHaveLength(1);
    // The CRM does not echo what it was told.
    expect(emitted(emit, "contact.suppressed")).toEqual([]);
  });

  it("a hard bounce from the Mailbox is never softened by a later unsubscribe", async () => {
    const { harness, store } = await boot();
    await harness.emit("plugin.partnersinbiz.mailbox.contact.suppressed", { key: "suppress:grace@globex.test:bounced", email: "grace@globex.test", reason: "bounced", scope: "all", source: "partnersinbiz.mailbox", at: "x" }, { companyId: CO });
    await harness.emit("plugin.partnersinbiz.campaigns.contact.suppressed", { key: "suppress:grace@globex.test:unsubscribed", email: "grace@globex.test", reason: "unsubscribed", scope: "marketing", source: "partnersinbiz.campaigns", at: "x" }, { companyId: CO });
    expect(store.contacts!.find((c) => c.id === "grace")!.email_status).toBe("bounced");
    expect(statusFor("unsubscribed", "bounced")).toBe("bounced");
    expect(statusFor("complained", "ok")).toBe("unsubscribed");
  });

  it("set-email-status: an agent records an opt-out and the other modules are told; only a person allows email again", async () => {
    const store = seed();
    store.enrollments = [running("e1", "ada")];
    const { harness, emit } = await boot({ store });
    const out = await tool(harness, "set-email-status", { contactId: "ada", status: "unsubscribed", note: "asked on a call" });
    expect(out).toMatchObject({ contact: "contact:ada", emailStatus: "unsubscribed", told: true });
    expect(store.enrollments![0]!.status).toBe("stopped");
    expect(emitted(emit, "contact.suppressed")).toEqual([expect.objectContaining({ key: "suppress:ada@acme.co.za:unsubscribed", reason: "unsubscribed", scope: "marketing", source: "partnersinbiz.crm" })]);
    expect(store.activities!.find((a) => a.kind === "email_status")!.body).toMatch(/set to unsubscribed by an agent: asked on a call/);
    expect((await toolRaw(harness, "set-email-status", { contactId: "ada", status: "ok" })).error).toMatch(/must be one of|Only a person/);
    await harness.performAction("crm.set-email-status", { contactId: "ada", status: "ok" }, { companyId: CO, actor: BOARD });
    expect(store.contacts!.find((c) => c.id === "ada")!.email_status).toBe("ok");
  });

  it("the last day's hand-offs are re-sent on the hourly job", async () => {
    const { harness, emit, store } = await boot();
    await tool(harness, "set-email-status", { contactId: "grace", status: "bounced" });
    store.handoffs!.push({ id: "old", key: "old", company_id: CO, event: "deal.won", payload: { key: "old" }, created_at: ago(3 * 1440) });
    emit.mockClear();
    await harness.runJob("setup-status");
    expect(emitted(emit, "contact.suppressed")).toEqual([expect.objectContaining({ key: "suppress:grace@globex.test:bounced", scope: "all" })]);
    expect(emitted(emit, "deal.won")).toEqual([]);
  });
});

describe("deleting a company", () => {
  it("only a person can; people and deals stay; every module is told", async () => {
    const { harness, store, emit } = await boot();
    await expect(harness.performAction("crm.delete-company", { companyRecordId: "acme", confirm: "Acme Plumbing" }, { companyId: CO, actor: { type: "agent", agentId: "a1" } as never })).rejects.toThrow(/Only a board user/);
    await expect(harness.performAction("crm.delete-company", { companyRecordId: "acme", confirm: "Acme" }, { companyId: CO, actor: BOARD })).rejects.toThrow(/Confirm the delete/);
    const out = await harness.performAction<Record<string, unknown>>("crm.delete-company", { companyRecordId: "acme", confirm: "Acme Plumbing" }, { companyId: CO, actor: BOARD });
    expect(out).toMatchObject({ deleted: true, id: "acme", people: 1, deals: 1 });
    expect(store.companies!.map((c) => c.id)).toEqual(["globex", "foreign"]);
    expect(store.contacts!.map((c) => c.id)).toContain("ada");
    expect(store.contact_companies!.map((l) => l.account_id)).toEqual(["globex"]);
    expect(store.deals!.find((d) => d.id === "d-acme")).toMatchObject({ account_id: null, contact_id: "ada" });
    expect(emitted(emit, "company.deleted")).toEqual([expect.objectContaining({ id: "acme", key: "company:acme:deleted" })]);
    // Ada is touched so the next share carries her without the link.
    expect(store.contacts!.find((c) => c.id === "ada")!.updated_at).not.toBe("2026-01-01T00:00:00Z");
  });
});

describe("lifecycle churned", () => {
  it("stops the running sequences of a churned company's people and of a churned contact", async () => {
    const store = seed();
    store.enrollments = [
      { id: "e1", company_id: CO, sequence_id: "seq-intro", contact_id: "ada", status: "running", step_position: 1, next_due_at: null, open_issue_id: null, sending_key: null, created_at: "x" },
      { id: "e2", company_id: CO, sequence_id: "seq-intro", contact_id: "solo", status: "running", step_position: 1, next_due_at: null, open_issue_id: null, sending_key: null, created_at: "x" },
    ];
    const { harness } = await boot({ store });
    await tool(harness, "update-company", { companyRecordId: "company:acme", lifecycle: "churned" });
    expect(store.enrollments!.find((e) => e.id === "e1")!.status).toBe("stopped");
    expect(store.enrollments!.find((e) => e.id === "e2")!.status).toBe("running");
    await tool(harness, "update-contact", { contactId: "solo", lifecycle: "churned" });
    expect(store.enrollments!.find((e) => e.id === "e2")!.status).toBe("stopped");
  });
});

describe("sequence steps", () => {
  const due = (extra: Record<string, unknown> = {}) => ({ id: "e1", company_id: CO, sequence_id: "seq-intro", contact_id: "ada", status: "running", step_position: 1, next_due_at: ago(5), open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null, created_at: "x", ...extra });

  it("a due step's issue goes to the Account Manager with the personalised step and how it completes", async () => {
    const store = seed();
    store.enrollments = [due()];
    const { harness } = await boot({ store });
    await setRoles(harness, { team: { "account-manager": { agentId: "am-1", status: "idle" } } });
    await harness.runJob("open-due-steps");
    const [issue] = await crmIssues(harness);
    expect(issue).toMatchObject({ title: "Say hello: Ada Lovelace", assigneeAgentId: "am-1", originId: "crm:step:e1:1" });
    expect(issue!.description).toContain('Sequence "Intro", step 1 of 2, for `contact:ada` (Ada Lovelace).');
    expect(issue!.description).toContain("Call Ada");
    expect(issue!.description).toContain("Mark this issue done when the step is done: that moves the contact to the next step.");
    expect(issue!.description).toContain("**Done when** the step is logged on them");

    // Once the step is logged, the agent's close moves the contact on (the issue opened an hour ago).
    await tool(harness, "log-activity", { recordType: "contact", recordId: "ada", kind: "call", body: "Called Ada; she will read the proposal." });
    harness.seed({ issues: [{ ...issue!, status: "done", createdAt: new Date(Date.parse(ago(60))) }] });
    await harness.emit("issue.updated", {}, { companyId: CO, entityId: issue!.id, actorType: "agent", actorId: "am-1" });
    expect(store.enrollments![0]).toMatchObject({ step_position: 2, open_issue_id: null });
  });

  it("with no agent at all, the owner gets it: nothing is left unassigned", async () => {
    const store = seed();
    store.enrollments = [due()];
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-peet" });
    await harness.runJob("open-due-steps");
    expect((await crmIssues(harness))[0]).toMatchObject({ assigneeUserId: "user-peet" });
  });

  it("a sent-mode step's issue also moves on when done (complete-step is gone)", async () => {
    const store = seed();
    store.sequences![0]!.completion_mode = "sent";
    store.enrollments = [due()];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    const [issue] = await crmIssues(harness);
    expect(issue!.description).toContain("Mark this issue done only once the message has really been sent");
    harness.seed({ issues: [{ ...issue!, status: "done" }] });
    await harness.emit("issue.updated", {}, { companyId: CO, entityId: issue!.id, actorType: "user", actorId: "user-peet" });
    expect(store.enrollments![0]!.step_position).toBe(2);
    await expect(toolRaw(harness, "complete-step", { enrollmentId: "e1" })).rejects.toThrow(/No tool handler registered for 'complete-step'/);
  });

  it("an email step waiting for approval asks again when its approval issue is gone", async () => {
    const store = seed();
    store.sequences![0] = { ...store.sequences![0]!, delivery: "email", email_approval_issue_id: "gone", email_approved_at: null };
    store.enrollments = [due()];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    const issues = await crmIssues(harness);
    expect(issues.map((i) => i.title)).toEqual(["Approve email sending: Intro"]);
    expect(store.sequences![0]!.email_approval_issue_id).toBe(issues[0]!.id);
    // A second run does not ask twice.
    await harness.runJob("open-due-steps");
    expect(await crmIssues(harness)).toHaveLength(1);
  });
});
