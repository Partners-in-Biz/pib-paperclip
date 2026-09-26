/**
 * Presentational pieces of the Setup page (no host hooks, so they render in
 * tests). Links come in as `linkFor(href)` → anchor props. Colours come from
 * the pib-plugin-ui palette: status tones for items, module accents for
 * modules.
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";
import {
  Button,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleQuestionMark,
  Hourglass,
  IconBadge,
  Pill,
  ProgressBar as UiProgressBar,
  ProgressRing,
  moduleAccent,
  tokens,
  tone,
  type LucideIcon,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { MODULES, setupProgress, type ModuleKey, type SetupItem, type SetupItemStatus } from "../kit-setup.js";

export type LinkPropsFor = (href: string) => AnchorHTMLAttributes<HTMLAnchorElement>;

export const STATUS_LABEL: Record<SetupItemStatus, string> = {
  done: "Done",
  missing: "Missing",
  optional: "Optional",
  blocked: "Waiting",
  unknown: "Unknown",
};

export const STATUS_TONE: Record<SetupItemStatus, ToneInput> = { done: "ok", missing: "bad", blocked: "warn", optional: "neutral", unknown: "neutral" };
export const STATUS_ICON: Record<SetupItemStatus, LucideIcon> = { done: CircleCheck, missing: CircleAlert, blocked: Hourglass, optional: CircleDot, unknown: CircleQuestionMark };

export function Chip({ children, tone: t = "neutral", icon }: { children: ReactNode; tone?: SetupItemStatus | "neutral"; icon?: LucideIcon }) {
  return <Pill tone={t === "neutral" ? "neutral" : STATUS_TONE[t]} icon={icon}>{children}</Pill>;
}

export function StatusChip({ status }: { status: SetupItemStatus }) {
  return <Chip tone={status} icon={STATUS_ICON[status]}>{STATUS_LABEL[status]}</Chip>;
}

/** Progress with the Setup wording ("3 of 5 done · 60%"). Green when complete; `module` tints it with the module accent. */
export function ProgressBar({ done, total, label, size = "md", module }: { done: number; total: number; label?: string; size?: "sm" | "md"; module?: ModuleKey }) {
  const percent = total === 0 ? 100 : Math.round((done / total) * 100);
  const color = percent === 100 ? tone("ok").solid : module ? moduleAccent(module).solid : undefined;
  return (
    <UiProgressBar
      done={done}
      total={total}
      label={label}
      showValue={!!label}
      valueText={total === 0 ? "Nothing required" : `${done} of ${total} done · ${percent}%`}
      size={size === "sm" ? "sm" : "lg"}
      color={color}
      ariaLabel={label ?? "Progress"}
    />
  );
}

/** Overall ring plus one bar per module, each in its module's accent. */
export function ProgressOverview({ done, total, modules }: {
  done: number;
  total: number;
  modules: Array<{ key: string; module: ModuleKey; done: number | null; total: number | null }>;
}) {
  const left = total - done;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "0 1 240px", minWidth: 0 }}>
        <ProgressRing done={done} total={total} size={84} label="Required setup items done" />
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <strong style={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{done} of {total}</strong>
          <span style={{ fontSize: 12.5, color: tokens.muted }}>required items done</span>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: left ? tone("warn").fg : tone("ok").fg }}>{total === 0 ? "Nothing required" : left ? `${left} left` : "All done"}</span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(220px, 100%), 1fr))", gap: "10px 16px", flex: "1 1 320px", minWidth: 0 }}>
        {modules.map((m) => <ModuleProgressRow key={m.key} module={m.module} done={m.done} total={m.total} />)}
      </div>
    </div>
  );
}

export function ModuleProgressRow({ module, done, total }: { module: ModuleKey; done: number | null; total: number | null }) {
  const accent = moduleAccent(module);
  const complete = done !== null && total !== null && done >= total;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: 10, alignItems: "center", minWidth: 0 }}>
      <IconBadge icon={accent.icon} accent={accent} size="xs" />
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
          <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{MODULES[module].title}</span>
          <span style={{ color: complete ? tone("ok").fg : tokens.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", fontWeight: complete ? 600 : 400 }}>
            {done === null || total === null ? "checking…" : complete ? "Done" : `${done}/${total}`}
          </span>
        </div>
        <UiProgressBar done={done ?? 0} total={total ?? 1} size="xs" color={complete ? tone("ok").solid : accent.solid} ariaLabel={`${MODULES[module].title} setup`} />
      </div>
    </div>
  );
}

/** Done/total for a module view, or nulls while checking. */
export function moduleCounts(status: { items: SetupItem[] } | null): { done: number | null; total: number | null } {
  if (!status) return { done: null, total: null };
  const p = setupProgress(status.items);
  return { done: p.done, total: p.total };
}

export function Switch({ checked, onChange, label, disabled, color }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; color?: string }) {
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
        minHeight: 22,
        borderRadius: 999,
        border: `1px solid ${checked ? "transparent" : tokens.border}`,
        background: checked ? (color ?? tokens.primary) : tokens.secondary,
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
        background: checked ? "#fff" : tokens.bg,
        boxShadow: "0 1px 2px color-mix(in oklab, black 20%, transparent)",
        transition: "left 120ms ease",
      }} />
    </button>
  );
}

export function Card({ children, highlight, module }: { children: ReactNode; highlight?: boolean; module?: ModuleKey }) {
  const accent = module ? moduleAccent(module) : null;
  return (
    <div style={{
      position: "relative",
      display: "grid",
      gap: 10,
      padding: 14,
      borderRadius: 12,
      border: `1px solid ${highlight ? (accent?.border ?? tokens.ring) : tokens.border}`,
      background: highlight && accent ? `linear-gradient(180deg, ${accent.soft}, transparent 60%), ${tokens.bg}` : tokens.bg,
      minWidth: 0,
    }}>
      {highlight && accent ? <span aria-hidden="true" style={{ position: "absolute", top: -1, left: -1, right: -1, height: 3, borderRadius: "12px 12px 0 0", background: accent.solid }} /> : null}
      {children}
    </div>
  );
}

export function ModuleCard({ title, description, installed, enabled, onToggle, hint, module }: {
  title: string;
  description: string;
  installed: boolean | null;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  hint?: string | null;
  module?: ModuleKey;
}) {
  const accent = module ? moduleAccent(module) : null;
  return (
    <Card highlight={enabled} module={module}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", minWidth: 0 }}>
          {accent ? <IconBadge icon={accent.icon} accent={enabled ? accent : undefined} size="md" /> : null}
          <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontSize: 14 }}>{title}</strong>
              {installed === null ? null : <Pill tone={installed ? "neutral" : "warn"} size="sm">{installed ? "Installed" : "Not installed"}</Pill>}
            </div>
            <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>{description}</p>
          </div>
        </div>
        <Switch checked={enabled} onChange={onToggle} label={`Use ${title}`} color={accent?.solid} />
      </div>
      {hint ? <p style={{ margin: 0, fontSize: 12, color: tone("info").fg, lineHeight: 1.4 }}>{hint}</p> : null}
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
  const t = tone(STATUS_TONE[item.status]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "3px minmax(0, 1fr)", gap: 12, padding: "12px 0", borderTop: `1px solid ${tokens.border}` }}>
      <span aria-hidden="true" style={{ borderRadius: 999, background: t.solid, opacity: done ? 0.45 : item.status === "optional" || item.status === "unknown" ? 0.35 : 1 }} />
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <StatusChip status={item.status} />
          <strong style={{ fontSize: 13.5, color: done ? tokens.muted : tokens.fg }}>{item.title}</strong>
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
    </div>
  );
}
