/**
 * Presentational pieces of the Setup page (no host hooks, so they render in
 * tests). Links come in as `linkFor(href)` → anchor props. Colours come from
 * the pib-plugin-ui palette: status tones for items, module accents for
 * modules. Step texts are short markdown (**bold**, `code`, [links](/path)),
 * rendered with the UI kit's `InlineText`.
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";
import {
  Button,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleQuestionMark,
  Hourglass,
  IconBadge,
  InlineText,
  Pill,
  ProgressBar as UiProgressBar,
  ProgressRing,
  moduleAccent,
  tokens,
  tone,
  type LucideIcon,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { MODULES, setupLeftLabel, setupProgress, type ModuleKey, type SetupItem, type SetupItemStatus, type SetupSummary } from "../kit-setup.js";

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

/** Short markdown from a plugin (**bold**, `code`, [links](/path)) as text, never raw. */
export function Md({ text, linkFor }: { text: string; linkFor?: LinkPropsFor }) {
  return <InlineText text={text} linkFor={linkFor as ((href: string) => Record<string, unknown>) | undefined} />;
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

/** "+ 13 optional", or null. */
export function optionalLabel(optionalLeft: number): string | null {
  return optionalLeft > 0 ? `+ ${optionalLeft} optional` : null;
}

/**
 * The page's summary: the ring, "N steps left" (kit `setupLeftLabel`, the same
 * number as the sidebar, the Finish setup issue and the Cockpit), the required
 * steps done, and the optional ones apart. One row per module; a row with a
 * `onOpen` jumps to that module on the checklist.
 */
export function ProgressOverview({ summary, modules, checking = false, onOpen, compact = false }: {
  summary: SetupSummary;
  modules: Array<{ key: string; module: ModuleKey; done: number | null; total: number | null }>;
  /** A module is still being checked: the numbers may move. */
  checking?: boolean;
  onOpen?: (key: string) => void;
  /** Phones: no per-module rows (the checklist lists them). */
  compact?: boolean;
}) {
  const left = summary.requiredLeft;
  const optional = optionalLabel(summary.optionalLeft);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "0 1 260px", minWidth: 0 }}>
        <ProgressRing done={summary.requiredDone} total={summary.requiredTotal} size={compact ? 64 : 84} label="Required setup steps done" />
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <strong style={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", color: left ? tone("warn").fg : tone("ok").fg }}>{setupLeftLabel(left)}</strong>
          <span style={{ fontSize: 12.5, color: tokens.muted }}>
            {summary.requiredTotal === 0 ? "Nothing required" : `${summary.requiredDone} of ${summary.requiredTotal} required steps done`}
            {checking ? " · checking…" : ""}
          </span>
          {optional ? <span style={{ fontSize: 12.5, color: tokens.muted }}>{optional} (nice to have)</span> : null}
        </div>
      </div>
      {compact ? null : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(210px, 100%), 1fr))", gap: "6px 16px", flex: "1 1 320px", minWidth: 0 }}>
          {modules.map((m) => <ModuleProgressRow key={m.key} module={m.module} done={m.done} total={m.total} onOpen={onOpen ? () => onOpen(m.key) : undefined} />)}
        </div>
      )}
    </div>
  );
}

export function ModuleProgressRow({ module, done, total, onOpen }: { module: ModuleKey; done: number | null; total: number | null; onOpen?: () => void }) {
  const accent = moduleAccent(module);
  const complete = done !== null && total !== null && done >= total;
  const body = (
    <>
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
    </>
  );
  const style = { display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: 10, alignItems: "center", minWidth: 0, padding: "6px 4px", borderRadius: 8 } as const;
  if (!onOpen) return <div style={style}>{body}</div>;
  return (
    <button type="button" className="pib-link-card" onClick={onOpen} aria-label={`${MODULES[module].title}: open on the checklist`} style={{ ...style, width: "100%", border: "none", background: "transparent", color: tokens.fg, textAlign: "left", fontFamily: "inherit", cursor: "pointer" }}>
      {body}
    </button>
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
    <a {...props} style={{ display: "inline-flex", alignItems: "center", minHeight: 36, fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none", whiteSpace: "nowrap" }}>
      {label || "Open"}{external ? " ↗" : " →"}
    </a>
  );
}

const disclosureSummary = { cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: tokens.muted, minHeight: 28, display: "flex", alignItems: "center", gap: 6, listStyle: "none" } as const;

/**
 * One setup step: title, why, where to fix it and "Do it for me". The exact
 * steps sit behind "How to do it", so a long checklist stays short.
 */
export function ItemRow({ item, linkFor, onAction, busy, first = false }: {
  item: SetupItem;
  linkFor: LinkPropsFor;
  onAction?: (item: SetupItem) => void;
  busy?: boolean;
  first?: boolean;
}) {
  const done = item.status === "done";
  const t = tone(STATUS_TONE[item.status]);
  const actions = (item.href || (!done && item.action && onAction)) ? (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      {!done && item.action && onAction ? (
        <Button type="button" onClick={() => onAction(item)} disabled={busy}>
          {busy ? "Working…" : item.action.label || "Do it for me"}
        </Button>
      ) : null}
      {item.href ? <ItemLink href={item.href} label={item.hrefLabel} linkFor={linkFor} /> : null}
    </div>
  ) : null;
  return (
    <div data-item={item.key} style={{ display: "grid", gridTemplateColumns: "3px minmax(0, 1fr)", gap: 12, padding: "12px 0", borderTop: first ? "none" : `1px solid ${tokens.border}` }}>
      <span aria-hidden="true" style={{ borderRadius: 999, background: t.solid, opacity: done ? 0.45 : item.status === "optional" || item.status === "unknown" ? 0.35 : 1 }} />
      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          {done ? <CircleCheck size={15} color={tone("ok").solid} aria-label="Done" style={{ flexShrink: 0 }} /> : null}
          <strong style={{ fontSize: 13.5, color: done ? tokens.muted : tokens.fg, overflowWrap: "anywhere" }}><Md text={item.title} /></strong>
          {item.status === "blocked" ? <Chip tone="blocked" icon={Hourglass}>Waiting on another step</Chip> : null}
          {item.status === "unknown" ? <Chip icon={CircleQuestionMark}>Not checked yet</Chip> : null}
        </div>
        {item.detail ? <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5, overflowWrap: "anywhere" }}><Md text={item.detail} linkFor={linkFor} /></p> : null}
        {!done && item.steps?.length ? (
          <details style={{ minWidth: 0 }}>
            <summary style={disclosureSummary}>How to do it ({item.steps.length} {item.steps.length === 1 ? "step" : "steps"})</summary>
            <ol style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: 12.5, lineHeight: 1.6, overflowWrap: "anywhere" }}>
              {item.steps.map((step, index) => <li key={index}><Md text={step} linkFor={linkFor} /></li>)}
            </ol>
          </details>
        ) : null}
        {item.agentNext ? (
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
            <span style={{ color: tokens.muted }}>{done ? "The agent now: " : "Once done, the agent: "}</span>
            <Md text={item.agentNext} linkFor={linkFor} />
          </p>
        ) : null}
        {actions}
      </div>
    </div>
  );
}

/** A folded list of steps ("3 optional steps", "5 done"). */
export function ItemFold({ label, items, linkFor, onAction, busyKey }: { label: string; items: SetupItem[]; linkFor: LinkPropsFor; onAction?: (item: SetupItem) => void; busyKey?: (item: SetupItem) => boolean }) {
  if (items.length === 0) return null;
  return (
    <details style={{ minWidth: 0, borderTop: `1px solid ${tokens.border}`, paddingTop: 8 }}>
      <summary style={disclosureSummary}>{label}</summary>
      <div>
        {items.map((item, index) => <ItemRow key={item.key} item={item} linkFor={linkFor} onAction={onAction} busy={busyKey?.(item)} first={index === 0} />)}
      </div>
    </details>
  );
}

/** Where a module group stands: "3 steps left", "Done", "+ 2 optional". */
export function groupState(items: SetupItem[]): { required: SetupItem[]; optional: SetupItem[]; done: SetupItem[]; left: number; label: string; tone: ToneInput } {
  const required = items.filter((item) => item.required && item.status !== "done");
  const optional = items.filter((item) => !item.required && item.status !== "done");
  const done = items.filter((item) => item.status === "done");
  if (required.length) return { required, optional, done, left: required.length, label: setupLeftLabel(required.length), tone: "warn" };
  if (optional.length) return { required, optional, done, left: 0, label: `Done · ${optionalLabel(optional.length)}`, tone: "ok" };
  return { required, optional, done, left: 0, label: "Done", tone: "ok" };
}

/**
 * One module on the checklist: a single line (icon, name, progress, state)
 * that opens to its steps. Steps left come first; optional and finished ones
 * are folded.
 */
export function ModuleGroup({ module, title, items, open, onToggle, linkFor, onAction, busyKey, footer, anchor }: {
  module: ModuleKey;
  title?: string;
  items: SetupItem[];
  open: boolean;
  onToggle: () => void;
  linkFor: LinkPropsFor;
  onAction?: (item: SetupItem) => void;
  busyKey?: (item: SetupItem) => boolean;
  /** Where the status came from, and "Check again". */
  footer?: ReactNode;
  anchor?: string;
}) {
  const accent = moduleAccent(module);
  const state = groupState(items);
  const progress = setupProgress(items);
  const name = title ?? MODULES[module].title;
  const bodyId = `${anchor ?? `module-${module}`}-steps`;
  return (
    <section id={anchor ?? `module-${module}`} style={{ borderRadius: 12, border: `1px solid ${state.left ? tone("warn").border : tokens.border}`, background: tokens.card, minWidth: 0, scrollMarginTop: 80 }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 52, padding: "8px 12px", border: "none", background: "transparent", color: tokens.fg, textAlign: "left", fontFamily: "inherit", cursor: "pointer", borderRadius: 12 }}
      >
        <IconBadge icon={accent.icon} accent={accent} size="sm" />
        <span style={{ display: "grid", gap: 1, flex: "1 1 auto", minWidth: 0 }}>
          <strong style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</strong>
          <span style={{ fontSize: 12, color: tokens.muted, fontVariantNumeric: "tabular-nums" }}>{progress.total ? `${progress.done} of ${progress.total} required done` : "Nothing required"}</span>
        </span>
        <Pill tone={state.tone} size="sm" dot>{state.label}</Pill>
        <ChevronRight size={16} aria-hidden="true" style={{ color: tokens.muted, flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms ease" }} />
      </button>
      {open ? (
        <div id={bodyId} style={{ display: "grid", gap: 4, padding: "0 12px 12px", minWidth: 0 }}>
          {state.required.length ? (
            <div>
              {state.required.map((item, index) => <ItemRow key={item.key} item={item} linkFor={linkFor} onAction={onAction} busy={busyKey?.(item)} first={index === 0} />)}
            </div>
          ) : <p style={{ margin: "4px 0", fontSize: 13, color: tokens.muted }}>{items.length ? "Every required step is done." : "Nothing to set up."}</p>}
          <ItemFold label={`${state.optional.length} optional ${state.optional.length === 1 ? "step" : "steps"} (nice to have)`} items={state.optional} linkFor={linkFor} onAction={onAction} busyKey={busyKey} />
          <ItemFold label={`${state.done.length} done`} items={state.done} linkFor={linkFor} />
          {footer ? <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", borderTop: `1px solid ${tokens.border}`, paddingTop: 8, fontSize: 12, color: tokens.muted, minWidth: 0 }}>{footer}</div> : null}
        </div>
      ) : null}
    </section>
  );
}
