import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from "react";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { formatMoney, formatShortDate, Button, Field, Input, Pill, SectionCard, Select, fluidColumns, oneColumn, tokens, tone, useIsNarrow, usePibBaseStyles, type LucideIcon, type ToneInput } from "@partnersinbiz/pib-plugin-ui";
import { statusTone } from "./series.js";
import type { ClientKind, ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import type { Client, Snapshot } from "./types.js";

export const FONT = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

// ── Actions ────────────────────────────────────────────────────────────────

const ACTION_KEYS = [
  "billing.load", "billing.create-invoice", "billing.add-line", "billing.update-line", "billing.remove-line", "billing.update-invoice",
  "billing.invoice-detail", "billing.request-send", "billing.request-pay", "billing.mark-sent", "billing.retry-send", "billing.cancel-invoice",
  "billing.document-pdf", "billing.create-quote", "billing.add-quote-line", "billing.update-quote-line", "billing.remove-quote-line",
  "billing.update-quote", "billing.quote-detail", "billing.set-quote-status", "billing.request-quote-send", "billing.convert-quote",
  "billing.create-expense", "billing.update-expense", "billing.void-expense", "billing.receipt-to-expense", "billing.receipt-file", "billing.upload-url",
  "billing.record-payment", "billing.create-credit-note", "billing.credit-note-pdf", "billing.send-credit-note", "billing.statement-pdf",
  "billing.send-statement", "billing.apply-credit", "billing.write-off", "billing.register-pop", "billing.confirm-pop", "billing.reject-pop",
  "billing.pop-file", "billing.create-bill", "billing.add-bill-line", "billing.remove-bill-line", "billing.update-bill", "billing.bill-detail",
  "billing.approve-bill", "billing.pay-bill", "billing.cancel-bill", "billing.attach-bill-file", "billing.bill-file", "billing.start-timer",
  "billing.stop-timer", "billing.log-time", "billing.delete-time-entry", "billing.bill-time", "billing.create-plan", "billing.update-plan",
  "billing.create-subscription", "billing.set-subscription-status", "billing.create-recurring", "billing.pause-recurring", "billing.resume-recurring",
  "billing.update-recurring", "billing.reports", "billing.dunning", "billing.set-dunning-optout", "billing.get-numbering", "billing.set-numbering", "billing.run-dunning", "billing.retry-ledger",
  "billing.create-payment-link", "billing.payment-links", "billing.cancel-payment-link", "billing.record-refund", "billing.simulate-payment", "billing.payments",
] as const;

export type ActionKey = (typeof ACTION_KEYS)[number];
export type Call = <T = unknown>(key: ActionKey, params?: Record<string, unknown>) => Promise<T>;

/** One `usePluginAction` per key (a fixed list, so hook order is stable). */
export function useCall(): Call {
  const fns: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {};
  for (const key of ACTION_KEYS) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    fns[key] = usePluginAction(key) as (params?: Record<string, unknown>) => Promise<unknown>;
  }
  return (key, params = {}) => fns[key]!(params) as Promise<never>;
}

export interface BillingApi {
  call: Call;
  snapshot: Snapshot;
  scope: ClientScope;
  clientName: string;
  refresh: () => Promise<void>;
  /** Run work, refresh, show the success line (or the error). Returns true on success. */
  run: (work: () => Promise<unknown>, success: string) => Promise<boolean>;
  say: (message: string) => void;
}

export const BillingContext = createContext<BillingApi | null>(null);

export function useBilling(): BillingApi {
  const api = useContext(BillingContext);
  if (!api) throw new Error("Billing context missing");
  return api;
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function money(minor: number | null | undefined, currency = "ZAR"): string {
  // One money format across PiB pages and documents: R 12,345.67.
  return formatMoney(Number(minor ?? 0), currency);
}

/** "1 234,50" / "1234.5" / "R 99" → minor units. */
export function toMinor(value: string): number {
  const cleaned = String(value).replace(/[^\d,.-]/g, "").replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, "");
  const amount = Number(cleaned);
  if (!cleaned || !Number.isFinite(amount)) throw new Error("Enter a valid amount");
  return Math.round(amount * 100);
}

export function minorToInput(minor: number | null | undefined): string {
  return minor == null ? "" : (Number(minor) / 100).toFixed(2);
}

/** `28 Sep` (the year only when it is not this year), the same on every PiB page. */
export function fmtDate(value: string | null | undefined): string {
  return formatShortDate(value);
}

export function dayInput(value: string | null | undefined): string {
  return value ? String(value).slice(0, 10) : "";
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function words(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Status ─────────────────────────────────────────────────────────────────

const LABEL: Record<string, string> = {
  payment_pending_verification: "Checking payment",
  partially_paid: "Part paid",
  written_off: "Written off",
};

export function statusLabel(status: string): string {
  return LABEL[status] ?? words(status);
}

/** A toned status pill; one mapping for every Billing list (see `statusTone`). */
export function Status({ status }: { status: string }) {
  return <Pill tone={statusTone(status)} dot size="sm">{statusLabel(status)}</Pill>;
}

/** Email / books state for a document, in plain words. */
export function DeliveryNote({ status, error }: { status?: string | null; error?: string | null }) {
  if (!status) return null;
  const text = status === "queued" ? (error ? `Email: ${error}` : "Email queued in the Mailbox") : status === "sent" ? "Emailed" : status === "manual" ? "Marked sent (no email)" : `Email failed${error ? `: ${error}` : ""}`;
  const t = status === "failed" ? "bad" : status === "sent" ? "ok" : status === "queued" ? "info" : "neutral";
  return <span style={{ fontSize: 12, color: t === "neutral" ? tokens.muted : tone(t).fg, overflowWrap: "anywhere" }}>{text}</span>;
}

// ── Layout helpers ─────────────────────────────────────────────────────────

export function Muted({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5, ...style }}>{children}</p>;
}

export function Row({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", ...style }}>{children}</div>;
}

export function Grid({ children, min = 150 }: { children: ReactNode; min?: number }) {
  return <div style={{ display: "grid", gridTemplateColumns: fluidColumns(min), gap: 10 }}>{children}</div>;
}

export function SmallButton(props: Parameters<typeof Button>[0]) {
  return <Button type="button" variant="secondary" {...props} style={{ height: 28, fontSize: 12, padding: "0 10px", ...(props.style ?? {}) }} />;
}

export function Card({ title, children, actions, icon, subtitle, tone: t, strip }: { title?: string; children: ReactNode; actions?: ReactNode; icon?: LucideIcon; subtitle?: ReactNode; tone?: ToneInput; strip?: boolean }) {
  if (title) return <SectionCard title={title} icon={icon} subtitle={subtitle} tone={t} strip={strip} actions={actions}>{children}</SectionCard>;
  return (
    <section style={{ display: "grid", gridTemplateColumns: oneColumn, gap: 10, padding: 14, borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.card, minWidth: 0 }}>
      {actions ? <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{actions}</div> : null}
      {children}
    </section>
  );
}

/** Money coloured by meaning: `in` (received) green, `overdue` red, otherwise plain. */
/**
 * The sections of a tab: a row of pills that wraps on a phone (no sideways
 * scroll). Hidden when a tab has one section.
 */
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

/** A link to a Paperclip issue (by id), in the host's router. */
export function IssueLink({ issueId, children = "Open issue" }: { issueId: string; children?: ReactNode }) {
  const nav = useHostNavigation();
  return (
    <a {...nav.linkProps(`/issues/${issueId}`)} style={{ color: tokens.primary, fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", textDecoration: "none" }}>
      {children}
    </a>
  );
}

export function Money({ minor, currency, kind }: { minor: number | null | undefined; currency: string; kind?: "in" | "overdue" | null }) {
  const color = kind === "in" ? tone("ok").fg : kind === "overdue" ? tone("bad").fg : undefined;
  return <span style={{ fontVariantNumeric: "tabular-nums", color, fontWeight: kind ? 600 : undefined }}>{money(minor, currency)}</span>;
}

export function Totals({ rows }: { rows: Array<{ label: string; value: string; strong?: boolean }> }) {
  return (
    <div style={{ display: "grid", gap: 4, justifyContent: "end", fontSize: 13, maxWidth: "100%" }}>
      {rows.map((row) => (
        <div key={row.label} style={{ display: "flex", gap: 16, justifyContent: "space-between", fontWeight: row.strong ? 650 : 400 }}>
          <span style={{ color: row.strong ? tokens.fg : tokens.muted }}>{row.label}</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/** A wide side panel (the kit's Sheet is 440px; editors need more room). */
export function Drawer({ open, title, subtitle, onClose, children, actions }: { open: boolean; title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const narrow = useIsNarrow();
  usePibBaseStyles();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 70, background: "color-mix(in oklab, black 40%, transparent)", display: "flex", justifyContent: "flex-end" }}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="pib-ui"
        style={{
          // A phone gets the whole screen, clear of the notch and the home indicator.
          width: narrow ? "100%" : "min(820px, 100%)",
          height: "100%",
          maxHeight: "100dvh",
          overflowX: "hidden",
          overflowY: "auto",
          overscrollBehavior: "contain",
          WebkitOverflowScrolling: "touch",
          background: tokens.bg,
          borderLeft: narrow ? "none" : `1px solid ${tokens.border}`,
          color: tokens.fg,
          fontFamily: FONT,
          display: "grid",
          gridTemplateColumns: oneColumn,
          alignContent: "start",
          gap: 14,
          padding: narrow ? "calc(14px + env(safe-area-inset-top, 0px)) 16px calc(20px + env(safe-area-inset-bottom, 0px))" : 22,
          boxShadow: "-12px 0 40px color-mix(in oklab, black 20%, transparent)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 650, letterSpacing: "-0.01em", overflowWrap: "anywhere" }}>{title}</h2>
            {subtitle ? <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5, color: tokens.muted }}>{subtitle}</div> : null}
          </div>
          <Button type="button" variant="secondary" onClick={onClose} aria-label="Close" style={{ minWidth: narrow ? 40 : 0, padding: "0 10px", flexShrink: 0 }}>×</Button>
        </div>
        {actions ? <Row>{actions}</Row> : null}
        {children}
      </aside>
    </div>
  );
}

// ── Pickers ────────────────────────────────────────────────────────────────

export function ClientSelect({ clients, value, onChange, label = "Client", allowEmpty = false }: { clients: Client[]; value: string; onChange: (value: string) => void; label?: string; allowEmpty?: boolean }) {
  const companies = clients.filter((client) => client.kind === "company");
  const contacts = clients.filter((client) => client.kind === "contact");
  return (
    <Field label={label}>
      <Select value={value} onChange={(event) => onChange(event.target.value)} required={!allowEmpty}>
        <option value="">{allowEmpty ? "No client" : "Choose a CRM company or contact…"}</option>
        {companies.length > 0 ? (
          <optgroup label="Companies">
            {companies.map((client) => <option key={`company:${client.id}`} value={`company:${client.id}`}>{client.name}</option>)}
          </optgroup>
        ) : null}
        {contacts.length > 0 ? (
          <optgroup label="Contacts">
            {contacts.map((client) => <option key={`contact:${client.id}`} value={`contact:${client.id}`}>{client.email ? `${client.name} (${client.email})` : client.name}</option>)}
          </optgroup>
        ) : null}
      </Select>
    </Field>
  );
}

export interface ManualCustomer { kind: ClientKind; name: string; ref: string }
export const EMPTY_MANUAL: ManualCustomer = { kind: "company", name: "", ref: "" };

export function ManualCustomerFields({ value, onChange }: { value: ManualCustomer; onChange: (value: ManualCustomer) => void }) {
  return (
    <>
      <Field label="Customer type">
        <Select value={value.kind} onChange={(event) => onChange({ ...value, kind: event.target.value as ClientKind })}>
          <option value="company">Company</option>
          <option value="contact">Contact (person or sole trader)</option>
        </Select>
      </Field>
      <Field label="Customer name"><Input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} required /></Field>
      <Field label="Customer reference (CRM id)"><Input value={value.ref} onChange={(event) => onChange({ ...value, ref: event.target.value })} required /></Field>
    </>
  );
}

export function TaxCodeSelect({ value, onChange, label = "VAT", allowDefault }: { value: string; onChange: (value: string) => void; label?: string; allowDefault?: string }) {
  const { snapshot } = useBilling();
  const codes = snapshot.taxCodes ?? [];
  return (
    <Field label={label}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {allowDefault ? <option value="">{allowDefault}</option> : null}
        {codes.map((code) => <option key={code.code} value={code.code}>{code.label}</option>)}
      </Select>
    </Field>
  );
}

export function taxShort(code: string | null | undefined, codes: Snapshot["taxCodes"]): string {
  if (!code) return "Invoice rate";
  const found = (codes ?? []).find((c) => c.code === code);
  if (!found) return code;
  return found.rate > 0 ? `${Math.round(found.rate * 100)}%` : found.label;
}

// ── Files ──────────────────────────────────────────────────────────────────

export function openBase64Pdf(base64: string, filename: string, download = false): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  if (download) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    const win = window.open(url, "_blank", "noopener");
    if (!win) throw new Error("Allow pop-ups to open the PDF");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function openUrl(url: string): void {
  const win = window.open(url, "_blank", "noopener");
  if (!win) throw new Error("Allow pop-ups to open the file");
}

/** Presigned PUT straight to the private bucket; returns the key to register. */
export async function uploadFile(call: Call, purpose: "receipt" | "pop" | "bill", file: File): Promise<{ key: string; fileName: string; mime: string }> {
  const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "");
  const presign = await call<{ uploadUrl: string; key: string; headers: Record<string, string> }>("billing.upload-url", { purpose, fileName: file.name, mime, bytes: file.size });
  const res = await fetch(presign.uploadUrl, { method: "PUT", headers: presign.headers, body: file });
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status}). Check the bucket's CORS settings.`);
  return { key: presign.key, fileName: file.name, mime };
}

export function FilePicker({ label, onFile, accept = "application/pdf,image/*", disabled }: { label: string; onFile: (file: File) => void; accept?: string; disabled?: boolean }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 28, padding: "0 10px", fontSize: 12, fontWeight: 600, borderRadius: 9, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.secondaryFg, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}>
      {label}
      <input type="file" accept={accept} disabled={disabled} style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onFile(file); }} />
    </label>
  );
}
