import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { errorText,
  BarChart,
  DonutChart,
  KpiCard,
  PageHeader,
  PluginThemeProvider,
  ProgressBar,
  ProgressRing,
  Sparkline,
  StackedBar,
  StatusDot,
  THEME_CSS,
  Timeline,
  TrendChart,
  budgetTone,
  deltaDirection,
  formatDelta,
  moduleAccent,
  relativeTime,
  tone,
  toneName,
} from "@partnersinbiz/pib-plugin-ui";
import { healthCounts, lastDays, runColumns, runsPerDay } from "../src/ui/series.js";
import { KIND_TONE } from "../src/ui/components.js";

const NOW = new Date("2026-09-26T10:00:00.000Z");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("pib-plugin-ui palette", () => {
  it("resolves tones and aliases to CSS variables with fallbacks", () => {
    expect(tone("ok").solid).toBe("var(--pib-ok, #16a34a)");
    expect(tone("warning").name).toBe("warn");
    expect(tone("error").name).toBe("bad");
    expect(toneName("nonsense")).toBe("neutral");
    expect(tone(undefined).name).toBe("neutral");
  });

  it("defines light and dark tokens that follow the host's status colours and .dark class", () => {
    expect(THEME_CSS).toContain("--pib-ok:var(--status-task-icon-done, #16a34a)");
    expect(THEME_CSS).toContain("--pib-bad:var(--status-task-icon-blocked, #dc2626)");
    expect(THEME_CSS).toMatch(/\.dark,\[data-theme="dark"\]\{[^}]*--pib-ink:white/);
    expect(THEME_CSS).toContain("--pib-accent-social:#e11d48");
    expect(THEME_CSS).toContain("--pib-accent-social:#fb7185");
  });

  it("gives every module an accent and icon, accepting plugin keys", () => {
    expect(moduleAccent("partnersinbiz.billing").key).toBe("billing");
    expect(moduleAccent("crm").solid).toContain("--pib-accent-crm");
    expect(moduleAccent("unknown").key).toBeNull();
    const header = html(createElement(PluginThemeProvider, { accent: "seo", children: createElement(PageHeader, { title: "SEO", description: "d" }) }));
    expect(header).toContain("--pib-accent:var(--pib-accent-seo, #16a34a)");
    expect(header).toContain("<svg");
  });
});

describe("pib-plugin-ui components", () => {
  it("keeps the old horizontal BarChart API and adds stacked columns", () => {
    const list = html(createElement(BarChart, { title: "Invoices by status", items: [{ label: "paid", value: 3 }, { label: "overdue", value: 1 }] }));
    expect(list).toContain("Invoices by status");
    expect(list).toContain('role="img"');
    const cols = html(createElement(BarChart, {
      title: "Runs",
      unit: "runs",
      data: [{ label: "9/25", values: { ok: 2, bad: 1 } }, { label: "9/26", values: { ok: 4, bad: 0 } }],
      series: [{ key: "ok", label: "Succeeded", tone: "ok" }, { key: "bad", label: "Failed", tone: "bad" }],
    }));
    expect(cols).toContain("Runs: 7 runs over 2 periods; highest 9/26 with 4 runs. Succeeded 6, Failed 1.");
    expect(cols).toContain("Succeeded");
    expect(cols).toContain("var(--pib-bad, #dc2626)");
    expect(html(createElement(BarChart, { data: [], title: "Runs", emptyText: "No runs." }))).toContain("No runs.");
  });

  it("renders KPI cards with toned deltas and links", () => {
    expect(deltaDirection("+12% vs last week")).toBe("up");
    expect(deltaDirection(-3)).toBe("down");
    expect(formatDelta("-6% vs last month")).toBe("▼ 6% vs last month");
    const card = html(createElement(KpiCard, { label: "Cash", value: "R 1", delta: "+4%", link: { href: "/PIB/accounting" }, sparkline: [1, 3, 2, 5] }));
    expect(card).toContain('href="/PIB/accounting"');
    expect(card).toContain("▲ 4%");
    expect(card).toContain("var(--pib-ok-fg");
    const costs = html(createElement(KpiCard, { label: "Costs", value: "R 9", delta: "+4%", invert: true }));
    expect(costs).toContain("var(--pib-bad-fg");
  });

  it("colours progress by budget and exposes progress semantics", () => {
    expect(budgetTone(0.5)).toBe("ok");
    expect(budgetTone(0.85)).toBe("warn");
    expect(budgetTone(1.2)).toBe("bad");
    const bar = html(createElement(ProgressBar, { value: 1.2, tone: "budget", ariaLabel: "Budget" }));
    expect(bar).toContain('aria-valuenow="100"');
    expect(bar).toContain("var(--pib-bad, #dc2626)");
    expect(html(createElement(ProgressRing, { done: 3, total: 4, label: "Setup" }))).toContain("75%");
  });

  it("renders the other charts and a timeline with relative times", () => {
    expect(html(createElement(StackedBar, { title: "Ageing", segments: [{ label: "Current", value: 3, tone: "ok" }, { label: "90+", value: 1, tone: "bad" }] }))).toContain("Ageing: Current 3 (75%), 90+ 1 (25%)");
    expect(html(createElement(DonutChart, { segments: [{ label: "A", value: 1 }], centerValue: "1" }))).toContain("<circle");
    expect(html(createElement(TrendChart, { data: [{ label: "Mon", value: 1 }, { label: "Tue", value: 4 }], title: "Clicks" }))).toContain("Clicks: Clicks from 1 to 4");
    expect(html(createElement(Sparkline, { values: [1] }))).toBe("");
    expect(html(createElement(StatusDot, { tone: "info", pulse: true, label: "Running" }))).toContain('class="pib-pulse"');
    expect(relativeTime("2026-09-26T07:00:00.000Z", NOW)).toBe("3h ago");
    expect(relativeTime("bad", NOW)).toBeNull();
    const feed = html(createElement(Timeline, { items: [{ at: "2026-09-26T09:30:00.000Z", title: "Posted JNL-1", tone: "ok" }, { at: null, title: "Second" }], now: NOW, limit: 1 }));
    expect(feed).toContain("30m ago");
    expect(feed).toContain("And 1 more.");
  });
});

describe("Cockpit series", () => {
  it("buckets runs per UTC day like the host chart", () => {
    expect(lastDays(NOW, 3)).toEqual(["2026-09-24", "2026-09-25", "2026-09-26"]);
    const days = runsPerDay([
      { agentId: "a", status: "succeeded", startedAt: "2026-09-26T08:00:00.000Z" },
      { agentId: "a", status: "timed_out", startedAt: "2026-09-26T09:00:00.000Z" },
      { agentId: "a", status: "running", startedAt: "2026-09-25T09:00:00.000Z" },
      { agentId: "a", status: "succeeded", startedAt: "2026-08-01T09:00:00.000Z" },
      { agentId: "a", status: "succeeded", startedAt: null },
    ], NOW, 14);
    expect(days).toHaveLength(14);
    expect(days[13]).toEqual({ date: "2026-09-26", succeeded: 1, failed: 1, other: 0, total: 2 });
    expect(days[12]!.other).toBe(1);
    // The shared short date ("26 Sep"), never US month/day.
    expect(runColumns(days, new Date("2026-09-26T10:00:00.000Z"))[13]).toMatchObject({ label: "26 Sep", title: "Sat 26 Sep", values: { succeeded: 1, failed: 1, other: 0 } });
    expect(runColumns(days, new Date("2027-01-05T10:00:00.000Z"))[13]!.label).toBe("26 Sep 2026");
  });

  it("counts health checks per status and tones waiting kinds", () => {
    const counts = healthCounts([{ plugin: "x", title: "X", status: "bad", checks: [{ key: "a", title: "A", status: "bad", plugin: "x", pluginTitle: "X" }, { key: "b", title: "B", status: "ok", plugin: "x", pluginTitle: "X" }] }]);
    expect(counts).toEqual({ ok: 1, warn: 0, bad: 1 });
    expect(KIND_TONE.money).toBe("bad");
    expect(KIND_TONE.legal).toBe("warn");
    expect(KIND_TONE.grant).toBe("info");
  });
});

describe("errorText", () => {
  it("reads the host's plain { code, message } action errors, not just Error objects", () => {
    expect(errorText(new Error("Boom"))).toBe("Boom");
    expect(errorText({ code: "UNKNOWN", message: "Only rules and warnings can be pinned." })).toBe("Only rules and warnings can be pinned.");
    expect(errorText({ error: "Not allowed" })).toBe("Not allowed");
    expect(errorText({ error: { message: "Nested" } })).toBe("Nested");
    expect(errorText("Plain text")).toBe("Plain text");
    expect(errorText(null)).toBe("Request failed");
    expect(errorText({})).toBe("Request failed");
  });
});

