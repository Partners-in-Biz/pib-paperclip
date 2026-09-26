import type { CSSProperties, ReactNode } from "react";
import { StatusBadge, type StatusBadgeVariant } from "@paperclipai/plugin-sdk/ui";
import { Button, Select, tokens } from "@partnersinbiz/pib-plugin-ui";
import { PLATFORM_LABELS, isSocialPlatform } from "../platforms.js";
import type { ClientOption, Snapshot } from "./types.js";

/** Swallow an error that run() already showed. */
export function ignore(): void {
  // intentionally empty
}

export function platformLabel(platform: string | null | undefined): string {
  return platform && isSocialPlatform(platform) ? PLATFORM_LABELS[platform] : platform ?? "—";
}

export function fmtDate(value: string | null | undefined, timeZone?: string, withTime = true): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString(undefined, {
      timeZone,
      day: "numeric",
      month: "short",
      year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    });
  } catch {
    return date.toLocaleString();
  }
}

const POST_TONE: Record<string, StatusBadgeVariant> = {
  draft: "pending",
  review: "warning",
  approved: "info",
  scheduled: "info",
  publishing: "info",
  published: "ok",
  partially_published: "warning",
  failed: "error",
};

const DEST_TONE: Record<string, StatusBadgeVariant> = {
  pending: "pending",
  publishing: "info",
  retrying: "warning",
  published: "ok",
  failed: "error",
};

const ACCOUNT_TONE: Record<string, StatusBadgeVariant> = {
  connected: "ok",
  expiring: "warning",
  needs_reconnect: "error",
  disabled: "pending",
};

export function PostStatus({ status }: { status: string }) {
  return <StatusBadge label={status.replace("_", " ")} status={POST_TONE[status] ?? "pending"} />;
}

export function DestinationStatus({ status }: { status: string }) {
  return <StatusBadge label={status} status={DEST_TONE[status] ?? "pending"} />;
}

export function AccountStatus({ status }: { status: string }) {
  const label = status === "needs_reconnect" ? "reconnect" : status;
  return <StatusBadge label={label} status={ACCOUNT_TONE[status] ?? "pending"} />;
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: "grid", gap: 10, padding: 14, borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.card, ...style }}>
      {children}
    </div>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, ...style }}>{children}</span>;
}

export function Row({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", ...style }}>{children}</div>;
}

export function SmallButton(props: Parameters<typeof Button>[0]) {
  return <Button type="button" variant="secondary" {...props} style={{ height: 28, fontSize: 12, padding: "0 10px", ...(props.style ?? {}) }} />;
}

export function Banner({ tone, title, children }: { tone: "warn" | "error" | "info"; title: string; children?: ReactNode }) {
  const color = tone === "error" ? "var(--destructive)" : tone === "warn" ? "#b45309" : tokens.muted;
  return (
    <div role="status" style={{ display: "grid", gap: 6, padding: "12px 14px", borderRadius: 12, border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${color}`, background: tokens.card }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      {children ? <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.55 }}>{children}</div> : null}
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, padding: "2px 6px", borderRadius: 6, background: tokens.secondary, overflowWrap: "anywhere" }}>
      {children}
    </code>
  );
}

/** Params that put a new record in the page's scope. */
export function scopeParams(snapshot: Pick<Snapshot, "scope">): { client: string | null } {
  return { client: snapshot.scope };
}

/** "own work" or the client's name. */
export function scopeName(snapshot: Pick<Snapshot, "client">): string {
  return snapshot.client?.name ?? "own work";
}

/** "Own work", then CRM companies, then contacts. Value "" is own work, otherwise "company:<id>" / "contact:<id>". */
export function BelongsToSelect({ clients, value, onChange, disabled }: {
  clients: ClientOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const companies = clients.filter((c) => c.kind === "company");
  const contacts = clients.filter((c) => c.kind === "contact");
  const known = value === "" || clients.some((c) => c.client === value);
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Belongs to" disabled={disabled} style={{ minWidth: 200 }}>
      <option value="">Own work (Partners in Biz)</option>
      {!known ? <option value={value}>Current client</option> : null}
      {companies.length ? (
        <optgroup label="Companies">
          {companies.map((c) => <option key={c.client} value={c.client}>{c.name}{c.domain ? ` · ${c.domain}` : ""}</option>)}
        </optgroup>
      ) : null}
      {contacts.length ? (
        <optgroup label="Contacts">
          {contacts.map((c) => <option key={c.client} value={c.client}>{c.name}{c.email ? ` · ${c.email}` : ""}</option>)}
        </optgroup>
      ) : null}
    </Select>
  );
}

export function Avatar({ url, label }: { url: string | null; label: string }) {
  const size = 28;
  if (url) return <img src={url} alt="" width={size} height={size} style={{ borderRadius: 999, objectFit: "cover", flexShrink: 0 }} referrerPolicy="origin" />;
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: 999, display: "grid", placeItems: "center", background: tokens.secondary, fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
      {label.replace(/^@/, "").slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener" style={{ color: tokens.fg, fontSize: 12, textDecoration: "underline" }}>{children}</a>;
}
