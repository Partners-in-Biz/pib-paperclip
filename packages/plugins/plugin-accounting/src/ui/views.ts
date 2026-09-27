/**
 * The Accounting page's tabs and sections (pure, so it can be unit tested).
 *
 * Five top tabs, each with sections, so a phone shows the tabs that matter
 * instead of three of nine. The address keeps one `?tab=` value: a tab
 * (`reports`) or a section (`vat`). Every tab the page had before (overview,
 * bank, journals, chart, vat, reports, assets, budgets, cutover) is still a
 * valid value and opens the same content, so Cockpit, Setup and issue links
 * keep working, and the Overview's `onOpen("vat")` still lands on VAT.
 */

export type TopTab = "overview" | "bank" | "journals" | "reports" | "setup";

export type View =
  | "overview"
  | "bank"
  | "journals"
  | "drafts"
  | "rejected"
  | "periods"
  | "reports"
  | "vat"
  | "budgets"
  | "setup"
  | "chart"
  | "cutover"
  | "assets";

export const VIEW_IDS: readonly View[] = ["overview", "bank", "journals", "drafts", "rejected", "periods", "reports", "vat", "budgets", "setup", "chart", "cutover", "assets"];

/** The `?tab=` values the page had before the tabs were grouped (links in the Cockpit, Setup and issues use them). */
export const LEGACY_TABS: readonly View[] = ["overview", "bank", "journals", "chart", "vat", "reports", "assets", "budgets", "cutover"];

export interface SectionDef {
  view: View;
  label: string;
}

/** Each top tab's sections, the first being where the tab opens. A tab with one section shows no section row. */
export const TAB_SECTIONS: Record<TopTab, SectionDef[]> = {
  overview: [{ view: "overview", label: "Overview" }],
  bank: [{ view: "bank", label: "Bank" }],
  journals: [
    { view: "journals", label: "Journals" },
    { view: "drafts", label: "Drafts" },
    { view: "rejected", label: "Rejected" },
    { view: "periods", label: "Periods" },
  ],
  reports: [
    { view: "reports", label: "Reports" },
    { view: "vat", label: "VAT" },
    { view: "budgets", label: "Budgets & forecast" },
  ],
  setup: [
    { view: "chart", label: "Chart & roles" },
    { view: "cutover", label: "Cut-over" },
    { view: "assets", label: "Assets & exchange rates" },
  ],
};

export const TOP_TABS: Array<{ id: TopTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "bank", label: "Bank" },
  { id: "journals", label: "Journals" },
  { id: "reports", label: "Reports & VAT" },
  { id: "setup", label: "Books setup" },
];

const TAB_OF: Record<View, TopTab> = {
  overview: "overview",
  bank: "bank",
  journals: "journals",
  drafts: "journals",
  rejected: "journals",
  periods: "journals",
  reports: "reports",
  vat: "reports",
  budgets: "reports",
  setup: "setup",
  chart: "setup",
  cutover: "setup",
  assets: "setup",
};

export function isView(value: string | null | undefined): value is View {
  return (VIEW_IDS as readonly string[]).includes(value ?? "");
}

/** Which tab and section a `?tab=` value (or an Overview `onOpen` id) opens; anything unknown is the Overview. */
export function resolveView(value: string | null | undefined): { tab: TopTab; section: View } {
  if (!isView(value)) return { tab: "overview", section: "overview" };
  const tab = TAB_OF[value];
  const sections = TAB_SECTIONS[tab];
  const section = sections.some((s) => s.view === value) ? value : sections[0]!.view;
  return { tab, section };
}

/** `?tab=` value that opens a tab at its first section (the tab id itself). */
export function viewForTab(tab: TopTab): View {
  return tab;
}
