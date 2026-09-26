import type { CSSProperties, ReactNode } from "react";
import { Button, CircleAlert, Icon, Info, Pill, Select, TriangleAlert, breakAnywhere, seriesColor, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { PLATFORM_LABELS, isSocialPlatform } from "../platforms.js";
import { ACCOUNT_TONE, DEST_TONE, PLATFORM_MONOGRAM, POST_TONE, platformIndex, toneOf } from "./series.js";
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

export function PostStatus({ status }: { status: string }) {
  return <Pill tone={toneOf(POST_TONE, status)} dot>{status === "review" ? "in review" : status.replace(/_/g, " ")}</Pill>;
}

export function DestinationStatus({ status }: { status: string }) {
  return <Pill tone={toneOf(DEST_TONE, status)} dot size="sm">{status}</Pill>;
}

export function AccountStatus({ status }: { status: string }) {
  const label = status === "needs_reconnect" ? "needs reconnect" : status;
  return <Pill tone={toneOf(ACCOUNT_TONE, status)} dot>{label}</Pill>;
}

/** A platform monogram in its categorical colour, e.g. "in" for LinkedIn. */
export function PlatformBadge({ platform, size = 28 }: { platform: string | null | undefined; size?: number }) {
  const key = platform ?? "";
  const color = seriesColor(platformIndex(key));
  return (
    <span
      role="img"
      aria-label={platformLabel(platform)}
      title={platformLabel(platform)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 3.5),
        display: "inline-grid",
        placeItems: "center",
        flexShrink: 0,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 34%, transparent)`,
        color,
        fontSize: Math.round(size * 0.4),
        fontWeight: 750,
        letterSpacing: "-0.02em",
        lineHeight: 1,
      }}
    >
      {PLATFORM_MONOGRAM[key] ?? (key.slice(0, 1).toUpperCase() || "?")}
    </span>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: "grid", gap: 10, padding: 14, borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.card, ...style }}>
      {children}
    </div>
  );
}

/** Selected / unselected look for a filter button. */
export function chipStyle(selected: boolean) {
  const a = tone("accent");
  return selected ? { background: a.soft, color: a.fg, borderColor: a.border } : undefined;
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

export function Banner({ tone: t, title, children }: { tone: "warn" | "error" | "info"; title: string; children?: ReactNode }) {
  const colors = tone(t === "error" ? "bad" : t);
  const glyph = t === "error" ? CircleAlert : t === "warn" ? TriangleAlert : Info;
  return (
    <div role="status" style={{ display: "grid", gap: 6, padding: "12px 14px", borderRadius: 12, border: `1px solid ${colors.border}`, borderLeft: `3px solid ${colors.solid}`, background: `linear-gradient(90deg, ${colors.soft}, transparent 60%), ${tokens.card}`, minWidth: 0 }}>
      <strong style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8, color: tokens.fg }}><Icon icon={glyph} size={15} color={colors.solid} />{title}</strong>
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
    <Select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Belongs to" disabled={disabled}>
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
  return <a href={href} target="_blank" rel="noopener" style={{ color: tokens.fg, fontSize: 12, textDecoration: "underline", ...breakAnywhere }}>{children}</a>;
}
