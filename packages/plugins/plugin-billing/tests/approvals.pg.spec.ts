/**
 * Billing's approvals cannot end unassigned (audit Q5-6): every one goes through the kit's `openApprovalIssue`.
 * What went wrong live: every plugin's copy of the Cockpit's roles was frozen on its first broadcast (no owner, no
 * Reviewer), so an approval opened by an agent had nobody to go to. Here the same frozen copy is held, and the
 * issue still reaches a person, the Reviewer comes first only for work that leaves the company, and a person
 * Billing's settings name wins over the owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessCompanyScope, accessGrantScope, forgetCompanyDefaultOwner } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";
import { openBillingApproval, configuredApprover } from "../src/approvals.js";
import { agentContext, COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const ROLES = "plugin.partnersinbiz.cockpit.roles.updated";
const RUN = { agentId: "agent-am", runId: "run-1", companyId: COMPANY, projectId: "p" };

describe("configuredApprover", () => {
  it("is the person Billing's settings name, never the board sentinel or a blank", () => {
    expect(configuredApprover({ reviewerUserId: " user-9 " })).toBe("user-9");
    expect(configuredApprover({ reviewerUserId: "local-board" })).toBeNull();
    expect(configuredApprover({ reviewerUserId: "  " })).toBeNull();
    expect(configuredApprover({})).toBeNull();
  });
});

describe.skipIf(!available)("billing approvals (postgres)", () => {
  let h: Harness;
  let warnings: string[];

  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
    (h.ctx.logger as unknown as { warn: (m: string) => void }).warn = (message: string) => void warnings.push(message);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
    warnings = [];
    for (const key of [...h.state.keys()]) if (/:pib-(setup|cockpit|cockpit-jobs|kit):/.test(key)) h.state.delete(key);
    forgetCompanyDefaultOwner(h.ctx);
    (h.ctx.companies as unknown as { get: (id: string) => Promise<unknown> }).get = async (id: string) => ({ id, name: "Partners in Biz", issuePrefix: "PIB" });
    h.config.set(COMPANY, { ...SETTINGS });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
  });

  const roles = (over: Record<string, unknown> = {}) =>
    h.deliver(ROLES, COMPANY, { companyId: COMPANY, operatorAgentId: null, reviewerAgentId: null, reviewOutward: false, ownerUserId: "owner-1", team: {}, updatedAt: new Date().toISOString(), ...over });
  const tool = async (name: string, params: Record<string, unknown>) => (await h.tools.get(name)!(params, RUN)) as { data: Record<string, any>; error?: string };

  async function sendRequest() {
    const invoice = (await tool("create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" })).data as { id: string };
    await tool("add-line", { invoiceId: invoice.id, description: "Retainer", quantity: 1, unitAmountMinor: 100_000 });
    return h.issues.get((await tool("request-invoice-send", { invoiceId: invoice.id })).data.issueId)!;
  }

  async function paidInvoice() {
    const invoice = (await tool("create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" })).data as { id: string };
    await tool("add-line", { invoiceId: invoice.id, description: "Retainer", quantity: 1, unitAmountMinor: 100_000 });
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    return invoice;
  }

  it("records the person whose click asked as the task's creator, and nobody for an agent", async () => {
    await roles({});
    const base = { companyId: COMPANY, title: "Send invoice", description: "d", client: null, originId: "invoice-send:i1", outward: true };
    const byPerson = await openBillingApproval(h.ctx, { ...SETTINGS } as never, { ...base, actorUserId: "user-1" });
    expect(h.issues.get(byPerson.id)!.actor).toEqual({ actorUserId: "user-1" });
    const byAgent = await openBillingApproval(h.ctx, { ...SETTINGS } as never, { ...base, actorUserId: null });
    expect(h.issues.get(byAgent.id)!.actor).toBeNull();
  });

  it("the frozen roles copy (no owner, no Reviewer) still reaches the host's default owner: the live failure, fixed", async () => {
    await roles({ ownerUserId: null });
    (h.ctx.companies as unknown as { get: (id: string) => Promise<unknown> }).get = async (id: string) => ({ id, name: "PiB", issuePrefix: "PIB", defaultResponsibleUserId: "owner-default" });
    const issue = await sendRequest();
    expect(issue).toMatchObject({ assigneeUserId: "owner-default", assigneeAgentId: null });
    expect(issue.description).not.toContain("Unrouted");
  });

  it("with no roles copy at all and no default owner it opens unassigned, says why, and logs it", async () => {
    const issue = await sendRequest();
    expect(issue.assigneeUserId).toBeNull();
    expect(issue.assigneeAgentId).toBeNull();
    expect(issue.description).toContain("**Unrouted");
    expect(warnings).toContain("Approval opened without a person to decide it");
  });

  it("with only an Operator it goes to the Operator, told to ask the owner", async () => {
    await roles({ ownerUserId: null, operatorAgentId: "agent-op", operatorStatus: "idle" });
    const issue = await sendRequest();
    expect(issue.assigneeAgentId).toBe("agent-op");
    expect(issue.description).toContain("partnersinbiz.cockpit:ask-owner");
  });

  it("an invoice send goes to the Reviewer first, who hands it to the person Billing's settings name", async () => {
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9" });
    await roles({ reviewerAgentId: "agent-rev", reviewerStatus: "idle", reviewOutward: true });
    const issue = await sendRequest();
    expect(issue.assigneeAgentId).toBe("agent-rev");
    expect(issue.description).toContain("## Reviewer: check before the person approves");
    expect(issue.description).toContain("user user-9");
    expect(issue.description).not.toContain("owner-1");
  });

  it("a configured approver gets the issue directly when there is no Reviewer, and wins over the owner", async () => {
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9" });
    await roles({});
    expect(await sendRequest()).toMatchObject({ assigneeUserId: "user-9", assigneeAgentId: null });
    h.config.set(COMPANY, { ...SETTINGS });
    expect(await sendRequest()).toMatchObject({ assigneeUserId: "owner-1" });
  });

  it("money decisions are never the Reviewer's, even when the Reviewer is running: a person decides", async () => {
    await roles({ reviewerAgentId: "agent-rev", reviewerStatus: "idle", reviewOutward: true });
    const invoice = await paidInvoice();
    const payment = h.issues.get((await tool("record-payment", { invoiceId: invoice.id, amountMinor: 115_000, paymentKey: "bank-1" })).data.issueId)!;
    expect(payment).toMatchObject({ assigneeUserId: "owner-1", assigneeAgentId: null });
    const credit = h.issues.get((await tool("create-credit-note", { invoiceId: invoice.id, amountMinor: 5_000, reason: "Discount" })).data.issueId)!;
    expect(credit).toMatchObject({ assigneeUserId: "owner-1", assigneeAgentId: null });
    const check = h.issues.get((await tool("request-payment-check", { invoiceId: invoice.id, note: "Customer says paid on WhatsApp" })).data.issueId)!;
    expect(check).toMatchObject({ assigneeUserId: "owner-1", assigneeAgentId: null });
  });

  it("a person who asks from the page is the last resort approver", async () => {
    const invoice = await paidInvoice();
    const asked = await h.call<{ issueId: string }>("billing.request-pay", { invoiceId: invoice.id }, userContext());
    expect(h.issues.get(asked.issueId)).toMatchObject({ assigneeUserId: "user-1" });
  });

  it("when the host refuses the configured person, the company's approver gets it instead of nobody", async () => {
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-left" });
    await roles({});
    const original = h.ctx.issues.create;
    (h.ctx.issues as unknown as { create: (input: Record<string, unknown>) => Promise<unknown> }).create = async (input) => {
      if (input.assigneeUserId === "user-left") throw new Error("User is not an active company member");
      return original(input as never);
    };
    try {
      expect(await sendRequest()).toMatchObject({ assigneeUserId: "owner-1" });
    } finally {
      (h.ctx.issues as unknown as { create: unknown }).create = original;
    }
  });

  it("openBillingApproval reports who it went to and whether the Reviewer holds it", async () => {
    await roles({ reviewerAgentId: "agent-rev", reviewerStatus: "idle", reviewOutward: true });
    const first = await openBillingApproval(h.ctx, { ...SETTINGS }, { companyId: COMPANY, title: "Approve X", description: "d", originId: "billing:test:1", outward: true, brief: (approver) => `hand to ${approver}` });
    expect(first).toMatchObject({ assignedTo: "reviewer", reviewer: true, approver: "owner-1" });
    expect(h.issues.get(first.id)!.description).toContain("hand to owner-1");
    const second = await openBillingApproval(h.ctx, { ...SETTINGS }, { companyId: COMPANY, title: "Decide Y", description: "d", originId: "billing:test:2", outward: false });
    expect(second).toMatchObject({ assignedTo: "person", reviewer: false });
  });

  it("an agent's tool call opens the same approval as a page click (the context the live failure showed)", async () => {
    await roles({});
    const viaTool = await sendRequest();
    expect(viaTool.assigneeUserId).toBe("owner-1");
    const invoice = (await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" }, userContext()));
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "Retainer", quantity: 1, unitAmountMinor: 100_000 }, userContext());
    const viaPage = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id }, agentContext());
    expect(h.issues.get(viaPage.issueId)!.assigneeUserId).toBe("owner-1");
  });
  it("opens the send approval in the client's own project, so the Reviewer's billing reads work", async () => {
    await roles({});
    await h.deliver("plugin.partnersinbiz.crm.client.projects.updated", COMPANY, { clientKind: "contact", clientRef: "ct-lumen", projectIds: ["proj-lumen"], updatedAt: new Date().toISOString() });
    const issue = await sendRequest();
    expect((issue as { projectId?: string }).projectId).toBe("proj-lumen");
  });

  it("a client with no linked project still gets its approval (no project, as before)", async () => {
    await roles({});
    const issue = await sendRequest();
    expect((issue as { projectId?: string }).projectId ?? null).toBeNull();
  });

  it("stage B-D7 pin: on enforce, a client managed by a limited member still goes to today's approver (Billing is a hard stop)", async () => {
    // Peet 2026-11-17: invoices, quotes, payments, credit and prices stay with him even on a limited person's own companies.
    // Billing never asks the CRM who manages a client for an approval; when B-4 adds managers to the copy, seed Jan there too.
    await roles({ reviewerAgentId: "agent-rev", reviewerStatus: "idle", reviewOutward: true });
    await h.ctx.state.set(accessCompanyScope(COMPANY), { mode: "enforce", rev: 1, userIds: [], receivedAt: new Date().toISOString() });
    await h.ctx.state.set(accessGrantScope(COMPANY, "user-jan"), { preset: "clientManager" });
    const ctx = h.ctx as unknown as { access?: unknown };
    const access = ctx.access;
    ctx.access = { members: { list: async () => [
      { principalType: "user", principalId: "owner-1", status: "active", membershipRole: "owner" },
      { principalType: "user", principalId: "user-jan", status: "active", membershipRole: "member" },
    ] } };
    try {
      const client = { kind: "contact" as const, id: "ct-lumen" };
      const base = { companyId: COMPANY, description: "d", client, actorUserId: "user-jan" };
      // Money decisions: a person decides, and that person is the owner, not the client's manager.
      for (const originId of ["payment:p1", "credit-note:c1", "payment-check:i1"]) {
        const money = await openBillingApproval(h.ctx, { ...SETTINGS } as never, { ...base, title: "Approve", originId, outward: false });
        expect(h.issues.get(money.id)).toMatchObject({ assigneeUserId: "owner-1", assigneeAgentId: null });
        expect(money.approver).toBe("owner-1");
      }
      // Sends: the Reviewer first, handing on to the owner.
      const send = await openBillingApproval(h.ctx, { ...SETTINGS } as never, { ...base, title: "Send invoice", originId: "invoice-send:i1", outward: true });
      expect(send).toMatchObject({ reviewer: true, approver: "owner-1" });
      // Billing's own configured approver still wins.
      const configured = await openBillingApproval(h.ctx, { ...SETTINGS, reviewerUserId: "user-9" } as never, { ...base, title: "Approve", originId: "payment:p2", outward: false });
      expect(h.issues.get(configured.id)).toMatchObject({ assigneeUserId: "user-9" });
    } finally {
      ctx.access = access;
    }
  });
});
