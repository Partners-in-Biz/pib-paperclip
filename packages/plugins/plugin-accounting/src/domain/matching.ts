/**
 * Bank rules and deterministic matching. Nothing here posts or pays: it
 * produces suggestions a person (or, when the setting allows, the
 * Bookkeeper) accepts.
 *
 * - Money in ↔ open receivables, money out ↔ open payables:
 *   `exact` = same amount and the invoice/bill number or a reference appears
 *   in the bank line; `amount` = same amount only; `reference` = the number
 *   appears but the amount differs (a part payment, confirmed by a person).
 * - ↔ journals already on the bank account (e.g. a payment Billing posted
 *   from a proof of payment) with the same amount within 10 days.
 * - Category from the first matching bank rule.
 */
import { TAX_CODES } from "@partnersinbiz/pib-plugin-kit";
import { AccountingError, alnum, daysBetween } from "./util.js";

export const RULE_FIELDS = ["description", "counterparty", "reference", "amount"] as const;
export const RULE_OPERATORS = ["contains", "starts_with", "equals", "amount_between"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export interface BankRule {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  field: RuleField;
  operator: RuleOperator;
  value: string;
  amountMinMinor: number | null;
  amountMaxMinor: number | null;
  direction: "any" | "in" | "out";
  accountCode: string;
  taxCode: string | null;
  counterparty: string | null;
}

export interface BankLineLike {
  id: string;
  date: string;
  amountMinor: number;
  description: string;
  reference: string | null;
  counterparty: string | null;
}

export interface OpenItemLike {
  key: string;
  kind: "receivable" | "payable";
  number: string;
  counterpartyName: string;
  currency: string;
  outstandingMinor: number;
  refs: string[];
  dueDate: string | null;
}

export interface JournalCandidate {
  journalId: string;
  number: string;
  date: string;
  memo: string;
  /** Net effect on the bank's chart account: debit − credit (money in is positive). */
  amountMinor: number;
}

export type Suggestion =
  | { kind: "open_item"; basis: "exact" | "amount" | "reference"; key: string; itemKind: "receivable" | "payable"; number: string; counterparty: string; outstandingMinor: number; confidence: number }
  | { kind: "journal"; journalId: string; number: string; date: string; memo: string; confidence: number }
  | { kind: "category"; source: "rule" | "jev"; accountCode: string; taxCode: string | null; counterparty: string | null; ruleId?: string | null; confidence: number; vatApplies?: number | null; isTransfer?: number | null };

export function validateRule(input: Record<string, unknown>): Omit<BankRule, "id"> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new AccountingError("Rule name is required");
  const field = String(input.field ?? "description") as RuleField;
  if (!(RULE_FIELDS as readonly string[]).includes(field)) throw new AccountingError(`field must be one of ${RULE_FIELDS.join(", ")}`);
  const operator = String(input.operator ?? "contains") as RuleOperator;
  if (!(RULE_OPERATORS as readonly string[]).includes(operator)) throw new AccountingError(`operator must be one of ${RULE_OPERATORS.join(", ")}`);
  if ((field === "amount") !== (operator === "amount_between")) throw new AccountingError("Use amount_between with the amount field, and text operators with text fields");
  const value = typeof input.value === "string" ? input.value.trim() : "";
  if (operator !== "amount_between" && !value) throw new AccountingError("Rule value is required");
  const min = input.amountMinMinor == null || input.amountMinMinor === "" ? null : Number(input.amountMinMinor);
  const max = input.amountMaxMinor == null || input.amountMaxMinor === "" ? null : Number(input.amountMaxMinor);
  if (operator === "amount_between") {
    if (min == null && max == null) throw new AccountingError("Give a minimum or maximum amount");
    for (const v of [min, max]) if (v != null && (!Number.isSafeInteger(v) || v < 0)) throw new AccountingError("Amounts are whole cents, 0 or more");
  }
  const direction = String(input.direction ?? "any") as BankRule["direction"];
  if (!["any", "in", "out"].includes(direction)) throw new AccountingError("direction must be any, in or out");
  const accountCode = typeof input.accountCode === "string" ? input.accountCode.trim() : "";
  if (!accountCode) throw new AccountingError("Choose the account the rule posts to");
  const taxCode = typeof input.taxCode === "string" && input.taxCode ? input.taxCode : null;
  if (taxCode && !(taxCode in TAX_CODES)) throw new AccountingError(`Unknown tax code ${taxCode}`);
  const priority = input.priority == null || input.priority === "" ? 100 : Number(input.priority);
  if (!Number.isInteger(priority)) throw new AccountingError("priority must be a whole number");
  return {
    name: name.slice(0, 120),
    priority,
    active: input.active !== false,
    field,
    operator,
    value: value.slice(0, 200),
    amountMinMinor: min,
    amountMaxMinor: max,
    direction,
    accountCode,
    taxCode,
    counterparty: typeof input.counterparty === "string" && input.counterparty.trim() ? input.counterparty.trim().slice(0, 120) : null,
  };
}

export function ruleMatches(rule: BankRule, line: BankLineLike): boolean {
  if (!rule.active) return false;
  if (rule.direction === "in" && line.amountMinor <= 0) return false;
  if (rule.direction === "out" && line.amountMinor >= 0) return false;
  if (rule.operator === "amount_between") {
    const abs = Math.abs(line.amountMinor);
    if (rule.amountMinMinor != null && abs < rule.amountMinMinor) return false;
    if (rule.amountMaxMinor != null && abs > rule.amountMaxMinor) return false;
    return true;
  }
  const text = (rule.field === "description" ? line.description : rule.field === "counterparty" ? line.counterparty : line.reference) ?? "";
  const hay = text.toLowerCase().replace(/\s+/g, " ").trim();
  const needle = rule.value.toLowerCase().replace(/\s+/g, " ").trim();
  if (!needle) return false;
  if (rule.operator === "contains") return hay.includes(needle);
  if (rule.operator === "starts_with") return hay.startsWith(needle);
  return hay === needle;
}

/** First active rule by priority (lower first), then name. */
export function firstMatchingRule(rules: BankRule[], line: BankLineLike): BankRule | null {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  return sorted.find((r) => ruleMatches(r, line)) ?? null;
}

/** True when `number` (or a reference) appears in the line's text, ignoring punctuation and case. */
export function mentions(line: BankLineLike, tokens: string[]): boolean {
  const hay = alnum(`${line.description} ${line.reference ?? ""} ${line.counterparty ?? ""}`);
  return tokens.some((t) => {
    const token = alnum(t);
    // Short tokens (e.g. "12") would match anything.
    return token.length >= 4 && hay.includes(token);
  });
}

export function matchOpenItems(line: BankLineLike, items: OpenItemLike[], bookCurrency = "ZAR"): Suggestion[] {
  const kind = line.amountMinor > 0 ? "receivable" : "payable";
  const abs = Math.abs(line.amountMinor);
  const out: Array<Suggestion & { kind: "open_item" }> = [];
  const due = new Map(items.map((i) => [i.key, i.dueDate]));
  for (const item of items) {
    if (item.kind !== kind || item.outstandingMinor <= 0 || item.currency !== bookCurrency) continue;
    const named = mentions(line, [item.number, ...item.refs]);
    const sameAmount = item.outstandingMinor === abs;
    let basis: "exact" | "amount" | "reference" | null = null;
    if (sameAmount && named) basis = "exact";
    else if (sameAmount) basis = "amount";
    else if (named && abs < item.outstandingMinor) basis = "reference";
    if (!basis) continue;
    out.push({
      kind: "open_item",
      basis,
      key: item.key,
      itemKind: item.kind,
      number: item.number,
      counterparty: item.counterpartyName,
      outstandingMinor: item.outstandingMinor,
      confidence: basis === "exact" ? 0.95 : basis === "reference" ? 0.7 : 0.5,
    });
  }
  // Exact first; among equal matches, the one due closest to the line date.
  const distance = (key: string) => {
    const d = due.get(key);
    return d ? Math.abs(daysBetween(d, line.date)) : 9999;
  };
  return out.sort((a, b) => b.confidence - a.confidence || distance(a.key) - distance(b.key)).slice(0, 5);
}

export function matchJournals(line: BankLineLike, candidates: JournalCandidate[], windowDays = 10): Suggestion[] {
  return candidates
    .filter((c) => c.amountMinor === line.amountMinor && Math.abs(daysBetween(c.date, line.date)) <= windowDays)
    .sort((a, b) => Math.abs(daysBetween(a.date, line.date)) - Math.abs(daysBetween(b.date, line.date)))
    .slice(0, 3)
    .map((c) => ({ kind: "journal" as const, journalId: c.journalId, number: c.number, date: c.date, memo: c.memo, confidence: c.date === line.date ? 0.9 : 0.75 }));
}

/** All suggestions for a line, best first. The UI shows the first as the proposal. */
export function suggestFor(
  line: BankLineLike,
  input: { items: OpenItemLike[]; journals: JournalCandidate[]; rules: BankRule[]; bookCurrency?: string },
): Suggestion[] {
  const out: Suggestion[] = [...matchJournals(line, input.journals), ...matchOpenItems(line, input.items, input.bookCurrency)];
  const rule = firstMatchingRule(input.rules, line);
  if (rule) {
    out.push({ kind: "category", source: "rule", accountCode: rule.accountCode, taxCode: rule.taxCode, counterparty: rule.counterparty, ruleId: rule.id, confidence: 0.85 });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Split a VAT-inclusive bank amount: VAT = gross × rate / (1 + rate), rounded
 * half-up to the cent (the VAT fraction 15/115 for the standard rate).
 */
export function splitVat(grossMinor: number, rateBps: number): { netMinor: number; vatMinor: number } {
  const gross = Math.abs(grossMinor);
  if (rateBps <= 0) return { netMinor: gross, vatMinor: 0 };
  const vat = Math.round((gross * rateBps) / (10_000 + rateBps));
  return { netMinor: gross - vat, vatMinor: vat };
}
