import { describe, expect, it } from "vitest";
import { careCompanies, careHealth, runClientCareJob, runClientHealthJob, runSiteMonitorJob } from "../src/care-jobs.js";
import { cockpitSnapshot } from "../src/cockpit.js";
import manifest from "../src/manifest.js";
import { CARE_TOOLS } from "../src/care-tools.js";
import { CARE_TOOL_NAMES } from "../src/care-dispatch.js";
import { CRM_TOOLS } from "../src/tools.js";
import { PLUGIN_VERSION } from "../src/namespace.js";
import { answerSend, BOARD, bootCare, careSeed, CO, decide, MAILBOX, tool } from "./helpers/care.js";

describe("what the plugin declares", () => {
  it("has the four care jobs on their schedules, and the capability and table the report needs", () => {
    const jobs = Object.fromEntries((manifest.jobs ?? []).map((job) => [job.jobKey, job.schedule]));
    expect(jobs["site-monitor"]).toBe("*/5 * * * *");
    expect(jobs["client-care"]).toBe("*/15 * * * *");
    // 05:20 SAST and 06:00 SAST on the 1st, in UTC.
    expect(jobs["client-health"]).toBe("20 3 * * *");
    expect(jobs["client-report-monthly"]).toBe("0 4 1 * *");
    expect(manifest.capabilities).toContain("issue.documents.write");
    expect(manifest.capabilities).toContain("http.outbound");
    expect(manifest.database?.coreReadTables).toEqual(expect.arrayContaining(["heartbeat_runs", "issues", "cost_events"]));
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(PLUGIN_VERSION).toBe("0.15.1");
  });

  it("declares each care tool once, with the tool surface the CRM already had, and every one runs as a tool and as a page action", async () => {
    const names = CARE_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...CARE_TOOL_NAMES].sort()).toEqual([...names].sort());
    const all = CRM_TOOLS.map((tool) => tool.name);
    expect(new Set(all).size).toBe(all.length);
    for (const name of names) expect(all, name).toContain(name);
    expect(names).toEqual(expect.arrayContaining(["build-client-report", "create-client-action", "open-support-case", "request-feedback", "client-health", "export-person-data", "request-erasure", "record-consent", "list-data-processing", "set-client-sensitivity", "site-monitoring"]));
    const { harness } = await bootCare();
    const viaAction = await harness.performAction<Record<string, any>>("crm.list-support-cases", {}, { companyId: CO, actor: BOARD });
    expect(viaAction).toMatchObject({ count: 0 });
    const viaTool = await tool<Record<string, any>>(harness, "list-support-cases", {});
    expect(viaTool).toEqual(viaAction);
  });
});

/** Only this company's records (the default seed also has another company's). */
function mine() {
  const store = careSeed();
  store.companies = store.companies!.filter((row) => row.company_id === CO);
  return store;
}

describe("the jobs act for the right companies", () => {
  it("only those whose settings are saved and whose CRM is switched on", async () => {
    const saved = await bootCare({ store: mine() });
    expect(await careCompanies(saved.harness.ctx)).toEqual([CO]);
    const unsaved = await bootCare({ store: mine(), config: {} });
    expect(await careCompanies(unsaved.harness.ctx)).toEqual([]);
    const off = await bootCare({ store: mine() });
    await off.harness.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "pib-setup", stateKey: "modules" }, { companyId: CO, modules: { crm: false }, updatedAt: new Date().toISOString() });
    expect(await careCompanies(off.harness.ctx)).toEqual([]);
  });

  it("each care step runs on its own: a broken support lookup does not stop the reminders or the report catch-up", async () => {
    const booted = await bootCare({ store: mine() });
    const { harness } = booted;
    const made = await tool<Record<string, any>>(harness, "create-client-action", { client: "company:acme", kind: "info", title: "Send your logo" });
    await decide(harness, made.approvalIssueId, "done", "user");
    await answerSend(harness, `crm:msg:${booted.store.care_approvals![0]!.id}`, "sent");
    const query = harness.ctx.db.query.bind(harness.ctx.db);
    (harness.ctx.db as any).query = async (sql: string, params?: unknown[]) => {
      if (/FROM \S+\.support_cases/.test(sql)) throw new Error("support table unavailable");
      return query(sql, params);
    };
    const run = await runClientCareJob(harness.ctx, new Date(Date.now() + 4 * 86_400_000));
    expect(run.companies).toBe(1);
    expect(run.reminders).toBe(1);
    expect(run.breaches).toBe(0);
  });

  it("the hourly part (the register, erasure re-sends) runs in the first quarter of the hour only", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    await runClientCareJob(harness.ctx, new Date("2026-10-15T08:30:00.000Z"));
    expect(store.processing_register ?? []).toHaveLength(0);
    await runClientCareJob(harness.ctx, new Date("2026-10-15T08:05:00.000Z"));
    expect(store.processing_register!.length).toBeGreaterThan(8);
  });

  it("the manifest jobs run: the monitor with no sites, the daily health score, the care job", async () => {
    const booted = await bootCare({ store: mine() });
    const { harness, store } = booted;
    await harness.runJob("site-monitor");
    expect(await runSiteMonitorJob(harness.ctx)).toEqual({ companies: 1, checked: 0, down: 0 });
    await harness.runJob("client-health");
    expect(store.client_health!.map((row) => row.client_ref).sort()).toEqual(["acme", "solo"]);
    expect(await runClientHealthJob(harness.ctx)).toMatchObject({ companies: 1, scored: 2 });
    // Each job is tracked, so the Cockpit can tell when one stops running.
    for (const key of ["site-monitor", "client-health", "client-care", "client-report-monthly"]) {
      await harness.runJob(key);
      const record = (await harness.ctx.state.get({ scopeKind: "instance", namespace: "pib-cockpit-jobs", stateKey: `job:${key}` })) as { lastOkAt?: string; consecutiveFailures?: number } | null;
      expect(record?.lastOkAt, key).toBeTruthy();
      expect(record?.consecutiveFailures, key).toBe(0);
    }
  });
});

describe("the Cockpit and the client page", () => {
  it("the snapshot carries the care checks, all green for a quiet company", async () => {
    const { harness } = await bootCare();
    const snap = await cockpitSnapshot(harness.ctx, CO);
    const keys = snap.health.map((h) => h.key);
    for (const key of ["support:sla", "client-actions", "clients:health", "client-reports", "privacy:consent-gaps", "job:site-monitor", "job:client-care", "job:client-health", "job:client-report-monthly"]) expect(keys, key).toContain(key);
    expect(snap.health.every((h) => h.status === "ok")).toBe(true);
    expect((await careHealth(harness.ctx, CO)).map((h) => h.key)).toEqual(["support:sla", "client-actions", "clients:health", "client-reports", "privacy:consent-gaps"]);
  });

  it("shows a late support case red and a client's unread answer as waiting, and one broken part never breaks the snapshot", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    await tool(harness, "open-support-case", { client: "company:acme", title: "Emails bounce", severity: "urgent" });
    store.support_cases![0]!.first_response_due_at = new Date(Date.now() - 3_600_000).toISOString();
    const made = await tool<Record<string, any>>(harness, "create-client-action", { client: "company:acme", kind: "info", title: "Send your logo" });
    await decide(harness, made.approvalIssueId, "done", "user");
    await answerSend(harness, `crm:msg:${store.care_approvals![0]!.id}`, "sent");
    await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, {
      key: "mail:r1", accountAddress: "a@b.test", messageId: "r1", threadId: "t1", from: { email: "ada@acme.co.za", name: "Ada" }, to: [{ email: "a@b.test" }], subject: "Re", snippet: "Here is the logo", receivedAt: new Date().toISOString(), attachments: [],
      triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null }, replyTo: { plugin: "partnersinbiz.crm", kind: "client_message", id: store.care_approvals![0]!.id },
    }, { companyId: CO });
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.health.find((h) => h.key === "support:sla")).toMatchObject({ status: "bad" });
    expect(snap.waiting.map((w) => w.title)).toContain("Read the client's answer: Send your logo");
    const query = harness.ctx.db.query.bind(harness.ctx.db);
    (harness.ctx.db as any).query = async (sql: string, params?: unknown[]) => {
      if (/FROM \S+\.client_health/.test(sql)) throw new Error("boom");
      return query(sql, params);
    };
    const again = await cockpitSnapshot(harness.ctx, CO);
    expect(again.health.some((h) => h.key === "support:sla")).toBe(true);
    expect(again.health.some((h) => h.key === "clients:health")).toBe(false);
  });

  it("the client workspace carries the care card: score, cases, requests, reports, sites, feedback, sensitivity", async () => {
    const { harness } = await bootCare();
    await tool(harness, "open-support-case", { client: "company:acme", title: "Printer" });
    await tool(harness, "create-client-action", { client: "company:acme", kind: "info", title: "Send your logo" });
    const data = await harness.performAction<Record<string, any>>("crm.client-workspace", { kind: "company", id: "acme" }, { companyId: CO, actor: BOARD });
    expect(data.care).toMatchObject({ customer: true, sensitivity: { level: "standard" }, sites: [], reports: [] });
    expect(data.care.cases[0]).toMatchObject({ title: "Printer", status: "new" });
    expect(data.care.actions[0]).toMatchObject({ title: "Send your logo", status: "draft" });
    expect(data.care.health).toMatchObject({ band: expect.any(String), customer: true });
    expect(data.care.feedback).toEqual({ items: [], nps: null });
    expect(data.care.consent).toEqual([]);
    await tool(harness, "record-consent", { contactId: "contact:ada", basis: "contract", wording: "Existing client for SEO; the email is about the service we give them." });
    const again = await harness.performAction<Record<string, any>>("crm.client-workspace", { kind: "company", id: "acme" }, { companyId: CO, actor: BOARD });
    expect(again.care.consent).toEqual([expect.objectContaining({ person: "Ada Lovelace", purpose: "marketing_email", basis: "contract", granted: true, source: "manual" })]);
    expect(JSON.stringify(again.care.consent)).not.toMatch(/ada@acme|hash/);
    const lead = await harness.performAction<Record<string, any>>("crm.client-workspace", { kind: "company", id: "globex" }, { companyId: CO, actor: BOARD });
    expect(lead.care).toMatchObject({ customer: false, health: null });
  });

  it("mail that is neither a reply to one of our emails nor support is left to the rest of the CRM, and a malformed one never throws", async () => {
    const { harness, store } = await bootCare({ store: careSeed() });
    await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, { not: "a mail" }, { companyId: CO });
    await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, {
      key: "mail:n1", accountAddress: "a@b.test", messageId: "n1", threadId: "t", from: { email: "news@promo.test", name: "News" }, to: [], subject: "Sale", snippet: "50% off", receivedAt: new Date().toISOString(), attachments: [],
      triage: { category: "newsletter", urgency: null, needsReply: null, phishing: null, confidence: null }, replyTo: null,
    }, { companyId: CO });
    expect(store.support_cases ?? []).toHaveLength(0);
    expect(store.client_actions ?? []).toHaveLength(0);
  });
});
