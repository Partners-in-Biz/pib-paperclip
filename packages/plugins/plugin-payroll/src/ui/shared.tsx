/**
 * Small pieces every Payroll tab uses: money, status pills, notices, the
 * "More" menu for secondary actions and the one-line warning strip.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Pill, TriangleAlert, fluidColumns, formatMoney, tokens, tone, useIsNarrow, type ToneInput } from "@partnersinbiz/pib-plugin-ui";
import type { PageAlert } from "./alerts.js";
import { runStatusLabel, runTone, statusTone } from "./series.js";

/** Money as every PiB page and the payslip PDF show it: R 12,345.67 (pib-plugin-ui formatMoney). */
export function rand(minor: number | null | undefined): string {
  return formatMoney(Math.trunc(minor ?? 0));
}

/** "1234.56" in a form field from cents ("" for nothing). */
export function minorText(minor: number | null | undefined): string {
  return minor ? (minor / 100).toFixed(2) : "";
}

/** Cents from what a person typed ("R 1,234.50" → 123450); null when empty or not a number. */
export function toMinor(text: string): number | null {
  const cleaned = text.replace(/[R\s,]/gi, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

/** Small buttons in tables and cards (the host makes every button 40px tall on touch screens). */
export const small = { height: 30, fontSize: 12.5 } as const;

export function Money({ minor }: { minor: number }) {
  return <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{rand(minor)}</span>;
}

/** A toned status pill with a plain label. */
export function StatusPill({ status, label, tone: t }: { status: string; label?: string; tone?: ToneInput }) {
  const text = label ?? status.replace(/_/g, " ");
  return <Pill tone={t ?? statusTone(status)} dot size="sm">{text.charAt(0).toUpperCase() + text.slice(1)}</Pill>;
}

export function RunStatus({ status }: { status: string }) {
  return <StatusPill status={status} label={runStatusLabel(status)} tone={runTone(status)} />;
}

/** Form fields side by side, one per row on a phone. */
export function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: fluidColumns(160), gap: 12 }}>{children}</div>;
}

export function Muted({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5, ...style }}>{children}</p>;
}

/** A tinted box for one message (warning, error or info). */
export function Notice({ tone: t, children }: { tone: "warn" | "info" | "bad"; children: ReactNode }) {
  const colors = t === "info" ? null : tone(t);
  return (
    <div
      role={t === "info" ? "status" : "alert"}
      style={{
        fontSize: 13,
        lineHeight: 1.5,
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${colors ? colors.border : tokens.border}`,
        borderLeft: `3px solid ${colors ? colors.solid : tokens.border}`,
        background: colors ? colors.soft : tokens.secondary,
        color: tokens.fg,
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </div>
  );
}

/** Technical detail kept out of the way ("Details"). */
export function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details style={{ fontSize: 12.5, color: tokens.muted }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 28, display: "list-item" }}>{summary}</summary>
      <div style={{ marginTop: 6, display: "grid", gap: 6, overflowWrap: "anywhere" }}>{children}</div>
    </details>
  );
}

/** Opens a file the worker returned: a download link, or CSV text saved in the browser. */
export function download(result: { url?: string | null; content?: string | null; fileName: string; contentType?: string }) {
  if (result.url) {
    window.open(result.url, "_blank", "noopener");
    return;
  }
  if (result.content != null) {
    const blob = new Blob([result.content], { type: result.contentType ?? "text/csv" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = result.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 5_000);
  }
}

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** Destructive: red, and kept at the bottom by the caller. */
  danger?: boolean;
  disabled?: boolean;
}

/** "⋯ More": secondary and destructive actions, out of the way of the one main action. */
export function MoreMenu({ items, label = "More" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <Button type="button" variant="secondary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⋯ {label}
      </Button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 40,
            minWidth: 220,
            maxWidth: "min(300px, calc(100vw - 32px))",
            display: "grid",
            gap: 2,
            padding: 6,
            borderRadius: 12,
            border: `1px solid ${tokens.border}`,
            background: tokens.card,
            boxShadow: "0 12px 32px color-mix(in oklab, black 22%, transparent)",
          }}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className="pib-link-card"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              style={{
                appearance: "none",
                textAlign: "left",
                minHeight: 40,
                padding: "0 12px",
                border: "none",
                borderRadius: 8,
                background: "transparent",
                color: item.danger ? tokens.destructive : tokens.fg,
                fontSize: 13,
                fontWeight: 550,
                fontFamily: "inherit",
                cursor: item.disabled ? "not-allowed" : "pointer",
                opacity: item.disabled ? 0.5 : 1,
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A link that looks like a small button (tap target 40px on a phone). */
export function linkButtonStyle(narrow: boolean, primary = false): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: narrow ? 40 : 30,
    padding: "0 12px",
    borderRadius: 8,
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
    textDecoration: "none",
    flexShrink: 0,
    cursor: "pointer",
    fontFamily: "inherit",
    border: primary ? "1px solid transparent" : `1px solid ${tokens.border}`,
    background: primary ? tokens.primary : tokens.card,
    color: primary ? tokens.primaryFg : tokens.fg,
  };
}

/**
 * The page's warning lines: one short line each, with the link to the fix.
 * Rendered in the same place on every tab so the tabs never jump.
 */
export function AlertLines({ alerts, settingsLink, openTab }: {
  alerts: PageAlert[];
  /** Anchor props for the Payroll settings page (host `linkProps`). */
  settingsLink: Record<string, unknown>;
  openTab: (tab: "statutory") => void;
}) {
  const narrow = useIsNarrow();
  if (!alerts.length) return null;
  return (
    <div role="region" aria-label="Needs attention" style={{ display: "grid", gap: 6, minWidth: 0 }}>
      {alerts.map((alert) => {
        const colors = tone(alert.tone);
        const action = alert.action;
        return (
          <div
            key={alert.key}
            role={alert.tone === "bad" ? "alert" : "status"}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px 6px 12px", minHeight: 44, borderRadius: 10, border: `1px solid ${colors.border}`, borderLeft: `3px solid ${colors.solid}`, background: colors.soft, minWidth: 0 }}
          >
            <TriangleAlert size={15} aria-hidden="true" style={{ color: colors.fg, flexShrink: 0 }} />
            <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 13, lineHeight: 1.4, color: tokens.fg }}>{alert.text}</span>
            {action.kind === "settings" ? (
              <a {...settingsLink} style={linkButtonStyle(narrow)}>{alert.actionLabel} →</a>
            ) : (
              <button type="button" onClick={() => openTab(action.tab)} style={linkButtonStyle(narrow)}>{alert.actionLabel} →</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
