/**
 * Presentational pieces of the Setup page (no host hooks, so they render in
 * tests). Links come in as `linkFor(href)` → anchor props.
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Button, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { SetupItem, SetupItemStatus } from "../kit-setup.js";

export type LinkPropsFor = (href: string) => AnchorHTMLAttributes<HTMLAnchorElement>;

export const STATUS_LABEL: Record<SetupItemStatus, string> = {
  done: "Done",
  missing: "Missing",
  optional: "Optional",
  blocked: "Waiting",
  unknown: "Unknown",
};

function statusColors(status: SetupItemStatus): { bg: string; fg: string } {
  if (status === "done") return { bg: "color-mix(in oklab, var(--chart-2) 18%, transparent)", fg: tokens.fg };
  if (status === "missing") return { bg: "color-mix(in oklab, var(--destructive) 16%, transparent)", fg: tokens.fg };
  if (status === "blocked") return { bg: "color-mix(in oklab, var(--chart-4) 20%, transparent)", fg: tokens.fg };
  return { bg: tokens.secondary, fg: tokens.secondaryFg };
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: SetupItemStatus | "neutral" }) {
  const colors = tone === "neutral" ? { bg: tokens.secondary, fg: tokens.secondaryFg } : statusColors(tone);
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      height: 22,
      padding: "0 8px",
      borderRadius: 999,
      fontSize: 11.5,
      fontWeight: 600,
      background: colors.bg,
      color: colors.fg,
      whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

export function StatusChip({ status }: { status: SetupItemStatus }) {
  return <Chip tone={status}>{STATUS_LABEL[status]}</Chip>;
}

export function ProgressBar({ done, total, label, size = "md" }: { done: number; total: number; label?: string; size?: "sm" | "md" }) {
  const percent = total === 0 ? 100 : Math.round((done / total) * 100);
  const height = size === "sm" ? 6 : 10;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {label ? (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: tokens.muted }}>
          <span>{label}</span>
          <span>{total === 0 ? "Nothing required" : `${done} of ${total} done · ${percent}%`}</span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        style={{ height, borderRadius: 999, background: tokens.secondary, overflow: "hidden" }}
      >
        <div style={{ width: `${percent}%`, height: "100%", borderRadius: 999, background: percent === 100 ? "var(--chart-2)" : tokens.primary, transition: "width 200ms ease" }} />
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 999,
        border: `1px solid ${checked ? "transparent" : tokens.border}`,
        background: checked ? tokens.primary : tokens.secondary,
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        flexShrink: 0,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span style={{
        position: "absolute",
        top: 2,
        left: checked ? 20 : 2,
        width: 16,
        height: 16,
        borderRadius: 999,
        background: checked ? tokens.primaryFg : tokens.bg,
        boxShadow: "0 1px 2px color-mix(in oklab, black 20%, transparent)",
        transition: "left 120ms ease",
      }} />
    </button>
  );
}

export function Card({ children, highlight }: { children: ReactNode; highlight?: boolean }) {
  return (
    <div style={{
      display: "grid",
      gap: 10,
      padding: 14,
      borderRadius: 12,
      border: `1px solid ${highlight ? tokens.ring : tokens.border}`,
      background: tokens.bg,
    }}>
      {children}
    </div>
  );
}

export function ModuleCard({ title, description, installed, enabled, onToggle, hint }: {
  title: string;
  description: string;
  installed: boolean | null;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  hint?: string | null;
}) {
  return (
    <Card highlight={enabled}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14 }}>{title}</strong>
            {installed === null ? null : <Chip>{installed ? "Installed" : "Not installed"}</Chip>}
          </div>
          <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>{description}</p>
        </div>
        <Switch checked={enabled} onChange={onToggle} label={`Use ${title}`} />
      </div>
      {hint ? <p style={{ margin: 0, fontSize: 12, color: tokens.fg, lineHeight: 1.4 }}>{hint}</p> : null}
    </Card>
  );
}

export function ItemLink({ href, label, linkFor }: { href: string; label?: string | null; linkFor: LinkPropsFor }) {
  const external = /^https?:\/\//i.test(href);
  const props = external ? { href, target: "_blank", rel: "noreferrer" } : linkFor(href);
  return (
    <a {...props} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>
      {label || "Open"}{external ? " ↗" : " →"}
    </a>
  );
}

export function ItemRow({ item, linkFor, onAction, busy }: {
  item: SetupItem;
  linkFor: LinkPropsFor;
  onAction?: (item: SetupItem) => void;
  busy?: boolean;
}) {
  const done = item.status === "done";
  return (
    <div style={{ display: "grid", gap: 8, padding: "12px 0", borderTop: `1px solid ${tokens.border}` }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <StatusChip status={item.status} />
        <strong style={{ fontSize: 13.5 }}>{item.title}</strong>
        {item.required ? null : <Chip>Optional</Chip>}
        <span style={{ flex: 1 }} />
        {item.href ? <ItemLink href={item.href} label={item.hrefLabel} linkFor={linkFor} /> : null}
        {!done && item.action && onAction ? (
          <Button type="button" onClick={() => onAction(item)} disabled={busy}>
            {busy ? "Working…" : item.action.label || "Do it for me"}
          </Button>
        ) : null}
      </div>
      {item.detail ? <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5 }}>{item.detail}</p> : null}
      {!done && item.steps?.length ? (
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, lineHeight: 1.6 }}>
          {item.steps.map((step, index) => <li key={index}>{step}</li>)}
        </ol>
      ) : null}
      {item.agentNext ? (
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
          <span style={{ color: tokens.muted }}>{done ? "The agent now: " : "Once done, the agent: "}</span>
          {item.agentNext}
        </p>
      ) : null}
    </div>
  );
}
