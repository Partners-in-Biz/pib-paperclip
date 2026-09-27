/**
 * The Billing page's tabs and sections (pure, so it can be unit tested).
 *
 * Six top tabs at most, each with sections. The address keeps one `?tab=`
 * value: a tab (`invoices`) or a section (`payments`). Every tab the page had
 * before 0.4 is still a valid value and opens the same content, so Cockpit
 * and issue links keep working.
 */

export type TopTab = "overview" | "invoices" | "quotes" | "recurring" | "costs" | "time";

export type View =
  | "overview"
  | "reports"
  | "invoices"
  | "payments"
  | "credit-notes"
  | "reminders"
  | "quotes"
  | "recurring"
  | "retainers"
  | "repeating"
  | "costs"
  | "bills"
  | "expenses"
  | "time";

export const VIEW_IDS: readonly View[] = [
  "overview", "reports", "invoices", "payments", "credit-notes", "reminders", "quotes", "recurring", "retainers", "repeating", "costs", "bills", "expenses", "time",
];

export interface SectionDef {
  view: View;
  label: string;
  /** Only in PiB's own book (not in a client's workspace). */
  ownOnly?: boolean;
}

/** Each top tab's sections, the first being where the tab opens. */
export const TAB_SECTIONS: Record<TopTab, SectionDef[]> = {
  overview: [{ view: "overview", label: "Summary" }, { view: "reports", label: "Reports", ownOnly: true }],
  invoices: [
    { view: "invoices", label: "Invoices" },
    { view: "payments", label: "Payments" },
    { view: "credit-notes", label: "Credit notes" },
    { view: "reminders", label: "Reminders", ownOnly: true },
  ],
  quotes: [{ view: "quotes", label: "Quotes" }],
  recurring: [{ view: "retainers", label: "Retainers" }, { view: "repeating", label: "Repeating invoices" }],
  costs: [{ view: "bills", label: "Bills" }, { view: "expenses", label: "Expenses" }],
  time: [{ view: "time", label: "Time" }],
};

/** Tabs in order; `costs` (bills and expenses) is PiB's own and hidden in a client's workspace. */
export const TOP_TABS: Array<{ id: TopTab; label: string; ownOnly?: boolean }> = [
  { id: "overview", label: "Overview" },
  { id: "invoices", label: "Invoices" },
  { id: "quotes", label: "Quotes" },
  { id: "recurring", label: "Recurring" },
  { id: "costs", label: "Costs", ownOnly: true },
  { id: "time", label: "Time" },
];

const TAB_OF: Record<View, TopTab> = {
  overview: "overview",
  reports: "overview",
  invoices: "invoices",
  payments: "invoices",
  "credit-notes": "invoices",
  reminders: "invoices",
  quotes: "quotes",
  recurring: "recurring",
  retainers: "recurring",
  repeating: "recurring",
  costs: "costs",
  bills: "costs",
  expenses: "costs",
  time: "time",
};

/**
 * Which tab and section a `?tab=` value opens. A client's workspace has no
 * reports, reminders, bills or expenses: those land on the nearest tab that
 * exists there.
 */
export function resolveView(view: View, scoped: boolean): { tab: TopTab; section: View } {
  let tab = TAB_OF[view] ?? "overview";
  let section: View = view === "recurring" ? "retainers" : view === "costs" ? "bills" : view;
  if (scoped) {
    const top = TOP_TABS.find((t) => t.id === tab);
    if (top?.ownOnly) return { tab: "overview", section: "overview" };
    const def = TAB_SECTIONS[tab].find((s) => s.view === section);
    if (def?.ownOnly) section = TAB_SECTIONS[tab][0]!.view;
  }
  if (!TAB_SECTIONS[tab].some((s) => s.view === section)) section = TAB_SECTIONS[tab][0]!.view;
  return { tab, section };
}

/** The sections a tab shows in this mode. */
export function sectionsFor(tab: TopTab, scoped: boolean): SectionDef[] {
  return TAB_SECTIONS[tab].filter((s) => !(scoped && s.ownOnly));
}

/** Tabs shown in this mode. */
export function tabsFor(scoped: boolean): TopTab[] {
  return TOP_TABS.filter((t) => !(scoped && t.ownOnly)).map((t) => t.id);
}

/** `?tab=` value that opens a tab at its first section (the tab id itself). */
export function viewForTab(tab: TopTab): View {
  return tab;
}

/**
 * Which new-document form a deep link opens: `?tab=quotes&new=1` a quote,
 * `?tab=invoices&new=1` an invoice (the CRM deal drawer's "Draft a quote"
 * adds `client=company:<id>` or `contact:<id>` and `dealId=<id>`).
 */
export function openFormFor(tab: string | null): "invoice" | "quote" | null {
  return tab === "quotes" ? "quote" : tab === "invoices" ? "invoice" : null;
}
