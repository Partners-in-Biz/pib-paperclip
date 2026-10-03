import { useState, type CSSProperties, type ReactNode } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { CircleAlert, KpiCard, Pill, TriangleAlert, errorText, tokens, tone, useIsNarrow, type ToneInput } from "@partnersinbiz/pib-plugin-ui";
import { readableDates } from "../domain/dates.js";
import { cleanMemo } from "../domain/memo.js";

export interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  cashFlow: string;
  description: string;
  system: boolean;
  active: boolean;
}

export interface BankAccount {
  id: string;
  name: string;
  accountCode: string;
  bankName: string;
  numberLast4: string;
  currency: string;
  active: boolean;
}

export const TAX_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "No VAT" },
  { value: "za_std_15", label: "Standard 15%" },
  { value: "za_capital_15", label: "Capital goods 15%" },
  { value: "za_zero", label: "Zero-rated" },
  { value: "za_export_zero", label: "Exports (zero-rated)" },
  { value: "za_exempt", label: "Exempt" },
  { value: "za_out_of_scope", label: "Out of scope" },
];

/** A VAT code as people read it ("Standard 15%"); the code itself only when it is unknown. */
export function taxLabel(code: string | null | undefined): string {
  if (!code) return "No VAT";
  return TAX_OPTIONS.find((t) => t.value === code)?.label ?? code;
}

/** Journal kinds in plain words (the filter and the journal list). */
export const KIND_LABELS: Record<string, string> = {
  event: "From Billing or Payroll",
  manual: "Manual",
  reversal: "Reversal",
  bank: "Bank",
  opening: "Opening balances",
  depreciation: "Depreciation",
  disposal: "Asset sold or scrapped",
  fx_revaluation: "Exchange-rate revaluation",
};

export function kindLabel(kind: string | null | undefined): string {
  return KIND_LABELS[kind ?? ""] ?? capitalise(words(kind));
}

/** The module a journal or posting came from, by name (never the plugin id). */
export function sourceName(plugin: string | null | undefined): string {
  const id = (plugin ?? "").toLowerCase();
  if (!id || id.endsWith(".accounting") || id === "accounting") return "Accounting";
  if (id.endsWith(".billing")) return "Billing";
  if (id.endsWith(".payroll")) return "Payroll";
  const last = id.split(".").pop() ?? "";
  return last ? capitalise(words(last)) : "Another module";
}

/** A journal memo for people: no database ids, readable dates; `fallback` when nothing is left. */
export function memoText(memo: string | null | undefined, fallback = "—"): string {
  return readableDates(cleanMemo(memo)) || fallback;
}

export function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** "1 234,50" / "1234.5" / "-12" → cents. Empty → null. */
export function toCents(value: string): number | null {
  const cleaned = value.replace(/[\sR]/gi, "").replace(",", ".");
  if (!cleaned) return null;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) throw new Error(`"${value}" is not an amount`);
  return Math.round(amount * 100);
}

export function centsToInput(minor: number | null | undefined): string {
  if (minor == null) return "";
  return (minor / 100).toFixed(2);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function words(value: string | null | undefined): string {
  return (value ?? "").replace(/_/g, " ");
}

export const small: CSSProperties = { height: 28, fontSize: 12, padding: "0 10px" };

export const num: CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

export function Banner({ tone: t = "info", children }: { tone?: "warn" | "info" | "ok" | "bad"; children: ReactNode }) {
  const colors = t === "info" ? null : tone(t);
  return (
    <div role="status" style={{ fontSize: 13, lineHeight: 1.5, padding: "10px 14px", borderRadius: 10, border: `1px solid ${colors ? colors.border : tokens.border}`, borderLeft: `3px solid ${colors ? colors.solid : tokens.border}`, background: colors ? colors.soft : tokens.secondary, display: "grid", gap: 4, minWidth: 0, overflowWrap: "anywhere" }}>
      {children}
    </div>
  );
}

/**
 * A one-line notice with the fix beside it (settings not saved, roles
 * without an account). The page shows these in the same place on every tab.
 */
export function NoticeLine({ tone: t = "warn", children, action }: { tone?: "warn" | "bad" | "info"; children: ReactNode; action?: ReactNode }) {
  const colors = tone(t);
  const Glyph = t === "bad" ? CircleAlert : TriangleAlert;
  return (
    <div role="status" style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px 6px 12px", borderRadius: 10, border: `1px solid ${colors.border}`, background: colors.soft, fontSize: 13, lineHeight: 1.4, minWidth: 0 }}>
      <Glyph size={15} aria-hidden="true" style={{ color: colors.fg, flexShrink: 0 }} />
      <span style={{ flex: "1 1 auto", minWidth: 0, color: tokens.fg, overflowWrap: "anywhere" }}>{children}</span>
      {action ? <span style={{ flexShrink: 0, display: "inline-flex" }}>{action}</span> : null}
    </div>
  );
}

/** The fix in a NoticeLine: a link (`linkProps`) or a button, at least 40px tall on a phone. */
export function NoticeAction({ children, onClick, link }: { children: ReactNode; onClick?: () => void; link?: Record<string, unknown> }) {
  const narrow = useIsNarrow();
  const style: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, minHeight: narrow ? 40 : 30, padding: "0 12px", borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.card, color: tokens.fg, fontSize: 12.5, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap", cursor: "pointer", fontFamily: "inherit" };
  if (link) return <a {...link} style={style}>{children} →</a>;
  return <button type="button" onClick={onClick} style={style}>{children} →</button>;
}

/** Sections inside a top tab (pills). Nothing when the tab has one section. */
export function SectionNav({ items, active, onChange }: { items: Array<{ id: string; label: string; count?: number | null; tone?: ToneInput }>; active: string; onChange: (id: string) => void }) {
  if (items.length < 2) return null;
  return (
    <div role="tablist" aria-label="Sections" style={{ display: "flex", flexWrap: "wrap", gap: 6, minWidth: 0 }}>
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.id)}
            style={{
              appearance: "none",
              border: `1px solid ${selected ? tokens.fg : tokens.border}`,
              background: selected ? tokens.fg : tokens.bg,
              color: selected ? tokens.bg : tokens.fg,
              borderRadius: 999,
              padding: "0 12px",
              minHeight: 30,
              fontSize: 12.5,
              fontWeight: selected ? 650 : 500,
              cursor: "pointer",
              fontFamily: "inherit",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
            }}
          >
            {item.label}
            {item.count ? (
              <span style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, fontSize: 11, fontWeight: 650, display: "inline-grid", placeItems: "center", background: item.tone ? tone(item.tone).soft : tokens.secondary, color: item.tone ? tone(item.tone).fg : tokens.secondaryFg }}>{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Technical detail for an accountant (codes, keys, hashes), closed by default. */
export function Details({ children, summary = "Details" }: { children: ReactNode; summary?: string }) {
  return (
    <details style={{ fontSize: 12.5, color: tokens.muted, minWidth: 0 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, color: tokens.fg, minHeight: 28, display: "flex", alignItems: "center" }}>{summary}</summary>
      <div style={{ display: "grid", gap: 4, paddingTop: 6, overflowWrap: "anywhere" }}>{children}</div>
    </details>
  );
}

export function IssueLink({ id, identifier, label }: { id: string | null; identifier?: string | null; label?: string }) {
  const nav = useHostNavigation();
  if (!id) return <span style={{ color: tokens.muted }}>—</span>;
  return (
    <a {...nav.linkProps(`/issues/${identifier ?? id}`)} style={{ color: tokens.fg, fontWeight: 500 }}>
      {label ?? identifier ?? "Open issue"}
    </a>
  );
}

/** A plain table for reports and line editors (DataTable is used for simple lists). */
export function Table({ head, children, footer }: { head: Array<string | { label: string; right?: boolean; width?: string }>; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="pib-scroll-x" style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", maxWidth: "100%", minWidth: 0, border: `1px solid ${tokens.border}`, borderRadius: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: tokens.secondary }}>
            {head.map((h, i) => {
              const cell = typeof h === "string" ? { label: h } : h;
              return (
                <th key={i} style={{ textAlign: cell.right ? "right" : "left", padding: "8px 10px", fontWeight: 600, fontSize: 12, color: tokens.muted, width: cell.width, whiteSpace: "nowrap" }}>
                  {cell.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

/** Green for a positive amount, red for a negative one (profit, cash, variance). */
export function signTone(minor: number | null | undefined): "ok" | "bad" | undefined {
  if (minor == null || !Number.isFinite(minor) || minor === 0) return undefined;
  return minor > 0 ? "ok" : "bad";
}

export function Td({ children, right, strong, muted, colSpan, tone: t }: { children?: ReactNode; right?: boolean; strong?: boolean; muted?: boolean; colSpan?: number; tone?: ToneInput }) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: "7px 10px",
        borderTop: `1px solid ${tokens.border}`,
        fontWeight: strong ? 650 : 400,
        color: t ? tone(t).fg : muted ? tokens.muted : tokens.fg,
        ...(right ? num : {}),
      }}
    >
      {children}
    </td>
  );
}

export function Stat({ label, value, hint, tone: t }: { label: string; value: ReactNode; hint?: ReactNode; tone?: ToneInput }) {
  return <KpiCard label={label} value={value} hint={hint} tone={t} size="sm" />;
}

export function Row({ children, gap = 8, wrap = true }: { children: ReactNode; gap?: number; wrap?: boolean }) {
  return <div style={{ display: "flex", gap, alignItems: "flex-end", flexWrap: wrap ? "wrap" : "nowrap", minWidth: 0 }}>{children}</div>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5 }}>{children}</p>;
}

/** Run an action, report success or the error text. */
export function useRunner(onMessage: (message: string) => void) {
  const [busy, setBusy] = useState("");
  async function run<T>(label: string, work: () => Promise<T>, success?: string | ((result: T) => string)): Promise<T | null> {
    setBusy(label);
    onMessage("");
    try {
      const result = await work();
      if (success) onMessage(typeof success === "function" ? success(result) : success);
      return result;
    } catch (error) {
      onMessage(errorText(error));
      return null;
    } finally {
      setBusy("");
    }
  }
  return { busy, run };
}

export function download(fileName: string, content: string | Uint8Array, mime: string) {
  const blob = new Blob([content as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function base64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function accountLabel(accounts: Account[], code: string | null | undefined): string {
  if (!code) return "—";
  const a = accounts.find((x) => x.code === code);
  return a ? `${a.code} ${a.name}` : code;
}

export function AccountSelect({ accounts, value, onChange, filter, placeholder = "Choose an account…", fullWidth = false, label }: {
  accounts: Account[];
  value: string;
  onChange: (code: string) => void;
  filter?: (a: Account) => boolean;
  placeholder?: string;
  /** Fill the box it sits in (filter rows, forms) instead of its own width. */
  fullWidth?: boolean;
  /** Accessible name when there is no visible label. */
  label?: string;
}) {
  const list = accounts.filter((a) => a.active && (!filter || filter(a)));
  const groups: Array<[string, Account[]]> = [
    ["Assets", list.filter((a) => a.type === "asset")],
    ["Liabilities", list.filter((a) => a.type === "liability")],
    ["Equity", list.filter((a) => a.type === "equity")],
    ["Income", list.filter((a) => a.type === "income")],
    ["Expenses", list.filter((a) => a.type === "expense")],
  ];
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      style={{ height: 36, borderRadius: 8, border: `1px solid ${tokens.input}`, background: tokens.bg, color: tokens.fg, padding: "0 8px", fontSize: 13, fontFamily: "inherit", ...(fullWidth ? { width: "100%", minWidth: 0, maxWidth: "100%" } : { minWidth: "min(220px, 100%)", maxWidth: "min(360px, 100%)" }) }}
    >
      <option value="">{placeholder}</option>
      {groups.filter(([, items]) => items.length).map(([label, items]) => (
        <optgroup key={label} label={label}>
          {items.map((a) => (
            <option key={a.id} value={a.code}>{`${a.code} ${a.name}`}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * One status → tone mapping for every Accounting list: green done (reconciled,
 * posted, locked), amber waiting (matching, pending approval, to prepare), red
 * rejected or failed, blue draft, grey closed, excluded or reversed.
 */
export function statusTone(status: string): "ok" | "warn" | "bad" | "info" | "neutral" {
  if (["reconciled", "posted", "locked", "open", "settled", "resolved", "approved", "submitted", "ok", "in_use", "active"].includes(status)) return "ok";
  if (["matching", "pending_approval", "soft_closed", "unreconciled", "not_prepared", "pending", "due", "to_do", "review"].includes(status)) return "warn";
  if (["rejected", "failed", "overdue", "blocked", "late"].includes(status)) return "bad";
  if (["draft", "prepared", "scheduled", "in_progress", "running"].includes(status)) return "info";
  return "neutral";
}

/** A toned status pill. */
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const text = label ?? words(status);
  return <Pill tone={statusTone(status)} dot size="sm">{text.charAt(0).toUpperCase() + text.slice(1)}</Pill>;
}

/**
 * The Reviewer's pass on a ledger approval (manual journal, reconciliation, VAT201). The owner's Approve is offered
 * only after a pass; ticking "Approve without the Reviewer" approves it as it is, and that is recorded on the issue.
 */
export interface ReviewInfo {
  state: "not_required" | "pending" | "passed" | "changes_needed" | "waived";
  canApprove: boolean;
  findings: string | null;
  reviewedAt: string | null;
  waivedBy: string | null;
}

export function reviewText(review: ReviewInfo | null | undefined): { label: string; tone: "ok" | "warn" | "bad" | "info" | "neutral" } | null {
  if (!review || review.state === "not_required") return null;
  if (review.state === "passed") return { label: "Reviewer passed it", tone: "ok" };
  if (review.state === "pending") return { label: "With the Reviewer", tone: "warn" };
  if (review.state === "changes_needed") return { label: "Reviewer asked for changes", tone: "bad" };
  return { label: "Approved without the Reviewer", tone: "neutral" };
}

export function ReviewBadge({ review }: { review: ReviewInfo | null | undefined }) {
  const text = reviewText(review);
  if (!text) return null;
  return <span title={review?.findings ?? undefined}><Pill tone={text.tone} dot size="sm">{text.label}</Pill></span>;
}

/** The "approve anyway" tick, shown only while the Reviewer has not passed it. Returns whether Approve may be clicked. */
export function ReviewOverride({ review, checked, onChange }: { review: ReviewInfo | null | undefined; checked: boolean; onChange: (value: boolean) => void }) {
  if (!review || review.canApprove) return null;
  return (
    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: tokens.muted }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Approve without the Reviewer{review.findings ? ` (it said: ${review.findings.slice(0, 120)})` : ""}
    </label>
  );
}

/** True while the owner's click is not offered yet. */
export function approveBlocked(review: ReviewInfo | null | undefined, override: boolean): boolean {
  return Boolean(review && !review.canApprove && !override);
}
