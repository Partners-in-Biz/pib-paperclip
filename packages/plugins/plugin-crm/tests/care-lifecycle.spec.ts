import { describe, expect, it } from "vitest";
import { settleStuckMessages } from "../src/care-approvals.js";
import { clientInfo } from "../src/care-clients.js";
import { approvalsByStatus } from "../src/care-store.js";
import { runActionReminders } from "../src/client-actions.js";
import { runHealthScores } from "../src/health-score.js";
import { runSiteMonitor } from "../src/monitor.js";
import { repairApprovalIssues } from "../src/outbound.js";
import { executeApprovedErasure, privacyHealth } from "../src/privacy.js";
import { runMonthlyReports } from "../src/report.js";
import { runSupportSla } from "../src/support.js";
import { setupStatus } from "../src/setup-status.js";
import { REGISTER } from "../src/register.js";
import { BOARD, bootCare, careSeed, CO, company, contact, decide, MAILBOX, OWNER, tool, toolRaw, type Booted } from "./helpers/care.js";

const NOW = new Date().toISOString();
const item = (status: Awaited<ReturnType<typeof setupStatus>>, key: string) => status.items.find((row) => row.key === key)!;

describe("the Setup checklist lines", () => {
  it("monthly reports: optional with no customers, missing without the Account Manager, blocked without the Mailbox, done with both", async () => {
    const none = await bootCare({ store: { ...careSeed(), companies: [], contacts: [], contact_companies: [] } });
    // The Account Manager is linked by bootCare; with no customers the line is optional.
    expect(item(await setupStatus(none.harness.ctx, CO), "client-reports")).toMatchObject({ status: "optional", required: false });

    const store = careSeed();
    const mailboxOff = await bootCare({ store });
    await mailboxOff.harness.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "pib-setup", stateKey: "modules" }, { companyId: CO, modules: { mailbox: false }, updatedAt: NOW });
    const blocked = item(await setupStatus(mailboxOff.harness.ctx, CO), "client-reports");
    expect(blocked).toMatchObject({ status: "blocked", blockedBy: ["mailbox"], required: false });
    expect(blocked.detail).toMatch(/Mailbox/);

    const ready = await bootCare({ store: careSeed() });
    const done = item(await setupStatus(ready.harness.ctx, CO), "client-reports");
    expect(done).toMatchObject({ status: "done", required: false });
    expect(done.detail).toMatch(/2 customers get a report on the 1st at 06:00/);
    expect(done.agentNext).toMatch(/approve each email with one click/);
  });

  it("without the Account Manager nobody writes the report", async () => {
    const { harness } = await bootCare({ store: careSeed() });
    await harness.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "pib-hire", stateKey: "role:account-manager" }, null);
    harness.seed({ agents: [] });
    const status = await setupStatus(harness.ctx, CO);
    if (item(status, "agent").status !== "done") {
      expect(item(status, "client-reports")).toMatchObject({ status: "missing", blockedBy: ["agent"] });
      expect(item(status, "client-reports").detail).toMatch(/nobody writes it/);
    }
  });

  it("website monitoring counts the sites and the ones down; the register line counts what is unverified", async () => {
    const store = careSeed({
      client_sites: [{ id: "s1", company_id: CO, client_kind: "company", client_ref: "acme", url: "https://acme.co.za/", created_at: NOW }, { id: "s2", company_id: CO, client_kind: "company", client_ref: "acme", url: "https://shop.acme.co.za/", created_at: NOW }],
      site_monitor: [{ site_id: "s1", company_id: CO, enabled: true, status: "down" }, { site_id: "s2", company_id: CO, enabled: true, status: "up" }],
    });
    const { harness } = await bootCare({ store });
    const status = await setupStatus(harness.ctx, CO);
    expect(item(status, "site-monitoring")).toMatchObject({ status: "done", required: false });
    expect(item(status, "site-monitoring").detail).toMatch(/2 client websites watched.*1 site down now/);
    const unverified = REGISTER.rows.filter((row) => /^unverified/i.test(row.agreement)).length;
    const register = item(status, "data-processing");
    expect(register).toMatchObject({ status: "optional", required: false });
    expect(register.detail).toContain(`${unverified} of ${REGISTER.rows.length} systems`);
    expect(register.steps!.join(" ")).toMatch(/list-data-processing/);
    const empty = await bootCare({ store: careSeed() });
    expect(item(await setupStatus(empty.harness.ctx, CO), "site-monitoring")).toMatchObject({ status: "optional" });
  });

  it("website monitoring says plainly when a domain has no expiry date (the registry lookup has none for .co.za), and stops saying it once the date is set", async () => {
    const store = careSeed({
      client_sites: [{ id: "s1", company_id: CO, client_kind: "company", client_ref: "acme", url: "https://acme.co.za/", created_at: NOW }, { id: "s2", company_id: CO, client_kind: "company", client_ref: "acme", url: "https://shop.acme.co.za/", created_at: NOW }],
      site_monitor: [
        { site_id: "s1", company_id: CO, enabled: true, status: "up", domain_expires_at: null, domain_error: "The public registry lookup (rdap.org) has no data for .co.za domains", domain_manual: false },
        { site_id: "s2", company_id: CO, enabled: true, status: "up", domain_expires_at: "2027-03-31T00:00:00.000Z", domain_error: null, domain_manual: true },
      ],
    });
    const { harness } = await bootCare({ store });
    const line = item(await setupStatus(harness.ctx, CO), "site-monitoring");
    expect(line.detail).toMatch(/1 site has no domain expiry date.*\.co\.za is one.*set-site-monitoring/);
    expect(line.steps!.join(" ")).toMatch(/domainExpiresAt/);
    store.site_monitor![0]!.domain_manual = true;
    store.site_monitor![0]!.domain_expires_at = "2027-05-01T00:00:00.000Z";
    const after = item(await setupStatus(harness.ctx, CO), "site-monitoring");
    expect(after.detail).not.toMatch(/no domain expiry date/);
    expect(after.steps).toBeUndefined();
  });
});

async function seedCare(booted: Booted) {
  const { harness } = booted;
  await tool(harness, "open-support-case", { client: "company:acme", title: "Printer", source: "portal" });
  const action = await tool<Record<string, any>>(harness, "create-client-action", { client: "company:acme", kind: "info", title: "Send your logo" });
  await tool(harness, "build-client-report", { client: "company:acme", period: new Date().toISOString().slice(0, 7) });
  await tool(harness, "record-client-signal", { client: "company:acme", module: "seo", health: { score: 40 } });
  await tool(harness, "record-feedback", { client: "company:acme", kind: "nps", score: 9 });
  await tool(harness, "set-client-sensitivity", { client: "company:acme", level: "sensitive", reason: "Acme is a clinic: patient names are in the leads." });
  await harness.runJob("client-health");
  return action;
}

const CARE_TABLES = ["support_cases", "client_actions", "client_reports", "client_signals", "client_feedback", "client_sensitivity", "client_health", "care_approvals"] as const;

describe("a client's care data goes with the client", () => {
  it("deleting the company removes every care table's rows for it and leaves the others", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    await seedCare(booted);
    // Another client's care rows stay.
    await tool(harness, "open-support-case", { client: "contact:solo", title: "Solo case", source: "portal" });
    await tool(harness, "record-client-signal", { client: "contact:solo", module: "billing", health: { overdueCount: 1 } });
    for (const table of CARE_TABLES) expect((store[table] ?? []).length, table).toBeGreaterThan(0);
    await harness.performAction("crm.delete-company", { companyRecordId: "acme", confirm: true }, { companyId: CO, actor: BOARD });
    for (const table of CARE_TABLES) {
      const rows = (store[table] ?? []) as Array<Record<string, any>>;
      expect(rows.filter((row) => row.client_kind === "company" && row.client_ref === "acme"), table).toEqual([]);
    }
    expect(store.support_cases!.map((row) => row.client_ref)).toEqual(["solo"]);
    expect(store.client_signals!.map((row) => row.client_ref)).toEqual(["solo"]);
  });

  it("cleaning up the canary removes the canary's care data, and only that", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    const canary = await tool<Record<string, any>>(harness, "create-canary-client", {});
    await tool(harness, "open-support-case", { client: canary.client, title: "Canary case", source: "portal" });
    await tool(harness, "open-support-case", { client: "company:acme", title: "Real case", source: "portal" });
    await tool(harness, "record-client-signal", { client: canary.client, module: "seo", note: "canary numbers" });
    await tool(harness, "cleanup-canary", { confirm: true });
    expect(store.support_cases!.map((row) => row.title)).toEqual(["Real case"]);
    expect(store.client_signals ?? []).toHaveLength(0);
  });
});

describe("one company never sees another's care data", () => {
  it("a case, request, report or signal of another company is invisible, unchangeable and uncounted", async () => {
    const store = careSeed();
    const foreign = { company_id: "co-2", client_kind: "company", client_ref: "foreign", created_at: NOW };
    store.support_cases = [{ ...foreign, id: "fc1", title: "Foreign case", summary: "", source: "manual", severity: "urgent", status: "open", contact_id: null, thread_id: null, source_key: null, reply_issue_id: null, issue_id: null, first_response_due_at: "2020-01-01T00:00:00Z", resolution_due_at: "2020-01-02T00:00:00Z", first_response_at: null, resolved_at: null, first_breached_at: null, resolution_breached_at: null, escalated_at: null, paused_at: null, resolution: null, opened_by: null }];
    store.client_actions = [{ ...foreign, id: "fa1", kind: "info", title: "Foreign request", status: "waiting", remind_after_days: 3, reminders: 0, next_reminder_at: "2020-01-01T00:00:00Z", to_email: "x@foreign.test" }];
    store.client_reports = [{ ...foreign, id: "fr1", period: "2026-09", status: "built", narrative: {}, data: {}, markdown: "FOREIGN", html: "", built_at: NOW }];
    store.client_signals = [{ ...foreign, id: "fs1", module: "billing", period: "", payload: { health: { overdueCount: 9 } }, source: "event", signal_at: NOW, updated_at: NOW }];
    store.care_approvals = [{ id: "fap1", company_id: "co-2", kind: "client_action", client_kind: "company", client_ref: "foreign", subject_id: "fa1", seq: 1, issue_id: "foreign-issue", status: "open", payload: { draft: { to: [{ email: "x@foreign.test" }] } }, created_at: NOW }];
    store.site_monitor = [{ site_id: "fsite", company_id: "co-2", enabled: true, status: "down", down_since: "2020-01-01T00:00:00Z" }];
    const { harness } = await bootCare({ store });
    expect((await tool<Record<string, any>>(harness, "list-support-cases", { status: "all" })).count).toBe(0);
    expect((await tool<Record<string, any>>(harness, "list-client-actions", { status: "all" })).count).toBe(0);
    expect((await tool<Record<string, any>>(harness, "list-client-reports", {})).reports).toEqual([]);
    expect((await toolRaw(harness, "update-support-case", { caseId: "fc1", status: "resolved", resolution: "Trying to resolve it." })).error).toMatch(/not found/);
    expect((await toolRaw(harness, "update-client-action", { actionId: "fa1", status: "done" })).error).toMatch(/not found/);
    // The work done for this company never touches the other one's overdue rows (each job step takes the company by name).
    await runSupportSla(harness.ctx, CO);
    await runActionReminders(harness.ctx, CO);
    await runHealthScores(harness.ctx, CO);
    await runMonthlyReports(harness.ctx, CO);
    await repairApprovalIssues(harness.ctx, CO, await approvalsByStatus(harness.ctx, CO, "open"));
    await settleStuckMessages(harness.ctx, CO);
    await runSiteMonitor(harness.ctx, CO, { io: { page: async () => ({ ok: true, status: 200, ms: 1, error: null }), tls: async () => ({ expiresAt: null, error: null }), rdap: async () => ({ expiresAt: null, error: null }), sleep: async () => undefined } });
    expect(store.support_cases![0]).toMatchObject({ first_breached_at: null });
    expect(store.client_actions![0]).toMatchObject({ status: "waiting", reminders: 0 });
    expect(store.care_approvals!.length).toBe(1);
    expect(store.care_approvals![0]!.issue_id).toBe("foreign-issue");
    // A decision on the foreign approval's issue id does nothing here.
    await harness.emit("issue.updated", {}, { companyId: CO, entityId: "foreign-issue", actorType: "user", actorId: OWNER });
    expect(store.care_approvals![0]!.status).toBe("open");
    expect(store.site_monitor![0]).toMatchObject({ status: "down" });
  });

  it("a client of another company is not a client here: the care code finds nothing for its id, though the row exists", async () => {
    const store = careSeed();
    store.contacts = [...store.contacts!, { ...contact("outsider", "Outside Person", { emails: ["out@other.test"], lifecycle: "customer" }), company_id: "co-2" }];
    const { harness } = await bootCare({ store });
    expect(await clientInfo(harness.ctx, CO, { kind: "company", id: "foreign" })).toBeNull();
    expect(await clientInfo(harness.ctx, CO, { kind: "contact", id: "outsider" })).toBeNull();
    expect(await clientInfo(harness.ctx, "co-2", { kind: "company", id: "foreign" })).toMatchObject({ name: "Foreign Co" });
    expect(await clientInfo(harness.ctx, CO, { kind: "company", id: "acme" })).toMatchObject({ name: "Acme Plumbing", lifecycle: "customer" });
  });

  it("a send result that arrives for another company settles nothing here, the right one does", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "create-client-action", { client: "company:acme", kind: "info", title: "Send your logo" });
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    const key = `crm:msg:${booted.store.care_approvals![0]!.id}`;
    const result = { key, status: "sent", messageId: "gm-1", threadId: "gt-1", sentAt: NOW, context: { plugin: "partnersinbiz.crm", kind: "client_message", id: "x" } };
    await booted.harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, result, { companyId: "co-2" });
    expect(booted.store.care_approvals![0]!.status).toBe("approved");
    expect(booted.store.outbox![0]!.status).toBe("pending");
    expect(booted.store.client_actions![0]!.status).toBe("draft");
    await booted.harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, result, { companyId: CO });
    expect(booted.store.care_approvals![0]!.status).toBe("sent");
    expect(booted.store.client_actions![0]!.status).toBe("waiting");
  });
});

describe("a viewer sees only the clients they may see", () => {
  /** Two customers; "Mine" is assigned to agent-2, "Theirs" to nobody. agent-2 runs for no responsible person, so it has no workspace role. */
  async function twoClients() {
    const store = careSeed({
      companies: [
        company("mine", "Mine Plumbing", { lifecycle: "customer", assignee_agent_id: "agent-2" }),
        company("theirs", "Theirs Electrical", { lifecycle: "customer" }),
      ],
      contacts: [],
      contact_companies: [],
      heartbeat_runs: [
        { id: "run-1", company_id: CO, agent_id: "agent-1", responsible_user_id: "local-board" },
        { id: "run-2", company_id: CO, agent_id: "agent-2", responsible_user_id: null },
      ],
    });
    const booted = await bootCare({ store });
    for (const client of ["company:mine", "company:theirs"]) {
      await tool(booted.harness, "open-support-case", { client, title: `Case for ${client}`, source: "portal" });
      await tool(booted.harness, "build-client-report", { client, period: "2026-09" });
    }
    for (const ref of ["mine", "theirs"]) {
      store.client_actions = [...(store.client_actions ?? []), { id: `a-${ref}`, company_id: CO, client_kind: "company", client_ref: ref, kind: "info", title: `Request for ${ref}`, status: "waiting", remind_after_days: 3, reminders: 0, to_email: `x@${ref}.test`, created_at: NOW }];
    }
    await runHealthScores(booted.harness.ctx, CO);
    const asAgent2 = (name: string, params: Record<string, unknown> = {}) => booted.harness.executeTool<{ data?: Record<string, any>; error?: string }>(name, params, { companyId: CO, agentId: "agent-2", runId: "run-2" });
    return { booted, asAgent2 };
  }

  it("the owner's lists have both clients; an agent that holds one client sees only that one in every care list", async () => {
    const { booted, asAgent2 } = await twoClients();
    const { harness } = booted;
    expect((await tool<Record<string, any>>(harness, "list-support-cases", { status: "all" })).count).toBe(2);
    expect((await tool<Record<string, any>>(harness, "list-client-actions", { status: "all" })).count).toBe(2);
    expect((await tool<Record<string, any>>(harness, "list-client-reports", {})).reports).toHaveLength(2);
    expect((await tool<Record<string, any>>(harness, "client-health", {})).count).toBe(2);

    const cases = (await asAgent2("list-support-cases", { status: "all" })).data!;
    expect(cases.cases.map((c: any) => c.title)).toEqual(["Case for company:mine"]);
    const actions = (await asAgent2("list-client-actions", { status: "all" })).data!;
    expect(actions.actions.map((a: any) => a.title)).toEqual(["Request for mine"]);
    expect(actions.waitingOnClient).toBe(1);
    const reports = (await asAgent2("list-client-reports", {})).data!;
    expect(reports.reports.map((r: any) => r.client)).toEqual(["company:mine"]);
    const health = (await asAgent2("client-health", {})).data!;
    expect(health.clients.map((c: any) => c.client)).toEqual(["company:mine"]);
    expect(health.count).toBe(1);
  });

  it("naming a client the viewer cannot see is still refused", async () => {
    const { asAgent2 } = await twoClients();
    for (const name of ["list-support-cases", "list-client-actions", "list-client-reports", "client-health"]) {
      expect((await asAgent2(name, { client: "company:theirs" })).error, name).toMatch(/not found or is not visible/);
    }
  });
});

describe("erasing a person whose contact is already gone", () => {
  it("works from the address alone, and says nothing was found when nothing is left", async () => {
    const store = careSeed();
    store.consent_records = [{ id: "cr9", company_id: CO, sender_key: "own", subject_key: "email:gone@acme.co.za", email: "gone@acme.co.za", contact_id: null, purpose: "marketing_email", basis: "consent", granted: true, source: "form", wording: "Yes", form_id: null, url: null, policy_version: null, ip_hash: null, recorded_at: NOW, expires_at: null, recorded_by: "partnersinbiz.crm" }];
    const booted = await bootCare({ store });
    const approvalPayload = { request: { requestId: "er-x", subject: { email: "gone@acme.co.za", phone: null, contactId: "deleted-contact" }, scope: "all", reason: "data_subject_request", dueBy: NOW, evidence: "x", requestedBy: "agent:1", counts: {} } };
    const approval = { id: "ap1", companyId: CO, kind: "erasure" as const, client: null, subjectId: "er-x", seq: 1, issueId: null, status: "open" as const, payload: approvalPayload, sendKey: null, decidedBy: null, decidedAt: null, result: null, error: null, createdAt: NOW };
    const first = await executeApprovedErasure(booted.harness.ctx, approval, OWNER);
    expect(first.counts).toMatchObject({ consent_records: 1 });
    expect(first.announcedTo).toEqual(expect.arrayContaining(["partnersinbiz.mailbox"]));
    const second = await executeApprovedErasure(booted.harness.ctx, { ...approval, subjectId: "er-y", payload: { request: { ...approvalPayload.request, requestId: "er-y" } } }, OWNER);
    expect(second.counts).toEqual({});
    expect((await privacyHealth(booted.harness.ctx, CO)).some((check) => check.key === "privacy:consent-gaps")).toBe(true);
  });
});
