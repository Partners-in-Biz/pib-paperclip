/**
 * Opening balances at cut-over: an opening trial balance (CSV) becomes one
 * opening journal. The TB must balance; when it does not, the person may
 * choose to post the difference to opening balance equity.
 *
 * CSV columns (header names are matched loosely):
 *   code, name (optional), debit, credit   – or –   code, balance (debit positive)
 */
import { parseAmount } from "./statements.js";
import { AccountingError } from "./util.js";

export interface OpeningLine {
  code: string;
  name: string;
  debitMinor: number;
  creditMinor: number;
}

export interface OpeningTb {
  lines: OpeningLine[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  differenceMinor: number;
}

function cells(row: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (ch === '"') {
      if (q && row[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else q = !q;
    } else if (ch === delimiter && !q) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseOpeningTb(text: string): OpeningTb {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (rows.length < 2) throw new AccountingError("The trial balance needs a header row and at least one account");
  const delimiter = (rows[0]!.match(/;/g)?.length ?? 0) > (rows[0]!.match(/,/g)?.length ?? 0) ? ";" : ",";
  const header = cells(rows[0]!, delimiter).map((h) => h.toLowerCase());
  const codeIdx = header.findIndex((h) => h === "code" || h.includes("account code") || h === "account");
  const nameIdx = header.findIndex((h) => h === "name" || h.includes("account name") || h.includes("description"));
  const debitIdx = header.findIndex((h) => h.includes("debit") || h === "dr");
  const creditIdx = header.findIndex((h) => h.includes("credit") || h === "cr");
  const balanceIdx = header.findIndex((h) => h.includes("balance") || h === "amount");
  if (codeIdx < 0) throw new AccountingError("The trial balance needs a code column");
  if ((debitIdx < 0 || creditIdx < 0) && balanceIdx < 0) throw new AccountingError("The trial balance needs debit and credit columns, or a balance column");
  const merged = new Map<string, OpeningLine>();
  for (let i = 1; i < rows.length; i += 1) {
    const c = cells(rows[i]!, delimiter);
    const code = (c[codeIdx] ?? "").trim();
    if (!code || /^total/i.test(code)) continue;
    let net: number;
    try {
      if (debitIdx >= 0 && creditIdx >= 0) {
        const d = c[debitIdx] ? Math.abs(parseAmount(c[debitIdx]!)) : 0;
        const cr = c[creditIdx] ? Math.abs(parseAmount(c[creditIdx]!)) : 0;
        net = d - cr;
      } else net = c[balanceIdx] ? parseAmount(c[balanceIdx]!) : 0;
    } catch (error) {
      throw new AccountingError(`Row ${i + 1} (${code}): ${(error as Error).message}`);
    }
    const line = merged.get(code) ?? { code, name: nameIdx >= 0 ? (c[nameIdx] ?? "") : "", debitMinor: 0, creditMinor: 0 };
    const current = line.debitMinor - line.creditMinor + net;
    line.debitMinor = current > 0 ? current : 0;
    line.creditMinor = current < 0 ? -current : 0;
    merged.set(code, line);
  }
  const lines = [...merged.values()].filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0);
  if (lines.length === 0) throw new AccountingError("The trial balance has no balances");
  const totalDebitMinor = lines.reduce((s, l) => s + l.debitMinor, 0);
  const totalCreditMinor = lines.reduce((s, l) => s + l.creditMinor, 0);
  return { lines, totalDebitMinor, totalCreditMinor, differenceMinor: totalDebitMinor - totalCreditMinor };
}

/**
 * Journal lines for the opening entry. With `balanceToEquity`, a difference
 * goes to opening balance equity; otherwise an unbalanced TB is refused.
 */
export function openingJournalLines(tb: OpeningTb, obeCode: string, balanceToEquity: boolean) {
  if (tb.differenceMinor !== 0 && !balanceToEquity) {
    throw new AccountingError(
      `The trial balance does not balance (debits ${tb.totalDebitMinor}, credits ${tb.totalCreditMinor} cents). Fix it, or choose to post the difference to opening balance equity.`,
      "unbalanced",
    );
  }
  const lines = tb.lines.map((l) => ({ accountCode: l.code, debitMinor: l.debitMinor, creditMinor: l.creditMinor, memo: "Opening balance" }));
  if (tb.differenceMinor > 0) lines.push({ accountCode: obeCode, debitMinor: 0, creditMinor: tb.differenceMinor, memo: "Opening balance difference" });
  if (tb.differenceMinor < 0) lines.push({ accountCode: obeCode, debitMinor: -tb.differenceMinor, creditMinor: 0, memo: "Opening balance difference" });
  return lines;
}
