import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MODULES, type SetupStatus } from "../src/kit-setup.js";
import { guidedOrder } from "../src/guide.js";
import { allModulesOn } from "../src/modules.js";
import { planCopy } from "../src/copy.js";
import { CopyPreview, GuideStep, ModuleChecklist, ModulesStep, SetupProgressCard, checklistOrder, groupOpenByDefault, moduleAnchor, pageSummary, resolveModuleViews, setupTabs, sidebarLeft, sourceLine, viewsSummary } from "../src/ui/index.js";
import { clearSharedRequests, reportableStatuses, sharedRequest, type LoadResult } from "../src/ui/data.js";
import { ItemRow, ModuleCard, ProgressOverview, StatusChip, groupState, moduleCounts } from "../src/ui/components.js";
import { finishSetupSummary } from "../src/finish-issue.js";

const linkFor = (href: string) => ({ href: `/PIB${href}` });
const crm: SetupStatus = {
  plugin: "partnersinbiz.crm",
  module: "crm",
  title: "CRM",
  checkedAt: "2026-09-26T10:00:00.000Z",
  items: [
    { key: "settings", title: "Save the plugin settings", status: "done", required: true },
    {
      key: "gmail",
      title: "Connect Gmail",
      status: "missing",
      required: true,
      detail: "Sequences send through the Mailbox.",
      href: "/mailbox",
      hrefLabel: "Open Mailbox",
      steps: ["Open the Mailbox.", "Click Connect."],
      agentNext: "Sends due sequence steps.",
      action: { plugin: "partnersinbiz.crm", key: "crm.connect", label: "Do it for me" },
    },
    { key: "docs", title: "Read the guide", status: "optional", required: false, href: "https://example.com/guide" },
  ],
};
const installed = {
  "partnersinbiz.crm": { id: "crm-id", pluginKey: "partnersinbiz.crm", status: "ready", version: "1", displayName: "CRM", schema: null },
  "partnersinbiz.seo": { id: "seo-id", pluginKey: "partnersinbiz.seo", status: "error", version: "1", displayName: "SEO", schema: null },
  "partnersinbiz.mailbox": { id: "mb-id", pluginKey: "partnersinbiz.mailbox", status: "ready", version: "1", displayName: "Mailbox", schema: null },
};

describe("module views", () => {
  it("prefers the live check, then the stored status, then a stand-in", () => {
    const views = resolveModuleViews({
      modules: { ...allModulesOn(), payroll: false },
      installed,
      live: { "partnersinbiz.crm": { ok: true, status: crm }, "partnersinbiz.mailbox": { ok: false, reason: "no route" } },
      stored: {},
    });
    const by = Object.fromEntries(views.map((view) => [view.pluginKey, view]));
    expect(by["partnersinbiz.crm"]!.source).toBe("live");
    expect(by["partnersinbiz.seo"]!.status?.items[0]!.title).toBe("Update or enable the plugin");
    expect(by["partnersinbiz.mailbox"]!.status?.items[0]).toMatchObject({ title: "Update or enable the plugin", detail: "no route" });
    expect(by["partnersinbiz.social"]!.status?.items[0]!.title).toBe("Install the Social media plugin");
    expect(by["partnersinbiz.payroll"]!).toMatchObject({ enabled: false, status: null });

    const stored = resolveModuleViews({
      modules: null,
      installed,
      live: { "partnersinbiz.crm": { ok: false, reason: "timeout" } },
      stored: { "partnersinbiz.crm": { status: crm, receivedAt: "2026-09-26T09:00:00.000Z" } },
    }).find((view) => view.pluginKey === "partnersinbiz.crm")!;
    expect(stored).toMatchObject({ source: "stored", note: "timeout", receivedAt: "2026-09-26T09:00:00.000Z" });
  });
});

describe("setup UI render", () => {
  it("renders the module cards with installed state and the CRM hint", () => {
    const html = renderToStaticMarkup(createElement(ModulesStep, {
      draft: { ...allModulesOn(), crm: false },
      installed,
      firstVisit: true,
      dirty: false,
      busy: false,
      onChange: () => undefined,
      onSave: () => undefined,
    }));
    for (const module of Object.values(MODULES)) expect(html).toContain(module.title.replace(/&/g, "&amp;"));
    expect(html).toContain("Save and continue");
    expect(html).toContain("Not installed");
    expect(html).toContain("take their clients from the CRM");
    expect(html).toContain('role="switch"');
  });

  it("renders a module as one line that opens to its steps: steps left first, optional and done folded", () => {
    const view = { module: "crm" as const, pluginKey: "partnersinbiz.crm", enabled: true, installed: installed["partnersinbiz.crm"], status: crm, source: "live" as const, receivedAt: null, note: null };
    const html = renderToStaticMarkup(createElement(ModuleChecklist, { view, checking: false, linkFor, busy: null, open: true, onRecheck: () => undefined, onAction: () => undefined }));
    expect(html).toContain('id="module-crm"');
    expect(html).toContain("1 of 2 required done");
    expect(html).toContain("1 step left");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('href="/PIB/mailbox"');
    expect(html).toContain('href="https://example.com/guide" target="_blank"');
    expect(html).toContain("How to do it (2 steps)");
    expect(html).toContain("Click Connect.");
    expect(html).toContain("Once done, the agent: </span>Sends due sequence steps.");
    expect(html).toContain("Do it for me");
    expect(html).toContain("1 optional step (nice to have)");
    expect(html).toContain("1 done");
    expect(html).toContain("Checked just now.");
    expect(html.indexOf("Connect Gmail")).toBeLessThan(html.indexOf("Save the plugin settings"));
    // Folded: one line, no steps.
    const folded = renderToStaticMarkup(createElement(ModuleChecklist, { view, checking: false, linkFor, busy: null, open: false, onRecheck: () => undefined, onAction: () => undefined }));
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).not.toContain("Connect Gmail");
  });

  it("renders step text as text: **bold**, `code` and links, never the raw markdown", () => {
    const html = renderToStaticMarkup(createElement(ItemRow, {
      item: { key: "sa", title: "Add the **Google** key", status: "missing", required: true, detail: "Paste it into `SEO_GOOGLE_SERVICE_ACCOUNT`.", steps: ["In Google Cloud, click **Create service account**.", "Copy `client_email` into [Settings](/company/settings)."] },
      linkFor,
    }));
    expect(html).toContain("<strong");
    expect(html).toContain(">Create service account</strong>");
    expect(html).toContain(">SEO_GOOGLE_SERVICE_ACCOUNT</code>");
    expect(html).toContain('href="/PIB/company/settings"');
    expect(html).not.toContain("**");
    expect(html).not.toContain("`");
  });

  it("says where a status came from, with a readable date and the raw reason under Details", () => {
    expect(sourceLine({ source: "live", receivedAt: null, note: null })).toBe("Checked just now.");
    expect(sourceLine({ source: "stored", receivedAt: "2026-09-26T09:00:00.000Z", note: "timeout" })).toMatch(/^Last reported 26 Sep 2026, \d\d:\d\d; the live check did not answer\.$/);
    const view = { module: "crm" as const, pluginKey: "partnersinbiz.crm", enabled: true, installed: installed["partnersinbiz.crm"], status: crm, source: "stored" as const, receivedAt: "2026-09-26T09:00:00.000Z", note: "fetch failed: ECONNRESET" };
    const html = renderToStaticMarkup(createElement(ModuleChecklist, { view, checking: false, linkFor, busy: null, open: true, onRecheck: () => undefined, onAction: () => undefined }));
    expect(html).toContain("<summary");
    expect(html).toContain("Details</summary>");
    expect(html).toContain("fetch failed: ECONNRESET");
    expect(html).not.toContain("2026-09-26T09");
  });

  it("renders a guided step", () => {
    const [entry] = guidedOrder([{ module: "crm", pluginKey: "partnersinbiz.crm", status: crm }]);
    const html = renderToStaticMarkup(createElement(GuideStep, { entry: entry!, linkFor, busy: false, checking: false, note: "", onAction: () => undefined, onCheck: () => undefined, onSkip: () => undefined }));
    expect(html).toContain("Step 3 · Keys and connections");
    expect(html).toContain("I did it — check again");
    expect(html).toContain("Skip for now");
    expect(html).toContain('href="/PIB/mailbox"');
  });

  it("previews a copy without secrets", () => {
    const plan = planCopy({ source: { timezone: "UTC", apiKey: { type: "secret_ref", secretId: "s" } }, target: {}, schema: { properties: { apiKey: { title: "API key", format: "secret-ref" } } } });
    const html = renderToStaticMarkup(createElement(CopyPreview, { row: { plugin: installed["partnersinbiz.crm"], module: "crm", sourceSaved: true, plan, error: null, include: true }, onToggle: () => undefined }));
    expect(html).toContain("<code>timezone</code> = UTC");
    expect(html).toContain("Not copied (secrets): apiKey");
    expect(html).toContain("Pick afterwards: API key");
    expect(html).not.toContain("secret_ref");
  });

  it("shows the widget until everything required is done, with the one count", () => {
    const load: LoadResult = { modules: { crm: true, cockpit: false, memory: false, mailbox: false, social: false, seo: false, campaigns: false, billing: false, accounting: false, payroll: false, partners: false }, updatedAt: "x", updatedBy: "u", statuses: {}, finishIssueId: null, settingsSaved: true, installed: null };
    const views = resolveModuleViews({ modules: load.modules, installed, live: { "partnersinbiz.crm": { ok: true, status: crm } }, stored: {} });
    const html = renderToStaticMarkup(createElement(SetupProgressCard, { data: { load, views }, linkFor }));
    expect(html).toContain("Setup progress");
    expect(html).toContain("Continue setup");
    expect(html).toContain("1 step left");
    expect(html).toContain("1 of 2 required done");
    expect(html).toContain("+ 1 optional");
    const done = { ...crm, items: crm.items.map((entry) => ({ ...entry, status: "done" as const })) };
    const doneViews = resolveModuleViews({ modules: load.modules, installed, live: { "partnersinbiz.crm": { ok: true, status: done } }, stored: {} });
    expect(renderToStaticMarkup(createElement(SetupProgressCard, { data: { load, views: doneViews }, linkFor }))).toBe("");
    const first = renderToStaticMarkup(createElement(SetupProgressCard, { data: { load: { ...load, modules: null }, views: [] }, linkFor }));
    expect(first).toContain("Start setup");
  });

  it("colours progress by module and item status by tone, and leads with the steps left", () => {
    const html = renderToStaticMarkup(createElement(ProgressOverview, { summary: { requiredDone: 1, requiredTotal: 3, requiredLeft: 2, optionalLeft: 13 }, modules: [{ key: "crm", module: "crm", ...moduleCounts(crm) }, { key: "seo", module: "seo", done: null, total: null }], onOpen: () => undefined }));
    expect(html).toContain("2 steps left");
    expect(html).toContain("1 of 3 required steps done");
    expect(html).toContain("+ 13 optional");
    expect(html).toContain('aria-label="Required setup steps done"');
    expect(html).toContain("--pib-accent-crm");
    expect(html).toContain("1/2");
    expect(html).toContain("checking…");
    // A module row opens that module on the checklist.
    expect(html).toContain('aria-label="CRM: open on the checklist"');
    // Phones: no per-module rows.
    expect(renderToStaticMarkup(createElement(ProgressOverview, { summary: { requiredDone: 1, requiredTotal: 3, requiredLeft: 2, optionalLeft: 0 }, modules: [{ key: "crm", module: "crm", ...moduleCounts(crm) }], compact: true }))).not.toContain("1/2");
    expect(renderToStaticMarkup(createElement(StatusChip, { status: "missing" }))).toContain("var(--pib-bad-fg");
    expect(renderToStaticMarkup(createElement(StatusChip, { status: "done" }))).toContain("var(--pib-ok-fg");
    const card = renderToStaticMarkup(createElement(ModuleCard, { title: "Billing", description: "d", installed: false, enabled: true, onToggle: () => undefined, module: "billing" }));
    expect(card).toContain("--pib-accent-billing");
    expect(card).toContain("Not installed");
  });
});

describe("one setup count everywhere", () => {
  const modules = { ...allModulesOn(), seo: false };

  it("the page counts what the sidebar, the Finish setup issue and the Cockpit count", () => {
    const stored = { "partnersinbiz.crm": { status: crm, receivedAt: "2026-09-26T09:00:00.000Z" } };
    // Mailbox is installed but its live check did not answer and it never reported: one step on both sides.
    const views = resolveModuleViews({ modules, installed, live: { "partnersinbiz.mailbox": { ok: false, reason: "no route" } }, stored });
    const page = viewsSummary(views, modules)!;
    const worker = finishSetupSummary({ modules, statuses: { "partnersinbiz.crm": crm }, installed: Object.fromEntries(Object.entries(installed).map(([k, v]) => [k, { id: v.id, status: v.status }])) });
    expect(page).toEqual(worker);
    // Switched-off SEO is not counted; not-installed modules count one step each (install, or switch off).
    expect(page.requiredLeft).toBe(10);
    // Still checking a module: no live count yet, so the stored one shows.
    const checking = resolveModuleViews({ modules, installed: null, live: {}, stored: {} });
    expect(viewsSummary(checking, modules)).toBeNull();
    expect(pageSummary(checking, { modules, summary: worker })).toEqual({ summary: worker, checking: true });
    expect(pageSummary(views, { modules, summary: null })).toEqual({ summary: page, checking: false });
  });

  it("the sidebar badge uses the worker's count, or works it out the same way", () => {
    expect(sidebarLeft({ modules, summary: { requiredDone: 3, requiredTotal: 19, requiredLeft: 16, optionalLeft: 13 } })).toBe(16);
    expect(sidebarLeft({ modules: null })).toBeNull();
    const derived = sidebarLeft({ modules: { ...Object.fromEntries(Object.keys(modules).map((k) => [k, false])), crm: true }, statuses: { "partnersinbiz.crm": { status: crm, receivedAt: "x" } }, installed: null });
    expect(derived).toBe(1);
  });

  it("reports only the PiB statuses the page checked live", () => {
    expect(reportableStatuses({ "partnersinbiz.crm": { ok: true, status: crm }, "partnersinbiz.seo": { ok: false, reason: "x" }, "paperclipai.plugin-llm-wiki": { ok: true, status: crm } })).toEqual({ "partnersinbiz.crm": crm });
  });

  it("sends the same request once when the page, the widget and StrictMode ask together", async () => {
    clearSharedRequests();
    let calls = 0;
    const run = async () => ++calls;
    let now = 1000;
    const clock = () => now;
    expect(await Promise.all([sharedRequest("k", run, false, clock), sharedRequest("k", run, false, clock)])).toEqual([1, 1]);
    now += 5000;
    expect(await sharedRequest("k", run, false, clock)).toBe(2);
    expect(await sharedRequest("k", run, true, clock)).toBe(3);
  });
});

describe("page layout", () => {
  it("puts Team first once the modules are chosen, then the checklist and the modules", () => {
    expect(setupTabs({ firstVisit: false, showTeam: true, requested: null })).toEqual({ ids: ["team", "checklist", "modules"], active: "team" });
    expect(setupTabs({ firstVisit: false, showTeam: true, requested: "checklist" }).active).toBe("checklist");
    expect(setupTabs({ firstVisit: false, showTeam: false, requested: "team" })).toEqual({ ids: ["checklist", "modules"], active: "checklist" });
    expect(setupTabs({ firstVisit: true, showTeam: false, requested: "checklist" })).toEqual({ ids: ["modules"], active: "modules" });
    expect(moduleAnchor("#module-seo")).toBe("seo");
    expect(moduleAnchor("#team-operator")).toBeNull();
    expect(moduleAnchor("#module-nope")).toBeNull();
  });

  it("lists modules with steps left first and folds finished ones (all of them on a phone)", () => {
    const done = { ...crm, plugin: "partnersinbiz.partners", module: "partners" as const, items: crm.items.map((entry) => ({ ...entry, status: "done" as const })) };
    const views = resolveModuleViews({ modules: { ...allModulesOn() }, installed: null, live: { "partnersinbiz.partners": { ok: true, status: done }, "partnersinbiz.crm": { ok: true, status: crm } }, stored: {} })
      .filter((view) => view.pluginKey === "partnersinbiz.partners" || view.pluginKey === "partnersinbiz.crm");
    const partnersFirst = [views.find((v) => v.pluginKey === "partnersinbiz.partners")!, views.find((v) => v.pluginKey === "partnersinbiz.crm")!];
    expect(checklistOrder(partnersFirst).map((v) => v.pluginKey)).toEqual(["partnersinbiz.crm", "partnersinbiz.partners"]);
    const ordered = checklistOrder(partnersFirst);
    // Only the next module to work on opens by itself (never on a phone).
    expect(groupOpenByDefault(ordered[0]!, false, ordered)).toBe(true);
    expect(groupOpenByDefault(ordered[1]!, false, ordered)).toBe(false);
    expect(groupOpenByDefault(ordered[0]!, true, ordered)).toBe(false);
    expect(groupState(crm.items)).toMatchObject({ left: 1, label: "1 step left" });
    expect(groupState(done.items)).toMatchObject({ left: 0, label: "Done" });
  });
});
