import { useState, type CSSProperties, type ReactNode } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { KpiCard, Pill, errorText, tokens, tone, type ToneInput } from "@partnersinbiz/pib-plugin-ui";

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

/** R 1 234.56 (cents in, rand out). */
export function rand(minor: number | null | undefined): string {
  if (minor == null || !Number.isFinite(minor)) return "—";
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}R ${whole}.${String(abs % 100).padStart(2, "0")}`;
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

export function AccountSelect({ accounts, value, onChange, filter, placeholder = "Choose an account…" }: {
  accounts: Account[];
  value: string;
  onChange: (code: string) => void;
  filter?: (a: Account) => boolean;
  placeholder?: string;
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
      onChange={(e) => onChange(e.target.value)}
      style={{ height: 36, borderRadius: 8, border: `1px solid ${tokens.input}`, background: tokens.bg, color: tokens.fg, padding: "0 8px", fontSize: 13, fontFamily: "inherit", minWidth: "min(220px, 100%)", maxWidth: "min(360px, 100%)" }}
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
  if (["rejected", "failed", "overdue", "blocked"].includes(status)) return "bad";
  if (["draft", "prepared", "scheduled", "in_progress"].includes(status)) return "info";
  return "neutral";
}

/** A toned status pill. */
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const text = label ?? words(status);
  return <Pill tone={statusTone(status)} dot size="sm">{text.charAt(0).toUpperCase() + text.slice(1)}</Pill>;
}
