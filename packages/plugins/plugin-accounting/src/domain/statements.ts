/**
 * Bank statement parsers: CSV (header auto-detection, ported from the old
 * platform's parser and widened for SA bank exports), OFX and MT940.
 *
 * Amounts are signed minor units: money in is positive, money out negative.
 * Each line gets a fingerprint for dedupe across overlapping imports:
 * account + date + amount + description + reference + the line's position
 * among identical lines in the same file (so two R50 coffees on one day
 * stay two lines, and importing the same month twice adds nothing).
 */
import { createHash } from "node:crypto";
import { AccountingError, isIsoDate } from "./util.js";

export type StatementFormat = "csv" | "ofx" | "mt940";

export interface ParsedLine {
  date: string;
  amountMinor: number;
  description: string;
  reference: string | null;
  counterparty: string | null;
  balanceMinor: number | null;
  /** OFX FITID when present (the bank's own transaction id). */
  bankId: string | null;
}

export interface ParsedStatement {
  format: StatementFormat;
  lines: ParsedLine[];
  openingMinor: number | null;
  closingMinor: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  digest: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Dates as SA banks write them: 2026-09-01, 01/09/2026, 2026/09/01, 20260901, 01 Sep 2026. */
export function normalizeDate(raw: string): string {
  const s = raw.trim().replace(/^"|"$/g, "");
  let out: string | null = null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/))) out = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) out = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  else if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})$/)) && MONTHS[m[2]!.toLowerCase()]) {
    out = `${m[3]}-${MONTHS[m[2]!.toLowerCase()]}-${m[1]!.padStart(2, "0")}`;
  } else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) out = `${m[1]}-${m[2]}-${m[3]}`;
  if (!out || !isIsoDate(out)) throw new AccountingError(`Unrecognised date: ${raw}`);
  return out;
}

/** "1 234,56", "R1,234.56", "(12.00)", "-12", "12.00 Dr", "12.00CR" → signed cents. Zero allowed (returns 0). */
export function parseAmount(raw: string): number {
  let s = raw.trim().replace(/^"|"$/g, "").replace(/\s+/g, " ");
  if (!s) throw new AccountingError("Empty amount");
  let sign = 1;
  const suffix = s.match(/\s?(CR|DR|C|D)$/i);
  if (suffix) {
    if (/^D/i.test(suffix[1]!)) sign = -1;
    s = s.slice(0, s.length - suffix[0].length).trim();
  }
  if (s.startsWith("(") && s.endsWith(")")) {
    sign *= -1;
    s = s.slice(1, -1);
  }
  s = s.replace(/^R\s?/i, "").replace(/ZAR/i, "").trim();
  if (s.startsWith("-")) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  s = s.replace(/^R\s?/i, "").replace(/\s/g, "");
  // Decide the decimal separator: the last of "," or "." followed by 1–2 digits at the end.
  const decimalComma = /,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s);
  if (decimalComma) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d+(\.\d{1,4})?$/.test(s)) throw new AccountingError(`Invalid amount: ${raw}`);
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2)) + (Number(frac.slice(2, 3) || "0") >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(cents)) throw new AccountingError(`Amount out of range: ${raw}`);
  return sign * cents;
}

export function detectFormat(text: string): StatementFormat {
  const head = text.slice(0, 2000).toUpperCase();
  if (head.includes("<OFX") || head.includes("OFXHEADER") || head.includes("<STMTTRN>")) return "ofx";
  if (/(^|\n):20:/.test(head) || /(^|\n):61:/.test(head) || /(^|\n):25:/.test(head)) return "mt940";
  return "csv";
}

function splitRow(row: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (ch === '"') {
      if (inQ && row[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQ = !inQ;
      continue;
    }
    if (ch === delimiter && !inQ) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 10);
  const score = (d: string) => sample.reduce((s, l) => s + splitRow(l, d).length - 1, 0);
  const options = [",", ";", "\t", "|"];
  return options.reduce((best, d) => (score(d) > score(best) ? d : best), ",");
}

const HEADER_WORDS = ["date", "amount", "debit", "credit", "description", "balance", "narrative", "details", "reference"];

function findIndex(cells: string[], tests: Array<(h: string) => boolean>): number {
  for (const test of tests) {
    const i = cells.findIndex(test);
    if (i >= 0) return i;
  }
  return -1;
}

function parseCsv(text: string): { lines: ParsedLine[]; opening: number | null; closing: number | null } {
  const raw = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (raw.length === 0) throw new AccountingError("The CSV statement is empty");
  const delimiter = detectDelimiter(raw);
  // Header may sit below a few title rows (FNB and Absa exports add some).
  let headerRow = -1;
  for (let i = 0; i < Math.min(raw.length, 15); i += 1) {
    const cells = splitRow(raw[i]!, delimiter).map((c) => c.toLowerCase());
    const hits = HEADER_WORDS.filter((w) => cells.some((c) => c.includes(w))).length;
    if (cells.some((c) => c.includes("date")) && cells.some((c) => /amount|debit|credit|value/.test(c)) && hits >= 2) {
      headerRow = i;
      break;
    }
  }
  let dateIdx = 0;
  let amountIdx = 1;
  let descIdx = 2;
  let refIdx = -1;
  let cpIdx = -1;
  let debitIdx = -1;
  let creditIdx = -1;
  let balanceIdx = -1;
  let start = 0;
  if (headerRow >= 0) {
    const h = splitRow(raw[headerRow]!, delimiter).map((c) => c.toLowerCase().trim());
    start = headerRow + 1;
    dateIdx = findIndex(h, [(c) => c === "date", (c) => c.includes("transaction date"), (c) => c.includes("date")]);
    debitIdx = findIndex(h, [(c) => c === "debit" || c === "debits", (c) => c.includes("debit") || c.includes("money out") || c.includes("withdrawal")]);
    creditIdx = findIndex(h, [(c) => c === "credit" || c === "credits", (c) => c.includes("credit") || c.includes("money in") || c.includes("deposit")]);
    amountIdx = findIndex(h, [(c) => c === "amount", (c) => c.includes("amount") && !c.includes("balance"), (c) => c === "value"]);
    balanceIdx = findIndex(h, [(c) => c === "balance", (c) => c.includes("balance")]);
    descIdx = findIndex(h, [(c) => c.includes("desc"), (c) => c.includes("narrat"), (c) => c.includes("details"), (c) => c.includes("transaction") && !c.includes("date")]);
    refIdx = findIndex(h, [(c) => c === "reference" || c === "ref", (c) => c.includes("ref")]);
    cpIdx = findIndex(h, [(c) => c.includes("counter"), (c) => c.includes("payee") || c.includes("beneficiary"), (c) => c === "name"]);
    if (dateIdx < 0) throw new AccountingError("The CSV header has no date column");
    if (amountIdx < 0 && debitIdx < 0 && creditIdx < 0) throw new AccountingError("The CSV header needs an amount column, or debit and credit columns");
    if (descIdx < 0) descIdx = -1;
  }
  const lines: ParsedLine[] = [];
  for (let i = start; i < raw.length; i += 1) {
    const cells = splitRow(raw[i]!, delimiter);
    if (cells.every((c) => !c)) continue;
    const dateRaw = cells[dateIdx];
    if (!dateRaw) continue;
    let date: string;
    try {
      date = normalizeDate(dateRaw);
    } catch (error) {
      // Summary rows ("Opening balance", totals) have no real date.
      if (headerRow >= 0 && !/\d/.test(dateRaw)) continue;
      throw new AccountingError(`Row ${i + 1}: ${(error as Error).message}`);
    }
    let amount: number;
    try {
      if (amountIdx >= 0 && cells[amountIdx]) amount = parseAmount(cells[amountIdx]!);
      else {
        const debit = debitIdx >= 0 && cells[debitIdx] ? Math.abs(parseAmount(cells[debitIdx]!)) : 0;
        const credit = creditIdx >= 0 && cells[creditIdx] ? Math.abs(parseAmount(cells[creditIdx]!)) : 0;
        if (debit && credit) throw new AccountingError("both debit and credit are filled in");
        amount = credit ? credit : -debit;
      }
    } catch (error) {
      throw new AccountingError(`Row ${i + 1}: ${(error as Error).message}`);
    }
    if (amount === 0) continue;
    const description = (descIdx >= 0 ? cells[descIdx] : cells.filter((_, k) => k !== dateIdx && k !== amountIdx).join(" "))?.trim() || "Statement line";
    const balanceRaw = balanceIdx >= 0 ? cells[balanceIdx] : "";
    let balance: number | null = null;
    if (balanceRaw) {
      try {
        balance = parseAmount(balanceRaw);
      } catch {
        balance = null;
      }
    }
    lines.push({
      date,
      amountMinor: amount,
      description: description.slice(0, 500),
      reference: refIdx >= 0 && cells[refIdx] ? cells[refIdx]!.slice(0, 200) : null,
      counterparty: cpIdx >= 0 && cells[cpIdx] ? cells[cpIdx]!.slice(0, 200) : null,
      balanceMinor: balance,
      bankId: null,
    });
  }
  if (lines.length === 0) throw new AccountingError("The CSV statement has no transaction lines");
  // Opening/closing from the balance column, in file order (banks export oldest or newest first).
  let opening: number | null = null;
  let closing: number | null = null;
  if (lines.every((l) => l.balanceMinor != null)) {
    const first = lines[0]!;
    const last = lines[lines.length - 1]!;
    const ascending = first.date <= last.date;
    const oldest = ascending ? first : last;
    const newest = ascending ? last : first;
    opening = oldest.balanceMinor! - oldest.amountMinor;
    closing = newest.balanceMinor!;
  }
  return { lines, opening, closing };
}

function ofxTag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}>([^<\\r\\n]+)`, "i"));
  return m ? m[1]!.trim() : undefined;
}

function parseOfx(text: string): { lines: ParsedLine[]; opening: number | null; closing: number | null; start: string | null; end: string | null } {
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (blocks.length === 0) throw new AccountingError("The OFX file has no transactions (STMTTRN)");
  const lines: ParsedLine[] = [];
  blocks.forEach((block, i) => {
    const body = block.split(/<\/STMTTRN>/i)[0]!;
    const dt = ofxTag(body, "DTPOSTED") || ofxTag(body, "DTUSER");
    const amt = ofxTag(body, "TRNAMT");
    if (!dt || !amt) throw new AccountingError(`OFX transaction ${i + 1} has no DTPOSTED or TRNAMT`);
    const name = ofxTag(body, "NAME") || ofxTag(body, "PAYEE") || null;
    const memo = ofxTag(body, "MEMO") || null;
    const amount = parseAmount(amt);
    if (amount === 0) return;
    lines.push({
      date: normalizeDate(dt.slice(0, 8)),
      amountMinor: amount,
      description: [name, memo].filter(Boolean).join(" — ") || "OFX transaction",
      reference: ofxTag(body, "REFNUM") || ofxTag(body, "CHECKNUM") || null,
      counterparty: name,
      balanceMinor: null,
      bankId: ofxTag(body, "FITID") || null,
    });
  });
  const ledger = text.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i)?.[1] ?? "";
  const closingRaw = ofxTag(ledger, "BALAMT");
  const closing = closingRaw ? parseAmount(closingRaw) : null;
  const total = lines.reduce((s, l) => s + l.amountMinor, 0);
  const startRaw = ofxTag(text, "DTSTART");
  const endRaw = ofxTag(text, "DTEND");
  return {
    lines,
    closing,
    opening: closing == null ? null : closing - total,
    start: startRaw ? normalizeDate(startRaw.slice(0, 8)) : null,
    end: endRaw ? normalizeDate(endRaw.slice(0, 8)) : null,
  };
}

function mt940Date(yymmdd: string): string {
  const yy = Number(yymmdd.slice(0, 2));
  return normalizeDate(`${yy >= 70 ? 1900 + yy : 2000 + yy}${yymmdd.slice(2, 6)}`);
}

function mt940Balance(tag: string | undefined): { date: string; minor: number } | null {
  if (!tag) return null;
  const m = tag.match(/^([CD])(\d{6})([A-Z]{3})(\d+,\d{0,2})/);
  if (!m) return null;
  return { date: mt940Date(m[2]!), minor: (m[1] === "D" ? -1 : 1) * parseAmount(m[4]!.replace(",", ".")) };
}

/** MT940 :61: value lines with their :86: narratives, and :60F:/:62F: balances. */
function parseMt940(text: string): { lines: ParsedLine[]; opening: number | null; closing: number | null; start: string | null; end: string | null } {
  const normalized = text.replace(/\r\n/g, "\n");
  // Join continuation lines onto their tag so :86: narratives stay whole.
  const tags: Array<{ tag: string; value: string }> = [];
  for (const line of normalized.split("\n")) {
    const m = line.match(/^:(\d{2}[A-Z]?):(.*)$/);
    if (m) tags.push({ tag: m[1]!, value: m[2]! });
    else if (tags.length && line.trim() && !line.startsWith("-}") && line.trim() !== "-") tags[tags.length - 1]!.value += ` ${line.trim()}`;
  }
  const lines: ParsedLine[] = [];
  let opening: ReturnType<typeof mt940Balance> = null;
  let closing: ReturnType<typeof mt940Balance> = null;
  for (let i = 0; i < tags.length; i += 1) {
    const t = tags[i]!;
    if (t.tag === "60F" || t.tag === "60M") opening ??= mt940Balance(t.value);
    if (t.tag === "62F" || t.tag === "62M") closing = mt940Balance(t.value);
    if (t.tag !== "61") continue;
    const m = t.value.match(/^(\d{6})(\d{4})?(R?[CD])([A-Z])?(\d+,\d{0,2})([A-Z0-9]{4})?([^/\s]*)?(?:\/\/(\S+))?(.*)$/);
    if (!m) throw new AccountingError(`MT940 :61: line not recognised: ${t.value.slice(0, 60)}`);
    const debit = m[3] === "D" || m[3] === "RC";
    const amount = (debit ? -1 : 1) * parseAmount(m[5]!.replace(",", "."));
    const next = tags[i + 1];
    const narrative = next && next.tag === "86" ? next.value.trim() : "";
    const ref = (m[7] || "").trim();
    if (amount === 0) continue;
    lines.push({
      date: mt940Date(m[1]!),
      amountMinor: amount,
      description: (narrative || ref || "MT940 entry").slice(0, 500),
      reference: ref && ref !== "NONREF" ? ref.slice(0, 200) : null,
      counterparty: null,
      balanceMinor: null,
      bankId: m[8] ? m[8] : null,
    });
  }
  if (lines.length === 0) throw new AccountingError("The MT940 file has no :61: transaction lines");
  return { lines, opening: opening?.minor ?? null, closing: closing?.minor ?? null, start: opening?.date ?? null, end: closing?.date ?? null };
}

export function parseStatement(text: string, format: StatementFormat | "auto" = "auto"): ParsedStatement {
  if (typeof text !== "string" || !text.trim()) throw new AccountingError("The statement file is empty");
  const resolved = format === "auto" ? detectFormat(text) : format;
  let result: { lines: ParsedLine[]; opening: number | null; closing: number | null; start?: string | null; end?: string | null };
  if (resolved === "csv") result = parseCsv(text);
  else if (resolved === "ofx") result = parseOfx(text);
  else if (resolved === "mt940") result = parseMt940(text);
  else throw new AccountingError(`Unsupported statement format ${String(format)}`);
  const dates = result.lines.map((l) => l.date).sort();
  return {
    format: resolved,
    lines: result.lines,
    openingMinor: result.opening,
    closingMinor: result.closing,
    periodStart: result.start ?? dates[0] ?? null,
    periodEnd: result.end ?? dates[dates.length - 1] ?? null,
    digest: sha256(text),
  };
}

/** Fingerprints for dedupe (see the file comment). */
export function fingerprintLines(bankAccountId: string, lines: ParsedLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    if (line.bankId) return sha256(["fitid", bankAccountId, line.bankId].join("|"));
    const base = [bankAccountId, line.date, line.amountMinor, line.description.toLowerCase().replace(/\s+/g, " "), (line.reference ?? "").toLowerCase()].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return sha256(`${base}|${n}`);
  });
}
