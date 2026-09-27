import { describe, expect, it } from "vitest";
import { monthName, vatCategoryText, vatPeriodState } from "../src/ui/series.js";
import { isView, LEGACY_TABS, resolveView, TAB_SECTIONS, TOP_TABS, VIEW_IDS, viewForTab, type TopTab } from "../src/ui/views.js";

describe("Accounting page tabs and sections", () => {
  it("has five top tabs, each with at least one section", () => {
    expect(TOP_TABS.map((t) => t.id)).toEqual(["overview", "bank", "journals", "reports", "setup"]);
    for (const tab of TOP_TABS) expect(TAB_SECTIONS[tab.id].length, tab.id).toBeGreaterThan(0);
    // Every section is a known ?tab= value and belongs to exactly one tab.
    const all = Object.values(TAB_SECTIONS).flat().map((s) => s.view);
    expect(new Set(all).size).toBe(all.length);
    for (const view of all) expect(VIEW_IDS).toContain(view);
  });

  it("opens every old ?tab= value on the same content (Cockpit, Setup and issue links)", () => {
    const legacy: Record<string, [TopTab, string]> = {
      overview: ["overview", "overview"],
      bank: ["bank", "bank"],
      journals: ["journals", "journals"],
      chart: ["setup", "chart"],
      vat: ["reports", "vat"],
      reports: ["reports", "reports"],
      assets: ["setup", "assets"],
      budgets: ["reports", "budgets"],
      cutover: ["setup", "cutover"],
    };
    expect([...LEGACY_TABS].sort()).toEqual(Object.keys(legacy).sort());
    for (const [value, [tab, section]] of Object.entries(legacy)) expect(resolveView(value), value).toEqual({ tab, section });
  });

  it("opens sections and tabs by id, and anything unknown on the Overview", () => {
    expect(resolveView("drafts")).toEqual({ tab: "journals", section: "drafts" });
    expect(resolveView("rejected")).toEqual({ tab: "journals", section: "rejected" });
    expect(resolveView("periods")).toEqual({ tab: "journals", section: "periods" });
    expect(resolveView("setup")).toEqual({ tab: "setup", section: "chart" });
    expect(resolveView(viewForTab("reports"))).toEqual({ tab: "reports", section: "reports" });
    expect(resolveView("nope")).toEqual({ tab: "overview", section: "overview" });
    expect(resolveView(null)).toEqual({ tab: "overview", section: "overview" });
    expect(isView("cutover")).toBe(true);
    expect(isView("Cut-over")).toBe(false);
    for (const view of VIEW_IDS) {
      const { tab, section } = resolveView(view);
      expect(TAB_SECTIONS[tab].some((s) => s.view === section), view).toBe(true);
    }
  });
});

describe("Accounting page text helpers", () => {
  it("names the year-end month", () => {
    expect(monthName(2)).toBe("February");
    expect(monthName(12)).toBe("December");
    expect(monthName(0)).toBe("");
    expect(monthName(13)).toBe("");
    expect(monthName(null)).toBe("");
  });

  it("describes the VAT category in words", () => {
    expect(vatCategoryText("B")).toBe("Every two months, ending Feb, Apr, Jun, Aug, Oct and Dec");
    expect(vatCategoryText("C")).toBe("Every month");
    expect(vatCategoryText("E", 6)).toBe("Once a year, ending with the financial year in June");
    expect(vatCategoryText("none")).toBe("Not registered for VAT");
  });

  it("gives each VAT period one state: running, to prepare, late, draft, waiting or approved", () => {
    const p = { end: "2026-08-31", current: false, dueDate: "2026-09-30", status: "not_prepared" };
    expect(vatPeriodState({ ...p, current: true, end: "2026-10-31" }, "2026-09-27").key).toBe("running");
    expect(vatPeriodState(p, "2026-09-27")).toEqual({ key: "not_prepared", label: "To prepare" });
    expect(vatPeriodState(p, "2026-10-01")).toEqual({ key: "late", label: "Late: not prepared" });
    expect(vatPeriodState({ ...p, status: "draft" }, "2026-09-27").label).toBe("Draft");
    expect(vatPeriodState({ ...p, status: "pending_approval" }, "2026-10-01").key).toBe("pending_approval");
    expect(vatPeriodState({ ...p, status: "locked" }, "2026-12-01")).toEqual({ key: "locked", label: "Approved" });
  });
});
