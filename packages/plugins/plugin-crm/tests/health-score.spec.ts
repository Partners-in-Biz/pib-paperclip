import { describe, expect, it } from "vitest";
import { WORK_KINDS as DONE_CHECK_WORK_KINDS, checkChurnRisk, checkFeedbackLow } from "../src/done-checks.js";
import { AT_RISK_BELOW, bandOf, clientsAtRiskHealth, EMPTY_INPUTS, gatherHealthInputs, HEALTH_WEIGHTS, healthComponents, MIN_PARTS_FOR_ALERT, runHealthScores, scoreClientHealth, shouldAlert, WATCH_BELOW, WORK_KINDS, type HealthInputs } from "../src/health-score.js";
import { runSupportSla } from "../src/support.js";
import { bootCare, careSeed, CO, company, contact, DAY, issuesWith, tool, type Booted } from "./helpers/care.js";

const inputs = (extra: Partial<HealthInputs>): HealthInputs => ({ ...EMPTY_INPUTS, ...extra });
const NOW = new Date("2026-10-03T08:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe("the health score", () => {
  it("weights add up to 100 and the bands sit at 50 and 75", () => {
    expect(Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(bandOf(75)).toBe("healthy");
    expect(bandOf(74)).toBe("watch");
    expect(bandOf(AT_RISK_BELOW)).toBe("watch");
    expect(bandOf(AT_RISK_BELOW - 1)).toBe("at_risk");
    expect(WATCH_BELOW).toBe(75);
  });

  it("with no data at all the score is 100, nothing is measured, and it may not raise an alert", () => {
    const scored = scoreClientHealth(EMPTY_INPUTS);
    expect(scored).toMatchObject({ score: 100, band: "healthy", enoughData: false });
    expect(scored.missing).toEqual(["Support", "Reply speed", "Invoices", "SEO health", "Website", "Answers our requests", "Last contact"]);
  });

  it("leaves a part with no data out and scales the rest, so no SEO sprint is not a bad score", () => {
    const only = scoreClientHealth(inputs({ billing: { overdueCount: 0 }, support: { open: 0, breached: 0, urgentOpen: 0, latestCsat: null } }));
    expect(only.score).toBe(100);
    const mixed = scoreClientHealth(inputs({ billing: { overdueCount: 3 }, support: { open: 0, breached: 0, urgentOpen: 0, latestCsat: null } }));
    // (15 * 20 + 100 * 25) / 45
    expect(mixed.score).toBe(62);
    expect(mixed.band).toBe("watch");
  });

  it("scores support by what is breached, urgent, piled up, and how the last CSAT went", () => {
    const part = (support: NonNullable<HealthInputs["support"]>) => healthComponents(inputs({ support })).find((c) => c.key === "support")!;
    expect(part({ open: 0, breached: 0, urgentOpen: 0, latestCsat: null })).toMatchObject({ score: 100, detail: "No open cases." });
    expect(part({ open: 2, breached: 1, urgentOpen: 0, latestCsat: null }).score).toBe(70);
    expect(part({ open: 2, breached: 5, urgentOpen: 0, latestCsat: null }).score).toBe(40);
    expect(part({ open: 2, breached: 0, urgentOpen: 1, latestCsat: null }).score).toBe(85);
    expect(part({ open: 6, breached: 0, urgentOpen: 0, latestCsat: null }).score).toBe(80);
    expect(part({ open: 1, breached: 0, urgentOpen: 0, latestCsat: 2 }).score).toBe(80);
    expect(part({ open: 1, breached: 0, urgentOpen: 0, latestCsat: 3 }).score).toBe(90);
    expect(part({ open: 20, breached: 9, urgentOpen: 9, latestCsat: 1 }).score).toBe(0);
  });

  it("scores each other part from its figures, in words", () => {
    const get = (extra: Partial<HealthInputs>, key: string) => healthComponents(inputs(extra)).find((c) => c.key === key)!;
    expect(get({ replyLatency: { unanswered: 0, oldestHours: null } }, "replyLatency").score).toBe(100);
    expect(get({ replyLatency: { unanswered: 2, oldestHours: 100 } }, "replyLatency")).toMatchObject({ score: 30 });
    expect(get({ replyLatency: { unanswered: 2, oldestHours: 100 } }, "replyLatency").detail).toMatch(/2 emails from them waited over 48 hours \(the oldest 100 h\)/);
    expect(get({ billing: { overdueCount: 1 } }, "billing").score).toBe(65);
    expect(get({ billing: { overdueCount: 2 } }, "billing").score).toBe(40);
    expect(get({ billing: { overdueCount: 0 } }, "billing").detail).toBe("Nothing overdue.");
    expect(get({ seo: { score: 38 } }, "seo")).toMatchObject({ score: 38, detail: "The SEO sprint health is 38 of 100." });
    expect(get({ uptime: { down: true, tlsDays: 90, monthPct: 100, sites: 1 } }, "uptime").score).toBe(0);
    expect(get({ uptime: { down: false, tlsDays: 2, monthPct: 100, sites: 1 } }, "uptime").score).toBe(20);
    expect(get({ uptime: { down: false, tlsDays: 10, monthPct: 100, sites: 1 } }, "uptime").score).toBe(50);
    expect(get({ uptime: { down: false, tlsDays: 90, monthPct: 97, sites: 2 } }, "uptime").score).toBe(70);
    expect(get({ uptime: { down: false, tlsDays: 90, monthPct: 90, sites: 2 } }, "uptime").score).toBe(40);
    expect(get({ uptime: { down: false, tlsDays: 90, monthPct: 100, sites: 2 } }, "uptime").detail).toBe("2 sites up.");
    expect(get({ responsiveness: { waiting: 2, stale: 1 } }, "responsiveness").score).toBe(60);
    expect(get({ recency: { daysSince: 10 } }, "recency").score).toBe(100);
    expect(get({ recency: { daysSince: 45 } }, "recency").score).toBe(60);
    expect(get({ recency: { daysSince: 400 } }, "recency").score).toBe(10);
    expect(healthComponents(inputs({ recency: { daysSince: null } }))).toEqual([]);
  });

  it("a client with weak parts across the board lands in the risk band, with enough data to alert", () => {
    const scored = scoreClientHealth(inputs({
      support: { open: 3, breached: 2, urgentOpen: 1, latestCsat: 2 },
      billing: { overdueCount: 3 },
      seo: { score: 30 },
      recency: { daysSince: 80 },
    }));
    expect(scored.band).toBe("at_risk");
    expect(scored.enoughData).toBe(true);
    expect(MIN_PARTS_FOR_ALERT).toBe(3);
    expect(scoreClientHealth(inputs({ billing: { overdueCount: 3 }, seo: { score: 10 } })).enoughData).toBe(false);
  });

  it("raises the alert for the risk band, or a big fall, once in 30 days, and never on thin data", () => {
    const base = { band: "at_risk" as const, score: 40, enoughData: true };
    const now = NOW.getTime();
    expect(shouldAlert(base, null, now)).toBe(true);
    expect(shouldAlert({ ...base, enoughData: false }, null, now)).toBe(false);
    expect(shouldAlert({ band: "healthy", score: 90, enoughData: true }, null, now)).toBe(false);
    expect(shouldAlert({ band: "watch", score: 60, enoughData: true }, { score: 90, alertedAt: null }, now)).toBe(true);
    expect(shouldAlert({ band: "watch", score: 60, enoughData: true }, { score: 70, alertedAt: null }, now)).toBe(false);
    expect(shouldAlert({ band: "healthy", score: 80, enoughData: true }, { score: 99, alertedAt: null }, now)).toBe(false);
    expect(shouldAlert(base, { score: 40, alertedAt: ago(10) }, now)).toBe(false);
    expect(shouldAlert(base, { score: 40, alertedAt: ago(31) }, now)).toBe(true);
  });

  it("reads the same work kinds as the done-checks", () => {
    expect(WORK_KINDS).toEqual(DONE_CHECK_WORK_KINDS);
  });
});

async function weakAcme(): Promise<Booted> {
  const store = careSeed({
    client_sites: [{ id: "site-1", company_id: CO, client_kind: "company", client_ref: "acme", label: null, url: "https://acme.co.za/", project_id: null, created_at: "2026-09-01T00:00:00Z" }],
    site_monitor: [{ site_id: "site-1", company_id: CO, enabled: true, status: "down", http_status: null, response_ms: null, last_error: "timeout", last_checked_at: ago(0), last_ok_at: null, down_since: new Date(NOW.getTime() - 60 * 60_000).toISOString(), failures: 12, tls_expires_at: null, tls_error: null, tls_checked_at: null, domain: null, domain_expires_at: null, domain_checked_at: null, domain_error: null, domain_manual: false }],
    activities: [
      { id: "a1", company_id: CO, record_type: "contact", record_id: "ada", kind: "email_received", body: "Where is my invoice?", created_at: ago(5), meta: null, source_key: "mail:1", issue_id: null },
      { id: "a2", company_id: CO, record_type: "contact", record_id: "ada", kind: "email_received", body: "Hello?", created_at: ago(4), meta: null, source_key: "mail:2", issue_id: null },
    ],
  });
  const booted = await bootCare({ store });
  const harness = booted.harness;
  await tool(harness, "record-client-signal", { client: "company:acme", module: "billing", health: { overdueCount: 3 } });
  await tool(harness, "record-client-signal", { client: "company:acme", module: "seo", health: { score: 25 } });
  const made = await tool<Record<string, any>>(harness, "open-support-case", { client: "company:acme", title: "Site down", severity: "urgent" });
  await runSupportSla(harness.ctx, CO, new Date(Date.now() + 3 * 3_600_000));
  expect(made.caseId).toBeTruthy();
  return booted;
}

describe("gathering what the score reads", () => {
  it("takes support, unanswered email, the other modules' signals and the monitor from the right places", async () => {
    const booted = await weakAcme();
    const read = await gatherHealthInputs(booted.harness.ctx, CO, { kind: "company", id: "acme" }, new Date());
    expect(read.support).toMatchObject({ open: 1, urgentOpen: 1 });
    expect(read.support!.breached).toBe(1);
    expect(read.billing).toEqual({ overdueCount: 3 });
    expect(read.seo).toEqual({ score: 25 });
    expect(read.replyLatency).toMatchObject({ unanswered: 2 });
    expect(read.uptime).toMatchObject({ down: true, sites: 1 });
    // The last thing from them was an email four days ago; the system's own notes about the case do not count as contact.
    expect(read.recency!.daysSince).toBe(4);
  });

  it("an email answered by later work on the client is not unanswered", async () => {
    const store = careSeed({
      activities: [
        { id: "a1", company_id: CO, record_type: "contact", record_id: "ada", kind: "email_received", body: "Question", created_at: ago(5), meta: null, source_key: "mail:1", issue_id: null },
        { id: "a2", company_id: CO, record_type: "contact", record_id: "ada", kind: "email_sent", body: "Answer", created_at: ago(4.5), meta: null, source_key: "mail:2", issue_id: null },
      ],
    });
    const booted = await bootCare({ store });
    const read = await gatherHealthInputs(booted.harness.ctx, CO, { kind: "company", id: "acme" }, new Date());
    expect(read.replyLatency).toEqual({ unanswered: 0, oldestHours: null });
  });

  it("a client with nothing recorded has no support, signals, uptime or requests part", async () => {
    const booted = await bootCare();
    const read = await gatherHealthInputs(booted.harness.ctx, CO, { kind: "company", id: "acme" }, new Date());
    expect(read).toMatchObject({ support: null, replyLatency: null, billing: null, seo: null, uptime: null, responsiveness: null });
  });
});

describe("the daily job", () => {
  it("scores customers only, keeps the score, and opens one churn-risk issue for the one that is at risk", async () => {
    const booted = await weakAcme();
    const { harness, store } = booted;
    const run = await runHealthScores(harness.ctx, CO, new Date());
    expect(run).toMatchObject({ scored: 2, atRisk: 1, alerts: 1 });
    const acme = store.client_health!.find((row) => row.client_ref === "acme")!;
    expect(acme).toMatchObject({ band: "at_risk", client_kind: "company" });
    expect(acme.score).toBeLessThan(50);
    expect(acme.at_risk_since).toBeTruthy();
    expect(acme.alerted_at).toBeTruthy();
    expect(store.client_health!.find((row) => row.client_ref === "solo")).toMatchObject({ band: "healthy", score: 100 });
    // Globex is a lead: not scored.
    expect(store.client_health!.some((row) => row.client_ref === "globex")).toBe(false);

    const [issue] = await issuesWith(harness, "crm:churn-risk:");
    expect(issue).toMatchObject({ assigneeAgentId: "am-1", priority: "high" });
    expect(issue!.originId).toMatch(/^crm:churn-risk:company:acme:\d{4}-\d{2}$/);
    expect(issue!.title).toMatch(/^Churn risk: Acme Plumbing \(health \d+\)/);
    expect(issue!.description).toContain("**Invoices**");
    expect(issue!.description).toContain("3 invoices overdue");
    expect(issue!.description).toContain("**SEO health**");
    expect(issue!.description).toContain("**Done when** your follow-up is logged on the client");
    // Running again does not open a second one, nor re-alert.
    expect((await runHealthScores(harness.ctx, CO, new Date())).alerts).toBe(0);
    expect(await issuesWith(harness, "crm:churn-risk:")).toHaveLength(1);
    expect(store.client_health!.find((row) => row.client_ref === "acme")!.previous_score).toBe(acme.score);
    expect((await clientsAtRiskHealth(harness.ctx, CO))).toMatchObject({ key: "clients:health", status: "warn" });
  });

  it("closing the issue needs a follow-up logged on the client since it opened", async () => {
    const booted = await weakAcme();
    const { harness, store } = booted;
    await runHealthScores(harness.ctx, CO, new Date());
    const [issue] = await issuesWith(harness, "crm:churn-risk:");
    const doneIssue = { id: issue!.id, companyId: CO, originId: issue!.originId, createdAt: new Date(Date.now() - 3_600_000).toISOString() } as never;
    const open = await checkChurnRisk(harness.ctx, doneIssue);
    expect(open).toMatchObject({ done: false });
    expect((open as { missing: string[] }).missing[0]).toMatch(/Nothing is logged on `company:acme` since this issue opened/);
    await tool(harness, "log-activity", { recordType: "company", recordId: "acme", kind: "call", body: "Called Ada: fixing the site today and a review on Friday." });
    expect(await checkChurnRisk(harness.ctx, doneIssue)).toEqual({ done: true });
    // A client that is gone, or no longer a customer, has nothing to retain.
    store.activities = store.activities!.filter((row) => row.kind !== "call");
    store.companies!.find((row) => row.id === "acme")!.lifecycle = "churned";
    expect(await checkChurnRisk(harness.ctx, doneIssue)).toEqual({ done: true });
    expect(await checkChurnRisk(harness.ctx, { ...(doneIssue as object), originId: "crm:churn-risk:company:gone:2026-10" } as never)).toEqual({ done: true });
    expect(await checkFeedbackLow(harness.ctx, { ...(doneIssue as object), originId: "crm:feedback-low:nope" } as never)).toEqual({ done: true });
  });

  it("never alerts for an internal or canary client, and never on thin data", async () => {
    const store = careSeed();
    store.companies = [...store.companies!, company("own", "Our Own App", { lifecycle: "customer", tags: ["own-app"] })];
    store.contacts = [...store.contacts!, contact("pat", "Pat Plumber", { emails: ["pat@solo.test"], lifecycle: "customer" })];
    const booted = await bootCare({ store });
    await tool(booted.harness, "record-client-signal", { client: "company:own", module: "billing", health: { overdueCount: 4 } });
    await tool(booted.harness, "record-client-signal", { client: "company:own", module: "seo", health: { score: 5 } });
    await tool(booted.harness, "record-client-signal", { client: "contact:pat", module: "billing", health: { overdueCount: 4 } });
    await tool(booted.harness, "record-client-signal", { client: "contact:pat", module: "seo", health: { score: 5 } });
    const run = await runHealthScores(booted.harness.ctx, CO, new Date());
    expect(run.alerts).toBe(0);
    expect(await issuesWith(booted.harness, "crm:churn-risk:")).toHaveLength(0);
    // Scored all the same, so the numbers exist for people who ask.
    expect(booted.store.client_health!.find((row) => row.client_ref === "own")!.band).toBe("at_risk");
  });

  it("the tool scores one client fresh, or lists the stored scores weakest first", async () => {
    const booted = await weakAcme();
    const one = await tool<Record<string, any>>(booted.harness, "client-health", { client: "company:acme" });
    expect(one).toMatchObject({ client: "company:acme", name: "Acme Plumbing", band: "at_risk", computedFresh: true });
    expect(one.parts.map((p: any) => p.part)).toEqual(expect.arrayContaining(["Support", "Invoices", "SEO health", "Reply speed", "Website"]));
    expect(one.notMeasured).toContain("Answers our requests");
    expect((await tool<Record<string, any>>(booted.harness, "client-health", {})).note).toMatch(/No scores yet/);
    await runHealthScores(booted.harness.ctx, CO, new Date());
    const all = await tool<Record<string, any>>(booted.harness, "client-health", {});
    expect(all.clients.map((c: any) => c.name)).toEqual(["Acme Plumbing", "Sipho Solo"]);
    expect((await tool<Record<string, any>>(booted.harness, "client-health", { onlyAtRisk: true })).clients.map((c: any) => c.name)).toEqual(["Acme Plumbing"]);
  });
});
