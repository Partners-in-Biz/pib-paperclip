import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MODULES, type SetupStatus } from "../src/kit-setup.js";
import { guidedOrder } from "../src/guide.js";
import { allModulesOn } from "../src/modules.js";
import { planCopy } from "../src/copy.js";
import { CopyPreview, GuideStep, ModuleChecklist, ModulesStep, SetupProgressCard, resolveModuleViews } from "../src/ui/index.js";
import type { LoadResult } from "../src/ui/data.js";

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

  it("renders a module checklist with chips, deep links, steps, agent next and Do it for me", () => {
    const html = renderToStaticMarkup(createElement(ModuleChecklist, {
      view: { module: "crm", pluginKey: "partnersinbiz.crm", enabled: true, installed: installed["partnersinbiz.crm"], status: crm, source: "live", receivedAt: null, note: null },
      checking: false,
      linkFor,
      busy: null,
      onRecheck: () => undefined,
      onAction: () => undefined,
    }));
    expect(html).toContain("CRM · 1 of 2");
    expect(html).toContain("Missing");
    expect(html).toContain('href="/PIB/mailbox"');
    expect(html).toContain('href="https://example.com/guide" target="_blank"');
    expect(html).toContain("Click Connect.");
    expect(html).toContain("Once done, the agent: </span>Sends due sequence steps.");
    expect(html).toContain("Do it for me");
    expect(html.indexOf("Connect Gmail")).toBeLessThan(html.indexOf("Save the plugin settings"));
  });

  it("renders a guided step", () => {
    const [entry] = guidedOrder([{ module: "crm", pluginKey: "partnersinbiz.crm", status: crm }]);
    const html = renderToStaticMarkup(createElement(GuideStep, { entry: entry!, linkFor, busy: false, checking: false, note: "", onAction: () => undefined, onCheck: () => undefined, onSkip: () => undefined }));
    expect(html).toContain("Keys and connections");
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

  it("shows the widget until everything required is done", () => {
    const load: LoadResult = { modules: { crm: true, cockpit: false, mailbox: false, social: false, seo: false, campaigns: false, billing: false, accounting: false, payroll: false, partners: false }, updatedAt: "x", updatedBy: "u", statuses: {}, finishIssueId: null, settingsSaved: true, installed: null };
    const views = resolveModuleViews({ modules: load.modules, installed, live: { "partnersinbiz.crm": { ok: true, status: crm } }, stored: {} });
    const html = renderToStaticMarkup(createElement(SetupProgressCard, { data: { load, views }, linkFor }));
    expect(html).toContain("Setup progress");
    expect(html).toContain("Continue setup");
    expect(html).toContain("1 of 2");
    const done = { ...crm, items: crm.items.map((entry) => ({ ...entry, status: "done" as const })) };
    const doneViews = resolveModuleViews({ modules: load.modules, installed, live: { "partnersinbiz.crm": { ok: true, status: done } }, stored: {} });
    expect(renderToStaticMarkup(createElement(SetupProgressCard, { data: { load, views: doneViews }, linkFor }))).toBe("");
    const first = renderToStaticMarkup(createElement(SetupProgressCard, { data: { load: { ...load, modules: null }, views: [] }, linkFor }));
    expect(first).toContain("Start setup");
  });
});
