import { describe, expect, it, vi } from "vitest";
import { runClientCareJob } from "../src/care-jobs.js";
import { reportIssueResolved, reportsHealth, runMonthlyReports, saveReportDocument, worthReporting, expectedModules } from "../src/report.js";
import { atAGlance, currentPeriod, EMPTY_NARRATIVE, escapeHtml, periodBounds, periodLabel, previousPeriod, renderClientMarkdown, renderHtml, renderInternalMarkdown, type ReportData } from "../src/report-render.js";
import { answerSend, bootCare, careSeed, CO, company, contact, DAY, decide, issuesWith, OWNER, sentMail, tool, toolRaw, type Booted, type Route } from "./helpers/care.js";

const NOW = new Date();
const PERIOD = currentPeriod(NOW);

const WORK: Route = [/FROM public\.issues/, () => [{ identifier: "PAR-12", title: "Fix the header menu" }, { identifier: "PAR-14", title: "New landing page" }]];
const COST: Route = [/FROM public\.cost_events/, () => [{ cost_cents: 250, input_tokens: 10_000, output_tokens: 2_500 }, { cost_cents: 100, input_tokens: 4_000, output_tokens: 800 }]];

function profile(services: string[]) {
  return { id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", brand_voice: null, audience: null, services, website: null, booking_link: null, banned_words: [], tone_notes: null, human_owned: [], updated_by: null, updated_at: "2026-09-01T00:00:00Z", services_other: [], services_normalized_at: "2026-09-01T00:00:00Z" };
}

function reportSeed(extra: Record<string, unknown[]> = {}) {
  return careSeed({
    client_profiles: [profile(["seo", "social"])],
    client_projects: [{ id: "cp1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "proj-acme", created_at: "2026-09-01T00:00:00Z" }],
    ...(extra as Record<string, never>),
  });
}

/** Not Partners in Biz: the CRM serves Partners in Apps too, and every email to a client must carry the name of the company that sends it. */
const BRAND = "Partners in Apps";

async function bootReport(extra: Record<string, unknown[]> = {}): Promise<Booted> {
  const booted = await bootCare({ store: reportSeed(extra), routes: [WORK, COST] });
  booted.harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: BRAND } as never] });
  return booted;
}

const SEO_SIGNAL = { client: "company:acme", module: "seo", period: PERIOD, headline: [{ label: "Clicks", value: "1,240", delta: "+18% on last month" }, { label: "Impressions", value: "31,500" }], bullets: ["Moved to position 4 for emergency plumber Ballito."] };

describe("the months a report covers", () => {
  it("are South African months: a month starts and ends at 22:00 UTC the evening before", () => {
    expect(periodBounds("2026-09")).toEqual({ from: "2026-08-31T22:00:00.000Z", to: "2026-09-30T22:00:00.000Z" });
    expect(periodBounds("2026-12")).toEqual({ from: "2026-11-30T22:00:00.000Z", to: "2026-12-31T22:00:00.000Z" });
    expect(() => periodBounds("September")).toThrow(/YYYY-MM/);
    expect(periodLabel("2026-09")).toBe("September 2026");
  });

  it("the job on the 1st at 06:00 SAST reports the month that just ended, also across New Year", () => {
    expect(previousPeriod(new Date("2026-10-01T04:00:00.000Z"))).toBe("2026-09");
    expect(previousPeriod(new Date("2027-01-01T04:00:00.000Z"))).toBe("2026-12");
    // Just before midnight UTC on the 30th it is already the 1st in South Africa.
    expect(previousPeriod(new Date("2026-10-31T22:30:00.000Z"))).toBe("2026-10");
    expect(currentPeriod(new Date("2026-09-30T21:59:00.000Z"))).toBe("2026-09");
    expect(currentPeriod(new Date("2026-09-30T22:00:00.000Z"))).toBe("2026-10");
  });

  it("expect the modules the client's services use, and Billing for everyone", () => {
    expect(expectedModules([])).toEqual(["billing"]);
    expect(expectedModules(["seo", "social", "bookkeeping"])).toEqual(["seo", "social", "billing"]);
    expect(expectedModules(["campaigns", "lead-capture"])).toEqual(["campaigns", "billing"]);
  });
});

function data(extra: Partial<ReportData> = {}): ReportData {
  return {
    version: 1, period: "2026-09", periodLabel: "September 2026", client: { ref: "company:acme", name: "Acme <Plumbing> & Sons", website: "acme.co.za" }, brand: BRAND,
    sections: [
      { module: "seo", title: "Search (SEO)", source: "event", headline: [{ label: "Clicks", value: "1,240", delta: "+18%" }, { label: "Impressions", value: "31,500" }, { label: "Avg position", value: "6.2" }], bullets: ["Moved up for <b>emergency plumber</b>"] },
      { module: "support", title: "Support", source: "crm", headline: [{ label: "Support requests", value: "3 opened, 3 resolved" }], bullets: [] },
      { module: "social", title: "Social media", source: "agent", headline: [{ label: "Posts", value: "12" }, { label: "Engagement", value: "4.1%" }], bullets: [], note: "Facebook only; Instagram is not connected." },
      { module: "billing", title: "Billing", source: "crm", headline: [{ label: "Invoices paid", value: "2" }], bullets: ["Invoice INV-7 paid (R 1,500.00)."] },
    ],
    missing: [{ module: "campaigns", title: "Email campaigns", plugin: "partnersinbiz.campaigns", tools: ["list-campaigns", "campaign-stats"], ask: "emails sent, opens and replies" }],
    waitingOnClient: [{ title: "Approve the new homepage", days: 4 }],
    workDone: { count: 14, titles: ["PAR-12 Fix the header menu", "PAR-14 New landing page"] },
    effort: { issues: 14, costCents: 350, inputTokens: 14_000, outputTokens: 3_300 },
    health: { score: 62, band: "watch" },
    ...extra,
  };
}

describe("the report as documents", () => {
  const narrative = { summary: "A good month: more people found you and every support request was answered the same day.", highlights: ["Position 4 for emergency plumber Ballito"], next: ["Launch the new landing page"] };

  it("the client's Markdown has the summary, the numbers, each module, what we need from them, and nothing internal", () => {
    const md = renderClientMarkdown(data(), narrative);
    expect(md).toMatch(/^# Monthly report: Acme <Plumbing> & Sons\nSeptember 2026 · Partners in Apps/);
    expect(md).toContain("A good month");
    expect(md).toContain("## At a glance\n- Clicks: 1,240 (+18%)");
    expect(md).toContain("## Highlights\n- Position 4");
    expect(md).toContain("## Social media\n- Posts: 12");
    expect(md).toContain("Facebook only; Instagram is not connected.");
    expect(md).toContain("## What we need from you\n- Approve the new homepage (asked 4 days ago)");
    expect(md).toContain("## Next month\n- Launch the new landing page");
    expect(md).not.toMatch(/Internal|PAR-12|\$3\.50|tokens|health|Email campaigns/i);
    expect(atAGlance(data().sections)).toHaveLength(6);
  });

  it("the working copy adds where numbers came from, what is missing and how to fill it, the work done, the effort and the health", () => {
    const md = renderInternalMarkdown(data(), EMPTY_NARRATIVE);
    expect(md).toContain("## Internal: not sent to the client");
    expect(md).toContain("- Search (SEO): sent by the module");
    expect(md).toContain("- Social media: read by an agent from the module's tools");
    expect(md).toContain("- Support: from the CRM's own records");
    expect(md).toContain("**Email campaigns** (partnersinbiz.campaigns): call `list-campaigns`, `campaign-stats`");
    expect(md).toContain("`record-client-signal` with module `campaigns`, period `2026-09`");
    expect(md).toContain("### The summary is not written");
    expect(md).toContain("- PAR-12 Fix the header menu");
    expect(md).toContain("never paste internal ticket titles");
    expect(md).toContain("about $3.50 (14,000 tokens in, 3,300 out)");
    expect(md).toContain("never show it to the client");
    expect(md).toContain("62 of 100 (watch)");
    expect(renderInternalMarkdown(data({ missing: [], effort: null, health: null, workDone: { count: 0, titles: [] } }), narrative)).not.toMatch(/Not in the report yet|Effort|Customer health|Work completed/);
  });

  it("the HTML is branded, escapes everything a module or an agent wrote, and carries the same numbers", () => {
    const html = renderHtml(data({ client: { ref: "company:acme", name: "<img src=x onerror=alert(1)>", website: null } }), { ...narrative, summary: "Summary with <script>alert(1)</script> & more." });
    expect(html).not.toMatch(/<img|<script|<b>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more.");
    expect(html).toContain("&lt;b&gt;emergency plumber&lt;/b&gt;");
    expect(html).toContain("Partners in Apps · Monthly report");
    expect(html).toContain("September 2026");
    expect(html).toContain("1,240");
    expect(html).toContain("+18%");
    expect(html).toContain("What we need from you");
    expect(html).not.toMatch(/PAR-12|Effort|tokens/);
    expect(escapeHtml(`a<b>&"'`)).toBe("a&lt;b&gt;&amp;&quot;&#39;");
  });
});

describe("build-client-report", () => {
  it("builds the report from the CRM's own records: support, enquiries, uptime, invoices, our contact, what we wait for", async () => {
    const monthStart = new Date(periodBounds(PERIOD).from);
    const mid = new Date(monthStart.getTime() + 3600_000).toISOString();
    const store = reportSeed({
      client_leads: [
        { id: "l1", key: "form:1", company_id: CO, client_kind: "company", client_ref: "acme", source: "form", platform: null, name: "Lead One", handle: null, email: "one@x.test", message: "Quote please", url: null, item_id: null, confidence: null, captured_at: mid, created_at: mid },
        { id: "l2", key: "form:2", company_id: CO, client_kind: "company", client_ref: "acme", source: "form", platform: null, name: "Lead Two", handle: null, email: "two@x.test", message: "Hello", url: null, item_id: null, confidence: null, captured_at: mid, created_at: mid },
      ],
      activities: [
        { id: "a1", company_id: CO, record_type: "company", record_id: "acme", kind: "invoice_paid", body: "Invoice INV-7 paid (R 1,500.00). Lifecycle set to customer.", created_at: mid, meta: null, source_key: "i1", issue_id: null },
        { id: "a2", company_id: CO, record_type: "contact", record_id: "ada", kind: "call", body: "Called Ada", created_at: mid, meta: null, source_key: "c1", issue_id: null },
        { id: "a3", company_id: CO, record_type: "contact", record_id: "ada", kind: "email_received", body: "Hi", created_at: mid, meta: null, source_key: "e1", issue_id: null },
      ],
    });
    const booted = await bootCare({ store, routes: [WORK, COST] });
    const { harness } = booted;
    harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: BRAND } as never] });
    const made = await tool<Record<string, any>>(harness, "open-support-case", { client: "company:acme", title: "Quote form emails go to spam", source: "portal" });
    await tool(harness, "update-support-case", { caseId: made.caseId, firstResponse: true });
    await tool(harness, "update-support-case", { caseId: made.caseId, status: "resolved", resolution: "Fixed the SPF record." });
    const result = await tool<Record<string, any>>(harness, "build-client-report", { client: "company:acme", period: PERIOD });
    expect(result).toMatchObject({ status: "built", created: true, period: PERIOD, narrativeWritten: false, workDone: 2 });
    const titles = result.sections.map((s: any) => s.title);
    expect(titles).toEqual(expect.arrayContaining(["Support", "Enquiries for your business", "Billing", "Our work together"]));
    expect(result.missing.map((m: any) => m.module)).toEqual(["seo", "social"]);
    expect(result.missing[0]).toMatchObject({ plugin: "partnersinbiz.seo", tools: expect.arrayContaining(["get-sprint", "gsc-query"]) });
    const rec = booted.store.client_reports![0]!;
    expect(rec).toMatchObject({ client_kind: "company", client_ref: "acme", period: PERIOD, status: "built" });
    expect(rec.markdown).toContain("Support requests: 1 opened, 1 resolved");
    expect(rec.markdown).toContain("Enquiries received: 2");
    expect(rec.markdown).toContain("Invoice INV-7 paid (R 1,500.00).");
    expect(rec.markdown).toContain("Calls and meetings: 1");
    expect(rec.markdown).not.toContain("PAR-12");
    expect(rec.data.workDone).toEqual({ count: 2, titles: ["PAR-12 Fix the header menu", "PAR-14 New landing page"] });
    expect(rec.data.effort).toEqual({ issues: 2, costCents: 350, inputTokens: 14_000, outputTokens: 3_300 });
    expect(rec.html).toContain(`${BRAND} · Monthly report`);
    expect(rec.data.brand).toBe(BRAND);
  });

  it("is idempotent per client and month: asking again updates the numbers, keeps the summary and never makes a second report", async () => {
    const booted = await bootReport();
    const { harness, store } = booted;
    await tool(harness, "build-client-report", { client: "company:acme", period: PERIOD });
    await tool(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary: "A quiet month with steady results and no problems to report at all.", highlights: ["Steady"], next: ["Carry on"] });
    await tool(harness, "record-client-signal", SEO_SIGNAL);
    const again = await tool<Record<string, any>>(harness, "build-client-report", { client: "company:acme", period: PERIOD });
    expect(again).toMatchObject({ created: false, narrativeWritten: true });
    expect(store.client_reports).toHaveLength(1);
    expect(store.client_reports![0]!.markdown).toContain("A quiet month");
    expect(store.client_reports![0]!.markdown).toContain("Clicks: 1,240 (+18% on last month)");
    expect(again.missing.map((m: any) => m.module)).toEqual(["social", "billing"]);
  });

  it("a dry run shows what it would say and stores nothing", async () => {
    const booted = await bootReport();
    const dry = await tool<Record<string, any>>(booted.harness, "build-client-report", { client: "company:acme", period: PERIOD, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, stored: false });
    expect(dry.preview).toContain("# Monthly report: Acme Plumbing");
    expect(booted.store.client_reports ?? []).toHaveLength(0);
  });

  it("puts the working copy on the report issue as an issue document, and replaces it when built again", async () => {
    const booted = await bootReport();
    const { harness } = booted;
    const upsert = vi.spyOn(harness.ctx.issues.documents, "upsert");
    const remove = vi.spyOn(harness.ctx.issues.documents, "delete");
    await runMonthlyReports(harness.ctx, CO, new Date(Date.parse(periodBounds(PERIOD).to) + 4 * 3_600_000));
    const next = previousPeriodOf();
    const [issue] = await issuesWith(harness, "crm:client-report:");
    expect(issue).toBeTruthy();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ issueId: issue!.id, companyId: CO, key: "report", format: "markdown", title: `Monthly report Acme Plumbing ${next}` }));
    expect(String(upsert.mock.calls.at(-1)![0].body)).toContain("## Internal: not sent to the client");
    // Building again from a tool replaces the same document key: one working copy, never two. The old one is deleted first,
    // because the live host refuses to update a document that exists (it wants a revision id a plugin cannot read or send).
    const before = { upsert: upsert.mock.calls.length, remove: remove.mock.calls.length };
    const built = await tool<Record<string, any>>(harness, "build-client-report", { client: "company:acme", period: next });
    expect(built.documentSaved).toBe(true);
    expect(built.documentNote).toBeUndefined();
    expect(upsert.mock.calls.length).toBe(before.upsert + 1);
    expect(remove.mock.calls.length).toBe(before.remove + 1);
    expect(remove).toHaveBeenLastCalledWith(issue!.id, "report", CO);
    expect(upsert.mock.calls.at(-1)![0]).toMatchObject({ issueId: issue!.id, key: "report" });
  });

  describe("on the live host's rules (an existing document cannot be updated, only replaced)", () => {
    /** The monthly job's own first write, then the issue and its document exist. */
    async function withIssue() {
      const booted = await bootReport();
      await runMonthlyReports(booted.harness.ctx, CO, new Date(Date.parse(periodBounds(PERIOD).to) + 4 * 3_600_000));
      const [issue] = await issuesWith(booted.harness, "crm:client-report:");
      return { ...booted, issueId: issue!.id };
    }

    it("the first save works, as the monthly job showed live", async () => {
      const { documents, issueId } = await withIssue();
      expect(documents.bodyOf(issueId, "report")).toContain("## Internal: not sent to the client");
    });

    it("a second build puts the new numbers in the document (a plain upsert is refused by the host)", async () => {
      const { harness, documents, issueId } = await withIssue();
      expect(documents.bodyOf(issueId, "report")).not.toContain("Clicks: 4,321");
      await tool(harness, "record-client-signal", { client: "company:acme", module: "seo", period: PERIOD, headline: [{ label: "Clicks", value: "4,321" }] });
      const built = await tool<Record<string, any>>(harness, "build-client-report", { client: "company:acme", period: PERIOD });
      expect(built.documentSaved).toBe(true);
      expect(documents.bodyOf(issueId, "report")).toContain("Clicks: 4,321");
    });

    it("the narrative the agent writes lands in the document, and so does every later rebuild", async () => {
      const { harness, documents, issueId } = await withIssue();
      const summary = "A good month: more people found you on Google and every support request was answered the same day.";
      const saved = await tool<Record<string, any>>(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary });
      expect(saved).toMatchObject({ narrativeSaved: true, documentSaved: true });
      expect(documents.bodyOf(issueId, "report")).toContain("every support request was answered the same day");
      const rebuilt = await tool<Record<string, any>>(harness, "build-client-report", { client: "company:acme", period: PERIOD });
      expect(rebuilt.documentSaved).toBe(true);
      expect(documents.bodyOf(issueId, "report")).toContain("every support request was answered the same day");
    });

    it("sending refreshes the document too, so the approval and the working copy say the same", async () => {
      const { harness, documents, issueId } = await withIssue();
      await tool(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary: "A good month: more people found you on Google and every support request was answered the same day." });
      await tool(harness, "record-client-signal", { client: "company:acme", module: "social", period: PERIOD, headline: [{ label: "Posts", value: "17" }] });
      await tool(harness, "send-client-report", { client: "company:acme", period: PERIOD });
      expect(documents.bodyOf(issueId, "report")).toContain("Posts: 17");
    });

    it("a locked document is not rewritten: the tool says so plainly, and the report itself is still stored and sendable", async () => {
      const { harness, store, documents, issueId } = await withIssue();
      documents.lock(issueId, "report");
      const before = documents.bodyOf(issueId, "report");
      const built = await tool<Record<string, any>>(harness, "build-client-report", { client: "company:acme", period: PERIOD });
      expect(built.documentSaved).toBe(false);
      expect(built.documentNote).toMatch(/NOT updated \(Document is locked\)/);
      expect(built.documentNote).toMatch(/work from this result, not from the document/);
      expect(documents.bodyOf(issueId, "report")).toBe(before);
      const summary = "A good month: more people found you on Google and every support request was answered the same day.";
      const saved = await tool<Record<string, any>>(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary });
      expect(saved).toMatchObject({ narrativeSaved: true, documentSaved: false });
      expect(saved.documentNote).toMatch(/Document is locked/);
      expect(store.client_reports![0]!.narrative.summary).toBe(summary);
      const sent = await tool<Record<string, any>>(harness, "send-client-report", { client: "company:acme", period: PERIOD });
      expect(sent.status).toBe("awaiting_approval");
    });

    it("a report with no issue yet says there is no document to write, and does not call it a failure of the host", async () => {
      const booted = await bootReport();
      const built = await tool<Record<string, any>>(booted.harness, "build-client-report", { client: "company:acme", period: PERIOD });
      expect(built).toMatchObject({ documentSaved: false });
      expect(built.documentNote).toMatch(/no report issue for this month yet/);
      expect(built.documentNote).not.toMatch(/host/);
    });

    it("two saves at once do not trip over each other (one issue's delete and create never interleave)", async () => {
      const { harness, documents, issueId } = await withIssue();
      const results = await Promise.all([
        saveReportDocument(harness.ctx, CO, issueId, "Acme Plumbing", PERIOD, "first build"),
        saveReportDocument(harness.ctx, CO, issueId, "Acme Plumbing", PERIOD, "second build"),
        saveReportDocument(harness.ctx, CO, issueId, "Acme Plumbing", PERIOD, "third build"),
      ]);
      expect(results.map((r) => r.saved)).toEqual([true, true, true]);
      expect(documents.bodyOf(issueId, "report")).toBe("third build");
    });

    it("one issue failing to save does not hold up the next save for that issue", async () => {
      const { harness, documents, issueId } = await withIssue();
      documents.lock(issueId, "report");
      expect((await saveReportDocument(harness.ctx, CO, issueId, "Acme Plumbing", PERIOD, "while locked")).saved).toBe(false);
      documents.unlock(issueId, "report");
      expect((await saveReportDocument(harness.ctx, CO, issueId, "Acme Plumbing", PERIOD, "after unlock")).saved).toBe(true);
      expect(documents.bodyOf(issueId, "report")).toBe("after unlock");
    });
  });

  it("a host that refuses the document does not stop the report, and the tool says the document was not updated", async () => {
    const booted = await bootReport();
    const { harness } = booted;
    vi.spyOn(harness.ctx.issues.documents, "upsert").mockRejectedValue(new Error("no capability"));
    const run = await runMonthlyReports(harness.ctx, CO, new Date(Date.parse(periodBounds(PERIOD).to) + 4 * 3_600_000));
    expect(run.opened).toBe(1);
    expect(booted.store.client_reports).toHaveLength(1);
    const built = await tool<Record<string, any>>(harness, "build-client-report", { client: "company:acme", period: PERIOD });
    expect(built).toMatchObject({ documentSaved: false });
    expect(built.documentNote).toMatch(/NOT updated \(no capability\)/);
  });

  it("refuses a month that has not started, a bad period and a client that is not visible", async () => {
    const booted = await bootReport();
    expect((await toolRaw(booted.harness, "build-client-report", { client: "company:acme", period: "2099-01" })).error).toMatch(/has not started/);
    expect((await toolRaw(booted.harness, "build-client-report", { client: "company:acme", period: "09-2026" })).error).toMatch(/YYYY-MM/);
    expect((await toolRaw(booted.harness, "build-client-report", { client: "company:nobody" })).error).toMatch(/not found/);
  });

  it("a part that cannot be read leaves a hole, not a failed report", async () => {
    const booted = await bootCare({ store: reportSeed(), routes: [[/FROM public\.issues/, () => { throw new Error("no access"); }], COST] });
    const result = await tool<Record<string, any>>(booted.harness, "build-client-report", { client: "company:acme", period: PERIOD });
    expect(result.status).toBe("built");
    expect(result.workDone).toBe(0);
  });
});

describe("what the other modules send", () => {
  it("a module's event fills its section, labelled as sent by the module", async () => {
    const booted = await bootReport();
    await booted.harness.emit("plugin.partnersinbiz.seo.client.signal", { clientKind: "company", clientRef: "acme", period: PERIOD, headline: [{ label: "Clicks", value: "900" }], bullets: ["Page one for two keywords."] }, { companyId: CO });
    const built = await tool<Record<string, any>>(booted.harness, "build-client-report", { client: "company:acme", period: PERIOD });
    expect(built.sections.find((s: any) => s.module === "seo")).toMatchObject({ source: "event", lines: 2 });
    expect(built.missing.map((m: any) => m.module)).toEqual(["social", "billing"]);
  });
});

function previousPeriodOf() {
  return previousPeriod(new Date(Date.parse(periodBounds(PERIOD).to) + 4 * 3_600_000));
}

describe("the sender's name", () => {
  it("is the company's own name; when it is not known the report names no sender and the subject says us, never another company", () => {
    const md = renderClientMarkdown(data({ brand: null }), { summary: "", highlights: [], next: [] });
    expect(md.split("\n")[1]).toBe("September 2026");
    expect(renderHtml(data({ brand: undefined }), { summary: "", highlights: [], next: [] })).toMatch(/>Monthly report<\/div>/);
    expect(renderHtml(data({ brand: "Acme <Studio>" }), { summary: "", highlights: [], next: [] })).toContain("Acme &lt;Studio&gt; · Monthly report");
  });

  it("a report email carries the sending company's name in its subject, whichever company that is", async () => {
    const booted = await bootReport();
    booted.harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "Dune Digital" } as never] });
    await tool(booted.harness, "build-client-report", { client: "company:acme", period: PERIOD });
    await tool(booted.harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary: "A good month: more people found you on Google and every support request was answered the same day." });
    const sent = await tool<Record<string, any>>(booted.harness, "send-client-report", { client: "company:acme", period: PERIOD });
    const issue = (await booted.harness.ctx.issues.get(sent.approvalIssueId, CO))!;
    expect(issue.description).toContain(`**Subject:** Your ${periodLabel(PERIOD)} report from Dune Digital`);
    expect(issue.description).not.toMatch(/Partners in (Biz|Apps)/);
  });
});

describe("writing and sending the report", () => {
  const summary = "September was a strong month: more people found you on Google and every support request was answered on the day.";

  async function ready() {
    const booted = await bootReport();
    await tool(booted.harness, "build-client-report", { client: "company:acme", period: PERIOD });
    await tool(booted.harness, "record-client-signal", SEO_SIGNAL);
    return booted;
  }

  it("the summary must be written properly", async () => {
    const booted = await ready();
    expect((await toolRaw(booted.harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary: "Good." })).error).toMatch(/at least 40 characters/);
    const saved = await tool<Record<string, any>>(booted.harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary, highlights: ["Position 4"], next: ["Landing page"] });
    expect(saved).toMatchObject({ narrativeSaved: true });
    expect(booted.store.client_reports![0]!.narrative).toEqual({ summary, highlights: ["Position 4"], next: ["Landing page"] });
    expect(booted.store.client_reports![0]!.html).toContain("September was a strong month");
  });

  it("will not send a report with no summary", async () => {
    const booted = await ready();
    expect((await toolRaw(booted.harness, "send-client-report", { client: "company:acme", period: PERIOD })).error).toMatch(/summary is not written/);
    expect(booted.store.care_approvals ?? []).toHaveLength(0);
  });

  it("drafts the email with the report as its body and asks a person; nothing is sent until they approve", async () => {
    const booted = await ready();
    const { harness, store, emit } = booted;
    await tool(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary, highlights: ["Position 4"], next: [] });
    const sent = await tool<Record<string, any>>(harness, "send-client-report", { client: "company:acme", period: PERIOD, message: "Ada, here is the month." });
    expect(sent).toMatchObject({ status: "awaiting_approval", to: "Ada Lovelace <ada@acme.co.za>" });
    expect(store.client_reports![0]).toMatchObject({ status: "awaiting_approval" });
    const issue = (await harness.ctx.issues.get(sent.approvalIssueId, CO))!;
    expect(issue).toMatchObject({ assigneeUserId: OWNER, title: `Approve report email to Acme Plumbing: ${periodLabel(PERIOD)}` });
    expect(issue.description).toContain("**Subject:** Your");
    expect(issue.description).toContain("Hi Ada,");
    expect(issue.description).toContain("Ada, here is the month.");
    expect(issue.description).toContain("Clicks: 1,240 (+18% on last month)");
    expect(issue.description).toMatch(/\*\*Not in the report:\*\* Social media/);
    expect(sentMail(emit)).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
    // Asking again while it waits returns the same approval.
    const again = await tool<Record<string, any>>(harness, "send-client-report", { client: "company:acme", period: PERIOD });
    expect(again).toMatchObject({ note: "This report is already waiting for approval.", approvalIssueId: sent.approvalIssueId });
    expect(store.care_approvals).toHaveLength(1);

    await decide(harness, sent.approvalIssueId, "done", "user");
    const [mail] = sentMail(emit);
    expect(mail).toMatchObject({ to: [{ email: "ada@acme.co.za", name: "Ada Lovelace" }], marketing: false, subject: `Your ${periodLabel(PERIOD)} report from ${BRAND}` });
    expect(mail.html).toContain(`${BRAND} · Monthly report`);
    expect(mail.html + mail.text).not.toContain("Partners in Biz");
    expect(mail.html).toContain("Hi Ada,");
    expect(mail.text).toContain("Position 4");
    expect(mail.html + mail.text).not.toMatch(/PAR-12|tokens|Effort/);
    await answerSend(harness, mail.key, "sent");
    expect(store.client_reports![0]).toMatchObject({ status: "sent" });
    expect(store.client_reports![0]!.sent_at).toBeTruthy();
    expect((await toolRaw(harness, "send-client-report", { client: "company:acme", period: PERIOD })).error).toMatch(/already sent/);
    // A sent report is never rewritten, even when new numbers arrive and it is asked to build again.
    const sentCopy = { markdown: store.client_reports![0]!.markdown, html: store.client_reports![0]!.html, data: JSON.stringify(store.client_reports![0]!.data) };
    await tool(harness, "record-client-signal", { client: "company:acme", module: "social", period: PERIOD, headline: [{ label: "Posts", value: "99" }] });
    const rebuilt = await tool<Record<string, any>>(harness, "build-client-report", { client: "company:acme", period: PERIOD });
    expect(rebuilt).toMatchObject({ alreadySent: true, created: false });
    expect(store.client_reports![0]!.markdown).toBe(sentCopy.markdown);
    expect(store.client_reports![0]!.html).toBe(sentCopy.html);
    expect(JSON.stringify(store.client_reports![0]!.data)).toBe(sentCopy.data);
    expect(store.client_reports![0]!.markdown).not.toContain("Posts: 99");
    expect((await toolRaw(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary })).error).toMatch(/already sent/);
  });

  it("refused by the person: the report goes back to built and the Account Manager is told what to do", async () => {
    const booted = await ready();
    const { harness, store } = booted;
    await tool(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary });
    const sent = await tool<Record<string, any>>(harness, "send-client-report", { client: "company:acme", period: PERIOD });
    await decide(harness, sent.approvalIssueId, "cancelled", "user");
    expect(store.client_reports![0]!.status).toBe("built");
    expect(store.outbox).toHaveLength(0);
    // They can send it again after fixing it: a new approval, attempt two.
    const second = await tool<Record<string, any>>(harness, "send-client-report", { client: "company:acme", period: PERIOD });
    expect(second.approvalIssueId).not.toBe(sent.approvalIssueId);
    expect(store.care_approvals!.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("a canary client's report is a dry run: nothing is queued and the record says so", async () => {
    const booted = await bootCare({ store: reportSeed(), routes: [WORK, COST] });
    const canary = await tool<Record<string, any>>(booted.harness, "create-canary-client", {});
    await tool(booted.harness, "build-client-report", { client: canary.client, period: PERIOD });
    await tool(booted.harness, "set-report-narrative", { client: canary.client, period: PERIOD, summary });
    const sent = await tool<Record<string, any>>(booted.harness, "send-client-report", { client: canary.client, period: PERIOD });
    await decide(booted.harness, sent.approvalIssueId, "done", "user");
    expect(booted.store.outbox).toHaveLength(0);
    expect(booted.store.client_reports![0]).toMatchObject({ status: "dry_run" });
  });

  it("can be skipped with a reason, which the timeline keeps", async () => {
    const booted = await ready();
    expect((await toolRaw(booted.harness, "skip-client-report", { client: "company:acme", period: PERIOD, reason: "no" })).error).toMatch(/at least a sentence/);
    const skipped = await tool<Record<string, any>>(booted.harness, "skip-client-report", { client: "company:acme", period: PERIOD, reason: "New client: the first month had no work to report." });
    expect(skipped.status).toBe("skipped");
    expect(booted.store.client_reports![0]!.status).toBe("skipped");
    expect(booted.store.activities!.some((a) => /report was skipped: New client/.test(a.body))).toBe(true);
    expect((await toolRaw(booted.harness, "send-client-report", { client: "company:acme", period: PERIOD })).error).toMatch(/was skipped/);
  });

  it("skipping a report whose email waits for approval withdraws that approval: a later approval sends nothing and the report stays skipped", async () => {
    const booted = await ready();
    const { harness, store, emit } = booted;
    await tool(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary });
    const sent = await tool<Record<string, any>>(harness, "send-client-report", { client: "company:acme", period: PERIOD });
    expect(store.client_reports![0]!.status).toBe("awaiting_approval");
    await tool(harness, "skip-client-report", { client: "company:acme", period: PERIOD, reason: "The client paused the service this month." });
    expect(store.care_approvals![0]).toMatchObject({ status: "refused", decided_by: "system:report-skipped" });
    expect((await harness.ctx.issues.get(sent.approvalIssueId, CO))!.status).toBe("cancelled");
    await decide(harness, sent.approvalIssueId, "done", "user");
    expect(sentMail(emit)).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
    expect(store.client_reports![0]!.status).toBe("skipped");
  });

  it("a report whose email is already queued in the Mailbox cannot be skipped any more", async () => {
    const booted = await ready();
    const { harness, store, emit } = booted;
    await tool(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary });
    const sent = await tool<Record<string, any>>(harness, "send-client-report", { client: "company:acme", period: PERIOD });
    await decide(harness, sent.approvalIssueId, "done", "user");
    expect(sentMail(emit)).toHaveLength(1);
    expect((await toolRaw(harness, "skip-client-report", { client: "company:acme", period: PERIOD, reason: "Changed my mind about this month." })).error).toMatch(/already approved and queued/);
    expect(store.client_reports![0]!.status).toBe("awaiting_approval");
  });

  it("safety net for a race: a report that was skipped or sent behind the plugin's back is not emailed when its approval is marked done", async () => {
    for (const [status, why] of [["skipped", /was skipped/], ["sent", /already sent/], ["built", /changed after this email was drafted/]] as const) {
      const booted = await ready();
      const { harness, store, emit } = booted;
      await tool(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary });
      const sent = await tool<Record<string, any>>(harness, "send-client-report", { client: "company:acme", period: PERIOD });
      store.client_reports![0]!.status = status;
      await decide(harness, sent.approvalIssueId, "done", "user");
      expect(sentMail(emit), status).toHaveLength(0);
      expect(store.care_approvals![0], status).toMatchObject({ status: "refused", decided_by: "system:action-closed" });
      expect(store.care_approvals![0]!.error, status).toMatch(why);
    }
  });

  it("lists the reports of a client", async () => {
    const booted = await ready();
    const listed = await tool<Record<string, any>>(booted.harness, "list-client-reports", { client: "company:acme" });
    expect(listed.reports).toEqual([expect.objectContaining({ client: "company:acme", period: PERIOD, status: "built", narrativeWritten: false })]);
  });
});

describe("the monthly job", () => {
  const FIRST = new Date("2026-10-01T04:00:00.000Z");

  async function bootJob() {
    const store = reportSeed();
    store.companies = [
      ...store.companies!,
      company("own", "Our Own App", { lifecycle: "customer", tags: ["own-app"] }),
      company("quiet", "Quiet Co", { lifecycle: "customer" }),
    ];
    store.contacts = [...store.contacts!, contact("pat", "Pat Plumber", { emails: ["pat@solo.test"], lifecycle: "customer" })];
    return bootCare({ store, routes: [WORK, COST] });
  }

  it("opens one report issue per customer worth reporting, for the Account Manager, in the client's project, with the numbers gathered", async () => {
    const booted = await bootJob();
    await tool(booted.harness, "create-canary-client", {});
    const run = await runMonthlyReports(booted.harness.ctx, CO, FIRST);
    expect(run).toMatchObject({ opened: 1 });
    const issues = await issuesWith(booted.harness, "crm:client-report:");
    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue).toMatchObject({ assigneeAgentId: "am-1", projectId: "proj-acme", originId: "crm:client-report:company:acme:2026-09", title: "Monthly report Acme Plumbing 2026-09" });
    expect(issue!.description).toContain("The September 2026 report for **Acme Plumbing**");
    expect(issue!.description).toContain("**Not in it yet.");
    expect(issue!.description).toContain("`get-sprint`");
    expect(issue!.description).toContain("`record-client-signal`");
    expect(issue!.description).toContain("`send-client-report`");
    expect(issue!.description).toContain("**Done when** the report was sent after approval, or skipped with a reason");
    expect(booted.store.client_reports![0]).toMatchObject({ period: "2026-09", issue_id: issue!.id });
    // The customers with nothing to report on, the own app and the canary get none.
    const owners = booted.store.client_reports!.map((row) => row.client_ref);
    expect(owners).toEqual(["acme"]);
  });

  it("runs again without a second issue or a second report", async () => {
    const booted = await bootJob();
    await runMonthlyReports(booted.harness.ctx, CO, FIRST);
    await runMonthlyReports(booted.harness.ctx, CO, new Date(FIRST.getTime() + DAY));
    expect(await issuesWith(booted.harness, "crm:client-report:")).toHaveLength(1);
    expect(booted.store.client_reports).toHaveLength(1);
  });

  it("stops at the limit and the next run carries on", async () => {
    const store = reportSeed();
    store.client_profiles = [profile(["seo"]), { ...profile(["seo"]), id: "pr2", client_ref: "pat", client_kind: "contact" }];
    store.contacts = [...store.contacts!, contact("pat", "Pat Plumber", { emails: ["pat@solo.test"], lifecycle: "customer" })];
    const booted = await bootCare({ store, routes: [WORK, COST] });
    expect((await runMonthlyReports(booted.harness.ctx, CO, FIRST, 1)).opened).toBe(1);
    expect((await runMonthlyReports(booted.harness.ctx, CO, FIRST, 1)).opened).toBe(1);
    expect(await issuesWith(booted.harness, "crm:client-report:")).toHaveLength(2);
  });

  it("the 15-minute care job catches up in the first days of the month, and only then", async () => {
    const booted = await bootJob();
    // The booted company has saved settings (the harness config is the saved row).
    const day3 = new Date("2026-10-03T08:05:00.000Z");
    const run = await runClientCareJob(booted.harness.ctx, day3);
    expect(run.reports).toBe(1);
    expect(await issuesWith(booted.harness, "crm:client-report:")).toHaveLength(1);
    const booted2 = await bootJob();
    expect((await runClientCareJob(booted2.harness.ctx, new Date("2026-10-15T08:05:00.000Z"))).reports).toBe(0);
    expect((await runClientCareJob(booted2.harness.ctx, new Date("2026-10-01T04:05:00.000Z"))).reports).toBe(0);
    expect(await issuesWith(booted2.harness, "crm:client-report:")).toHaveLength(0);
  });

  it("runs from the manifest job for companies with saved settings", async () => {
    const booted = await bootJob();
    await booted.harness.runJob("client-report-monthly");
    // The job uses the real clock; whatever month it is, it only opens for customers with something to report.
    const issues = await issuesWith(booted.harness, "crm:client-report:");
    expect(issues.every((issue) => /^crm:client-report:company:acme:\d{4}-\d{2}$/.test(String(issue.originId)))).toBe(true);
  });

  it("only customers with something to report on are worth a report", async () => {
    const booted = await bootJob();
    const info = (kind: "company" | "contact", id: string, name: string, extra: Record<string, unknown> = {}) => ({ key: { kind, id }, name, lifecycle: "customer", tags: [] as string[], custom: {}, website: null, canary: false, ...extra });
    expect(await worthReporting(booted.harness.ctx, CO, info("company", "acme", "Acme"))).toBe(true);
    expect(await worthReporting(booted.harness.ctx, CO, info("company", "quiet", "Quiet"))).toBe(false);
    expect(await worthReporting(booted.harness.ctx, CO, info("company", "acme", "Acme", { tags: ["internal"] }))).toBe(false);
    expect(await worthReporting(booted.harness.ctx, CO, info("company", "acme", "Acme", { canary: true }))).toBe(false);
    await tool(booted.harness, "record-client-signal", { client: "company:quiet", module: "billing", health: { overdueCount: 0 } });
    expect(await worthReporting(booted.harness.ctx, CO, info("company", "quiet", "Quiet"))).toBe(true);
  });
});

describe("customers known only through a project link", () => {
  // Live, 26 of 28 customers have a project link and only one has a service on its profile: a link alone must not open a report for each.
  const AFTER = new Date(Date.parse(periodBounds(PERIOD).to) + 4 * 3_600_000);
  const NO_WORK: Route = [/FROM public\.issues/, () => []];
  const projectOnly = (extra: Record<string, unknown[]> = {}) => careSeed({
    client_projects: [{ id: "cp1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "proj-acme", created_at: "2026-09-01T00:00:00Z" }],
    ...(extra as Record<string, never>),
  });

  it("a month with nothing in it opens no report issue and wakes nobody", async () => {
    const booted = await bootCare({ store: projectOnly(), routes: [NO_WORK, COST] });
    // Acme (a link only) and the sole trader (nothing at all) are both left alone.
    expect(await runMonthlyReports(booted.harness.ctx, CO, AFTER)).toEqual({ built: 0, opened: 0, skipped: 2 });
    expect(await issuesWith(booted.harness, "crm:client-report:")).toHaveLength(0);
    expect(booted.store.client_reports ?? []).toHaveLength(0);
  });

  it("an uptime figure or a logged call alone is not a month worth reporting", async () => {
    const site = { id: "site-1", company_id: CO, client_kind: "company", client_ref: "acme", label: null, url: "https://acme.co.za/", project_id: null, created_at: "2026-09-01T00:00:00Z" };
    const uptime = { id: `site-1:${PERIOD}-10`, site_id: "site-1", company_id: CO, day: `${PERIOD}-10`, checks: 288, failed: 0 };
    const call = { id: "a2", company_id: CO, record_type: "contact", record_id: "ada", kind: "call", body: "Called Ada", created_at: new Date(Date.parse(periodBounds(PERIOD).from) + 3_600_000).toISOString(), meta: null, source_key: "c1", issue_id: null };
    const booted = await bootCare({ store: projectOnly({ client_sites: [site], site_uptime_days: [uptime], activities: [call] }), routes: [NO_WORK, COST] });
    expect(await runMonthlyReports(booted.harness.ctx, CO, AFTER)).toMatchObject({ opened: 0, built: 0 });
    expect(await issuesWith(booted.harness, "crm:client-report:")).toHaveLength(0);
  });

  it("work closed in the client's project that month, a support case, a module's numbers or an enquiry each make the month worth it", async () => {
    const work = await bootCare({ store: projectOnly(), routes: [WORK, COST] });
    expect(await runMonthlyReports(work.harness.ctx, CO, AFTER)).toMatchObject({ opened: 1 });

    const withCase = await bootCare({ store: projectOnly(), routes: [NO_WORK, COST] });
    await tool(withCase.harness, "open-support-case", { client: "company:acme", title: "Form is broken", source: "portal" });
    expect(await runMonthlyReports(withCase.harness.ctx, CO, AFTER)).toMatchObject({ opened: 1 });

    const signal = await bootCare({ store: projectOnly(), routes: [NO_WORK, COST] });
    await tool(signal.harness, "record-client-signal", { ...SEO_SIGNAL, headline: [{ label: "Clicks", value: "10" }] });
    expect(await runMonthlyReports(signal.harness.ctx, CO, AFTER)).toMatchObject({ opened: 1 });

    const mid = new Date(Date.parse(periodBounds(PERIOD).from) + 3_600_000).toISOString();
    const lead = { id: "l1", key: "form:1", company_id: CO, client_kind: "company", client_ref: "acme", source: "form", platform: null, name: "Lead One", handle: null, email: "one@x.test", message: "Quote please", url: null, item_id: null, confidence: null, captured_at: mid, created_at: mid };
    const enquiry = await bootCare({ store: projectOnly({ client_leads: [lead] }), routes: [NO_WORK, COST] });
    expect(await runMonthlyReports(enquiry.harness.ctx, CO, AFTER)).toMatchObject({ opened: 1 });
  });

  it("a service on the profile is always reported, even in a quiet month", async () => {
    const booted = await bootCare({ store: projectOnly({ client_profiles: [profile(["seo"])] }), routes: [NO_WORK, COST] });
    expect(await runMonthlyReports(booted.harness.ctx, CO, AFTER)).toMatchObject({ opened: 1, built: 1 });
  });

  it("the hourly catch-up picks the client up once the month has something in it, not before", async () => {
    const booted = await bootCare({ store: projectOnly(), routes: [NO_WORK, COST] });
    const day2 = new Date(AFTER.getTime() + DAY);
    expect(await runMonthlyReports(booted.harness.ctx, CO, day2)).toMatchObject({ opened: 0 });
    await tool(booted.harness, "record-client-signal", { ...SEO_SIGNAL, headline: [{ label: "Clicks", value: "10" }] });
    expect(await runMonthlyReports(booted.harness.ctx, CO, new Date(day2.getTime() + 3_600_000))).toMatchObject({ opened: 1 });
  });

  it("worthReporting with a period applies the same rule; without one it only asks whether there is a way for numbers to exist", async () => {
    const booted = await bootCare({ store: projectOnly(), routes: [NO_WORK, COST] });
    const acme = { key: { kind: "company" as const, id: "acme" }, name: "Acme", lifecycle: "customer", tags: [] as string[], custom: {}, website: null, canary: false };
    expect(await worthReporting(booted.harness.ctx, CO, acme)).toBe(true);
    expect(await worthReporting(booted.harness.ctx, CO, acme, PERIOD, AFTER)).toBe(false);
  });
});

describe("closing a report issue", () => {
  const originId = `crm:client-report:company:acme:${PERIOD}`;

  it("needs the report sent after approval, or skipped; leaves the issue open while it waits for a person", async () => {
    const booted = await bootReport();
    const { harness } = booted;
    expect(await reportIssueResolved(harness.ctx, CO, originId)).toMatchObject({ done: false });
    await tool(harness, "build-client-report", { client: "company:acme", period: PERIOD });
    const noSummary = await reportIssueResolved(harness.ctx, CO, originId);
    expect((noSummary as { missing: string[] }).missing[0]).toMatch(/no summary and has not been sent/);
    await tool(harness, "set-report-narrative", { client: "company:acme", period: PERIOD, summary: "A steady month with results as expected and nothing to worry about." });
    expect(((await reportIssueResolved(harness.ctx, CO, originId)) as { missing: string[] }).missing[0]).toMatch(/built but not sent/);
    const sent = await tool<Record<string, any>>(harness, "send-client-report", { client: "company:acme", period: PERIOD });
    expect(((await reportIssueResolved(harness.ctx, CO, originId)) as { missing: string[] }).missing[0]).toMatch(/waiting for a person's approval. Leave this issue open/);
    await decide(harness, sent.approvalIssueId, "done", "user");
    await answerSend(harness, `crm:msg:${booted.store.care_approvals![0]!.id}`, "sent");
    expect(await reportIssueResolved(harness.ctx, CO, originId)).toEqual({ done: true });
  });

  it("is done when sent, skipped, or the client is no longer a customer", async () => {
    const booted = await bootReport();
    const { harness, store } = booted;
    await tool(harness, "build-client-report", { client: "company:acme", period: PERIOD });
    await tool(harness, "skip-client-report", { client: "company:acme", period: PERIOD, reason: "Nothing was done for them this month." });
    expect(await reportIssueResolved(harness.ctx, CO, originId)).toEqual({ done: true });
    store.client_reports![0]!.status = "sent";
    expect(await reportIssueResolved(harness.ctx, CO, originId)).toEqual({ done: true });
    store.client_reports![0]!.status = "built";
    store.companies!.find((row) => row.id === "acme")!.lifecycle = "churned";
    expect(await reportIssueResolved(harness.ctx, CO, originId)).toEqual({ done: true });
    expect(await reportIssueResolved(harness.ctx, CO, "crm:client-report:garbage")).toEqual({ done: true });
  });

  it("an agent's early close of the issue is reopened by the kit loop with what is missing", async () => {
    const booted = await bootReport();
    const { harness } = booted;
    await runMonthlyReports(harness.ctx, CO, new Date("2026-10-01T04:00:00.000Z"));
    const [issue] = await issuesWith(harness, "crm:client-report:");
    const reopened = await decide(harness, issue!.id, "done", "agent");
    expect(reopened.status).toBe("todo");
  });
});

describe("the Cockpit", () => {
  it("is quiet until after the 10th, then asks for the reports still not sent", async () => {
    const booted = await bootReport();
    await tool(booted.harness, "build-client-report", { client: "company:acme", period: "2026-09" });
    expect((await reportsHealth(booted.harness.ctx, CO, new Date("2026-10-05T08:00:00Z"))).status).toBe("ok");
    const late = await reportsHealth(booted.harness.ctx, CO, new Date("2026-10-15T08:00:00Z"));
    expect(late).toMatchObject({ key: "client-reports", status: "warn" });
    expect(late.detail).toMatch(/1 September 2026 report is still not sent after the 10th/);
    booted.store.client_reports![0]!.status = "sent";
    expect((await reportsHealth(booted.harness.ctx, CO, new Date("2026-10-15T08:00:00Z"))).status).toBe("ok");
  });
});
