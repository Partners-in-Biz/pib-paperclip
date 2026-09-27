/**
 * Small pieces the CRM pages share: the lock toggle on a field ("Only people
 * can change this"), a field list with those locks, the ⋯ menu for
 * secondary and destructive actions, an email that truncates instead of
 * wrapping mid-word, and a one-line banner with a link.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, formatShortDate, relativeTime, tokens, tone, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { isLocked } from "./crm-view.js";

/** "5m ago" or "3d ago" within two weeks, else "28 Sep" (never the browser's own date format). */
export function whenText(at: string | number | Date | null | undefined): string | null {
  if (at === null || at === undefined || at === "") return null;
  const t = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (Number.isNaN(t)) return null;
  return Math.abs(Date.now() - t) < 14 * 86_400_000 ? relativeTime(t) : formatShortDate(t);
}

// ---------------------------------------------------------------------------
// Glyphs the UI kit does not re-export (lucide shapes, drawn inline)
// ---------------------------------------------------------------------------

export function LockGlyph({ locked, size = 14 }: { locked: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ display: "block", flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      {locked ? <path d="M7 11V7a5 5 0 0 1 10 0v4" /> : <path d="M7 11V7a5 5 0 0 1 9.9-1" />}
    </svg>
  );
}

export function DotsGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" style={{ display: "block" }}>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/** A field's lock: locked means only people can change it (agents may still fill it while empty). */
export function LockToggle({ locked, label, busy = false, onToggle }: { locked: boolean; label: string; busy?: boolean; onToggle: () => void }) {
  const narrow = useIsNarrow();
  const size = narrow ? 40 : 30;
  return (
    <button
      type="button"
      aria-pressed={locked}
      aria-label={`Only people can change ${label}`}
      title={locked ? "Only people can change this. Click to let agents change it too." : "Agents can change this. Click so only people can."}
      disabled={busy}
      onClick={onToggle}
      style={{
        appearance: "none",
        width: size,
        height: size,
        minHeight: size,
        flexShrink: 0,
        borderRadius: 8,
        display: "inline-grid",
        placeItems: "center",
        border: `1px solid ${locked ? tokens.border : "transparent"}`,
        background: locked ? tokens.secondary : "transparent",
        color: locked ? tokens.fg : tokens.muted,
        opacity: busy ? 0.55 : locked ? 1 : 0.7,
        cursor: busy ? "wait" : "pointer",
        fontFamily: "inherit",
      }}
    >
      <LockGlyph locked={locked} />
    </button>
  );
}

export interface FieldRow {
  key: string;
  label: string;
  value: ReactNode;
  /** The stored field names behind the row (e.g. next action = kind + due date). Defaults to `key`. */
  lockKeys?: string[];
  /** No lock on this row. */
  noLock?: boolean;
}

/**
 * Label / value rows, each with its lock when `onToggle` is given, and one
 * line under them saying what a lock means.
 */
export function FieldList({ rows, owned = [], busy = false, onToggle }: {
  rows: FieldRow[];
  owned?: string[];
  busy?: boolean;
  onToggle?: (keys: string[], lock: boolean, label: string) => void;
}) {
  const narrow = useIsNarrow();
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <dl style={{ margin: 0, display: "grid", minWidth: 0 }}>
        {rows.map((row, index) => {
          const keys = row.lockKeys ?? [row.key];
          const locked = isLocked(owned, keys);
          return (
            <div
              key={row.key}
              style={{
                display: "grid",
                gridTemplateColumns: `${narrow ? "84px" : "112px"} minmax(0, 1fr)`,
                columnGap: 12,
                alignItems: "center",
                minHeight: narrow ? 44 : 38,
                borderTop: index === 0 ? "none" : `1px solid ${tokens.border}`,
                minWidth: 0,
              }}
            >
              <dt style={{ fontSize: 12.5, color: tokens.muted }}>{row.label}</dt>
              <dd style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, minWidth: 0, fontSize: 13 }}>
                <span style={{ flex: "1 1 auto", minWidth: 0 }}>{row.value}</span>
                {onToggle && !row.noLock ? <LockToggle locked={locked} label={row.label} busy={busy} onToggle={() => onToggle(keys, !locked, row.label)} /> : null}
              </dd>
            </div>
          );
        })}
      </dl>
      {onToggle ? (
        <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: tokens.muted, lineHeight: 1.4 }}>
          <LockGlyph locked size={12} />
          <span>Locked: only people can change it. {narrow ? "Tap" : "Click"} a lock to switch.</span>
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Emails that never wrap mid-word
// ---------------------------------------------------------------------------

/**
 * One address on one line, cut with "…" when it does not fit. Hover shows it
 * in full; a tap opens it in full, broken after the @.
 */
export function EmailText({ email, style }: { email: string; style?: CSSProperties }) {
  const [open, setOpen] = useState(false);
  const at = email.indexOf("@");
  return (
    <span
      title={email}
      onClick={(event) => {
        event.stopPropagation();
        setOpen((value) => !value);
      }}
      style={{
        display: "block",
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: open ? "normal" : "nowrap",
        overflowWrap: open ? "anywhere" : "normal",
        cursor: "default",
        ...style,
      }}
    >
      {open && at > 0 ? <>{email.slice(0, at + 1)}<wbr />{email.slice(at + 1)}</> : email}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ⋯ menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Why it is disabled (shown under the label). */
  hint?: string;
}

/** Secondary and destructive actions, out of the way of the main one. */
export function MoreMenu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const narrow = useIsNarrow();
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div ref={box} style={{ position: "relative", flexShrink: 0 }}>
      <Button
        type="button"
        variant="secondary"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{ width: narrow ? 40 : 36, padding: 0, display: "inline-grid", placeItems: "center" }}
      >
        <DotsGlyph />
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 60,
            minWidth: 200,
            maxWidth: "calc(100vw - 32px)",
            padding: 6,
            borderRadius: 12,
            border: `1px solid ${tokens.border}`,
            background: tokens.card,
            boxShadow: "0 12px 32px color-mix(in oklab, black 22%, transparent)",
            display: "grid",
            gap: 2,
          }}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              style={{
                appearance: "none",
                border: "none",
                background: "transparent",
                textAlign: "left",
                display: "grid",
                gap: 2,
                minHeight: narrow ? 44 : 36,
                padding: "6px 10px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 550,
                fontFamily: "inherit",
                color: item.destructive ? tone("bad").fg : tokens.fg,
                cursor: item.disabled ? "not-allowed" : "pointer",
                opacity: item.disabled ? 0.55 : 1,
              }}
              className="pib-link-card"
            >
              <span>{item.label}</span>
              {item.hint ? <span style={{ fontSize: 11.5, fontWeight: 500, color: tokens.muted }}>{item.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One-line banner
// ---------------------------------------------------------------------------

/** One short line and a link to the fix (e.g. "Gmail isn't connected … Connect Gmail →"). */
export function LineBanner({ text, tone: t = "warn", link }: {
  text: string;
  tone?: "warn" | "info";
  link?: { label: string; props: Record<string, unknown> } | null;
}) {
  const narrow = useIsNarrow();
  const colors = t === "warn" ? tone("warn") : null;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        minWidth: 0,
        padding: "8px 12px",
        borderRadius: 10,
        border: `1px solid ${colors ? colors.border : tokens.border}`,
        background: colors ? colors.soft : tokens.secondary,
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      <span style={{ flex: "1 1 200px", minWidth: 0, color: tokens.fg }}>{text}</span>
      {link ? <a {...link.props} style={{ color: tokens.primary, fontWeight: 600, whiteSpace: "nowrap", textDecoration: "none", display: "inline-flex", alignItems: "center", minHeight: narrow ? 40 : undefined }}>{link.label} →</a> : null}
    </div>
  );
}
