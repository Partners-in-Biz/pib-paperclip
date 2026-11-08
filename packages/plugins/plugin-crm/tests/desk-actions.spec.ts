/**
 * The sales desk's worker side on the fake namespace: the queue action, the
 * agent tools (call-list, set-next-action, log-outcome) and Give to agent.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { boot, BOARD, CO, contact, seed, tool, toolRaw, type Harness } from "./helpers/crm.js";
import { CRM_TOOLS } from "../src/tools.js";
import { HANDOFF_DATA_HEADING } from "@partnersinbiz/pib-plugin-kit/handoff";

const DAY = 86_400_000;
const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY).toISOString();

describe("the sales desk", () => {
  let harness: Harness;
  let store: ReturnType<typeof seed>;

  beforeEach(async () => {
    store = seed();
    store.contacts.push(
      contact("kay", "Kay Overdue", { emails: ["kay@x.test"], phones: ["+27 82 000 0001"], next_action_kind: "call", next_action_due_at: iso(-3), tags: ["lead-batch-2026-11-02-b"] }),
      contact("lee", "Lee Later", { emails: ["lee@x.test"], next_action_kind: "email", next_action_due_at: iso(10) }),
    );
    store.activities.push({ id: "b1", company_id: CO, record_type: "contact", record_id: "kay", kind: "brief", body: "Say KAY. Site returns 522. Offer the roadmap at R35,000.", issue_id: null, created_at: iso(-0.5), meta: null, source_key: null });
    ({ harness } = await boot({ store }));
  });

  it("declares the three desk tools", () => {
    const names = CRM_TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["call-list", "set-next-action", "log-outcome"]));
  });

  it("crm.desk lists what is due, with the brief, and counts it", async () => {
    const view = await harness.performAction<{ items: Array<Record<string, unknown>>; counts: Record<string, number>; batches: Array<Record<string, unknown>> }>("crm.desk", {}, { companyId: CO, actor: BOARD });
    expect(view.counts).toMatchObject({ overdue: 1, later: 1, now: 1 });
    const kay = view.items.find((item) => item.key === "contact:kay")!;
    expect(kay).toMatchObject({ bucket: "overdue", phone: "+27 82 000 0001", email: "kay@x.test", kind: "call" });
    expect((kay.brief as { body: string }).body).toContain("Say KAY");
    expect(view.batches).toEqual([{ tag: "lead-batch-2026-11-02-b", contacts: 1, called: 0, replied: 0, deals: 0, overdue: 1 }]);
  });

  it("call-list (agent) returns the due rows with phone, brief and link", async () => {
    const out = await tool<{ items: Array<Record<string, unknown>>; total: number; deskLink: string }>(harness, "call-list", {});
    expect(out.total).toBe(1);
    expect(out.items[0]).toMatchObject({ ref: "contact:kay", phone: "+27 82 000 0001", nextAction: "call", bucket: "overdue" });
    expect((out.items[0]!.brief as { text: string }).text).toContain("R35,000");
    expect(String(out.items[0]!.link)).toContain("/crm?client=contact%3Akay");
    const all = await tool<{ total: number }>(harness, "call-list", { scope: "all" });
    expect(all.total).toBe(2);
  });

  it("set-next-action puts a lead on the desk with its brief, kept whole", async () => {
    const brief = `Ada Lovelace, Acme Plumbing, Cape Town. ${"Talking point. ".repeat(60)}`;
    const out = await tool<Record<string, unknown>>(harness, "set-next-action", { recordType: "contact", recordId: "contact:ada", kind: "call", inDays: 0, brief, issueId: "PAR-1" });
    expect(out.nextActionKind).toBe("call");
    expect(out.briefId).toBeTruthy();
    const row = store.contacts.find((c) => c.id === "ada")!;
    expect(row.next_action_kind).toBe("call");
    expect(Math.abs(Date.parse(String(row.next_action_due_at)) - Date.now())).toBeLessThan(DAY);
    const stored = store.activities.find((a) => a.record_id === "ada" && a.kind === "brief")!;
    expect(stored.body).toBe(brief.trim());
    expect(stored.issue_id).toBe("PAR-1");
    const view = await tool<{ items: Array<Record<string, unknown>> }>(harness, "call-list", {});
    expect(view.items.map((i) => i.ref)).toContain("contact:ada");
  });

  it("set-next-action kind none clears it; a bad kind is refused", async () => {
    await tool(harness, "set-next-action", { recordType: "contact", recordId: "kay", kind: "none" });
    expect(store.contacts.find((c) => c.id === "kay")!.next_action_kind).toBeNull();
    const bad = await toolRaw(harness, "set-next-action", { recordType: "contact", recordId: "kay", kind: "fax" });
    expect(bad.error).toMatch(/Next action/i);
  });

  it("log-outcome writes the timeline line and the outcome's usual next step", async () => {
    const out = await tool<Record<string, unknown>>(harness, "log-outcome", { recordType: "contact", recordId: "kay", channel: "call", outcome: "no_answer", note: "rang twice" });
    expect(out).toMatchObject({ outcome: "no_answer", nextActionKind: "call" });
    const row = store.contacts.find((c) => c.id === "kay")!;
    expect(row.next_action_kind).toBe("call");
    expect(Date.parse(String(row.next_action_due_at))).toBeGreaterThan(Date.now());
    const logged = store.activities.find((a) => a.record_id === "kay" && a.kind === "call")!;
    expect(logged.body).toBe("No answer · rang twice");
    expect((logged.meta as Record<string, unknown>).outcome).toBe("no_answer");
  });

  it("log-outcome from the page takes an explicit next step and a lifecycle move", async () => {
    await harness.performAction("crm.log-outcome", { recordType: "contact", recordId: "kay", channel: "call", outcome: "not_interested", nextActionKind: "none", lifecycle: "churned" }, { companyId: CO, actor: BOARD });
    const row = store.contacts.find((c) => c.id === "kay")!;
    expect(row.next_action_kind).toBeNull();
    expect(row.lifecycle).toBe("churned");
  });

  it("log-outcome on a deal also sets its contact's next step", async () => {
    await tool(harness, "log-outcome", { recordType: "deal", recordId: "d-acme", outcome: "reached", nextActionKind: "email", nextActionDueAt: "2026-12-01" });
    expect(store.deals.find((d) => d.id === "d-acme")!.next_action_kind).toBe("email");
    expect(store.contacts.find((c) => c.id === "ada")!.next_action_kind).toBe("email");
    expect(store.activities.find((a) => a.record_type === "deal" && a.record_id === "d-acme")!.body).toBe("Spoke to them");
  });

  it("refuses an unknown outcome or record type", async () => {
    expect((await toolRaw(harness, "log-outcome", { recordType: "contact", recordId: "kay", outcome: "maybe" })).error).toMatch(/outcome/);
    expect((await toolRaw(harness, "log-outcome", { recordType: "company", recordId: "acme", outcome: "reached" })).error).toMatch(/contact or deal/);
  });

  describe("give to agent", () => {
    it("prepare builds the popup from the record, as received data, with the CRM link", async () => {
      const out = await harness.performAction<{ title: string; description: string; projectId?: string; link: string }>("crm.give-prepare", { recordType: "contact", recordId: "kay" }, { companyId: CO, actor: BOARD });
      expect(out.title).toBe("CRM: Kay Overdue");
      expect(out.description).toContain(HANDOFF_DATA_HEADING);
      expect(out.description).toContain("contact:kay");
      expect(out.description).toContain("+27 82 000 0001");
      expect(out.description).toContain("Say KAY");
      expect(out.description).toContain("set-next-action");
      expect(out.projectId).toBeUndefined();
      expect(out.link).toContain("client=contact%3Akay");
    });

    it("prepare on a deal names the stage, value, company and contact", async () => {
      const out = await harness.performAction<{ title: string; description: string }>("crm.give-prepare", { recordType: "deal", recordId: "d-acme" }, { companyId: CO, actor: BOARD });
      expect(out.title).toBe("Deal: Acme SEO retainer");
      expect(out.description).toContain("Proposal (open)");
      expect(out.description).toMatch(/Value: `ZAR 1[ ,\u00a0\u202f]000[.,]00`/);
      expect(out.description).toContain("Acme Plumbing");
      expect(out.description).toContain("deal:d-acme");
    });

    it("record links the created task on the timeline and warns when no agent is assigned", async () => {
      const prepared = await harness.performAction<{ description: string }>("crm.give-prepare", { recordType: "company", recordId: "acme" }, { companyId: CO, actor: BOARD });
      const issue = await harness.ctx.issues.create({ companyId: CO, title: "CRM: Acme Plumbing", description: prepared.description, status: "todo" } as never) as { id: string };
      const out = await harness.performAction<{ message: string; warning: string | null }>("crm.give-record", { recordType: "company", recordId: "acme", issueId: issue.id }, { companyId: CO, actor: BOARD });
      expect(out.message).toMatch(/^Given: /);
      expect(out.warning).toMatch(/No agent is assigned/);
      const logged = store.activities.find((a) => a.kind === "given" && a.record_id === "acme")!;
      expect(logged.issue_id).toBe(issue.id);
      expect(logged.body).toMatch(/^Given to an agent: /);
    });

    it("record refuses a task that is not this record's hand-off, and an agent caller", async () => {
      const issue = await harness.ctx.issues.create({ companyId: CO, title: "Something else", description: "no ref here", status: "todo" } as never) as { id: string };
      await expect(harness.performAction("crm.give-record", { recordType: "company", recordId: "acme", issueId: issue.id }, { companyId: CO, actor: BOARD })).rejects.toThrow(/isn't a hand-off/);
      await expect(harness.performAction("crm.give-prepare", { recordType: "company", recordId: "acme" }, { companyId: CO, actor: { type: "agent", agentId: "agent-1" } as never })).rejects.toThrow();
    });
  });
});
