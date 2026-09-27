/**
 * How the Cockpit shows other plugins' numbers (pure, no React). Plugins send
 * a KPI as one display string; the Cockpit keeps tiles short and calm:
 * - a packed value ("1 · R 11,500.00 (1 over a day)") becomes the amount,
 *   with the count as the hint ("1 invoice, over a day old");
 * - ISO dates read as "25 Oct";
 * - by default only numbers that are not zero, or that need attention, show;
 * - a tile another tile already states ("Mail sent (7 days)" next to "Mail
 *   sent today · 0 in the last 7 days") is left out.
 */
import { formatShortDate } from "@partnersinbiz/pib-plugin-ui";
import type { KpiEntry } from "../merge.js";

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;

/** ISO dates in a label or value as the shared short date ("2026-10-25" → "25 Oct"). */
export function readableDates(text: string, now: Date = new Date()): string {
  return text.replace(ISO_DATE, (match) => formatShortDate(match, now));
}

const MONEY_START = /^(?:R|ZAR|USD|EUR|GBP|\$|€|£)\s?-?\d/;
const PACKED = /^(\d+)\s*·\s*(.+?)(?:\s*\((\d+) over a day\))?$/;

/** What the counted things are, from the tile's label: "invoice", "quote", "bill" or "item". */
export function kpiNoun(label: string, count: number): string {
  const lower = label.toLowerCase();
  const noun = /quote/.test(lower) ? "quote" : /\bbills?\b/.test(lower) ? "bill" : /draft|invoice|overdue|outstanding/.test(lower) ? "invoice" : "item";
  return count === 1 ? noun : `${noun}s`;
}

/** A tile's value and hint (null when the value needs none). */
export function kpiParts(kpi: Pick<KpiEntry, "label" | "value"> & { hint?: string | null }, now: Date = new Date()): { value: string; hint: string | null } {
  const value = readableDates(kpi.value.trim(), now);
  // A plugin that sends its own hint keeps value and detail apart already.
  if (kpi.hint && kpi.hint.trim()) return { value, hint: readableDates(kpi.hint.trim(), now) };
  const packed = PACKED.exec(value);
  if (packed && MONEY_START.test(packed[2]!.trim())) {
    const count = Number(packed[1]);
    const stale = packed[3] ? Number(packed[3]) : 0;
    const age = stale ? (stale >= count ? (count === 1 ? ", over a day old" : ", all over a day old") : `, ${stale} over a day old`) : "";
    return { value: packed[2]!.trim(), hint: `${count} ${kpiNoun(kpi.label, count)}${age}` };
  }
  return { value, hint: null };
}

const ZERO_TEXT = /^(?:0|0%|none|–|—|-|(?:r|zar|usd|eur|gbp|\$|€|£)\s?0(?:[.,]0+)?)$/i;

/** Zero, none or no data, and nothing to watch: hidden unless every number is shown. */
export function isQuietKpi(kpi: Pick<KpiEntry, "value" | "raw" | "tone">): boolean {
  if (kpi.tone === "warn" || kpi.tone === "bad") return false;
  if (typeof kpi.raw === "number") return kpi.raw === 0;
  return ZERO_TEXT.test(kpi.value.trim().replace(/ /g, " "));
}

function stem(label: string): string {
  return label
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:today|this (?:week|month|year)|(?:last|past) \d+ days?|\d+ days?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Leaves out a tile that another tile of the same plugin already states in its delta. */
export function dedupeKpis<T extends Pick<KpiEntry, "plugin" | "label" | "delta">>(kpis: T[]): T[] {
  return kpis.filter((kpi) => {
    const days = /(\d+)\s*days?/i.exec(kpi.label)?.[1];
    if (!days) return true;
    const period = new RegExp(`\\b${days}\\s*days?\\b`, "i");
    return !kpis.some((other) => other !== kpi && other.plugin === kpi.plugin && typeof other.delta === "string" && period.test(other.delta) && stem(other.label) === stem(kpi.label));
  });
}

/** The tiles a group shows: every number, or (by default) the ones that are not zero or need attention. Never a repeat. */
export function visibleKpis(kpis: KpiEntry[], showAll: boolean): KpiEntry[] {
  const unique = dedupeKpis(kpis);
  return showAll ? unique : unique.filter((kpi) => !isQuietKpi(kpi));
}
