/**
 * The Flows tab (the company graph, live) and its summary on the Overview.
 *
 * Each flow is a line of its stages, in order. On a wide card the stages sit
 * side by side like stations on a line; on a phone they stack. Each stage
 * shows its count (and amount), what is stuck and why, and who it waits on;
 * a switched-off stage is muted, with its reason and a "Fix in Setup" link.
 * Stuck work comes first: the stuck list at the top (what waits on you
 * first), and flows with stuck work before the others.
 *
 * The line layout depends on the card's width, not the window's, so its few
 * layout rules live in one style block with container queries. Colours stay
 * inline (the host only styles its own class names).
 */
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { MODULES } from "@partnersinbiz/pib-plugin-kit/setup";
import {
  Bot,
  Button,
  ChevronRight,
  CirclePause,
  HandCoins,
  Handshake,
  Hourglass,
  IconBadge,
  Landmark,
  Newspaper,
  Pill,
  Plug,
  Rocket,
  SectionCard,
  Send,
  Settings,
  Timer,
  UserRound,
  Wallet,
  Workflow,
  formatMoney,
  moduleAccent,
  tokens,
  tone,
  useIsNarrow,
  type LucideIcon,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { WAIT_ORDER, type FixGroup, type FlowKey, type FlowStageView, type FlowView, type FlowsView, type FlowWaitingOn, type OffKind, type StageWaits } from "../flows.js";
import { Muted, primaryLinkStyle, type LinkPropsFor } from "./components.js";

/** The Flows tab's address, and one flow on it. */
export const FLOWS_PATH = "/cockpit?tab=flows";
export const flowAnchor = (key: FlowKey) => `flow-${key}`;

export const FLOW_ICON: Record<FlowKey, LucideIcon> = {
  "lead-to-cash": HandCoins,
  onboarding: Rocket,
  content: Newspaper,
  campaigns: Send,
  books: Landmark,
  payroll: Wallet,
};

export const WAIT_ICON: Record<FlowWaitingOn, LucideIcon> = { agent: Bot, person: UserRound, customer: Handshake, system: Timer };
const OFF_ICON: Record<OffKind, LucideIcon> = { role: Bot, settings: Settings, installed: Plug, module: CirclePause };
export const WAIT_GROUP_TITLE: Record<FlowWaitingOn, string> = {
  person: "Waiting on you",
  agent: "Waiting on agents",
  customer: "Waiting on customers",
  system: "Waiting on the system",
};

// ---------------------------------------------------------------------------
// Layout (one style block)
// ---------------------------------------------------------------------------

const NODE = 36;
/** A station is at most this wide on a line. */
const STATION_MAX = 132;
/** A card needs this much width per station before a flow is drawn as a line. */
const STATION_MIN = 92;

function lineRules(n: number): string {
  const p = `.pib-flow-n${n}`;
  return `@container pib-flow (min-width:${n * STATION_MIN}px){`
    + `${p} .pib-flow-rail{grid-template-columns:repeat(${n},minmax(0,${STATION_MAX}px))}`
    + `${p} .pib-flow-stage{padding:0 4px}`
    + `${p} .pib-flow-hit{grid-template-columns:minmax(0,1fr);justify-items:center;text-align:center;row-gap:8px}`
    + `${p} .pib-flow-body{justify-items:center}`
    + `${p} .pib-flow-meta{justify-content:center}`
    + `${p} .pib-flow-stage::after{left:calc(50% + ${NODE / 2 + 4}px);right:calc(-50% + ${NODE / 2 + 4}px);top:${NODE / 2 + 1}px;bottom:auto;width:auto;height:2px;background:var(--pib-flow-line-h)}`
    + "}";
}

/** Stacked by default (phones); a line of stations once the card is wide enough for its stage count. */
export const FLOWS_CSS = [
  ".pib-flow{container-type:inline-size;container-name:pib-flow}",
  ".pib-flow-rail{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr)}",
  ".pib-flow-stage{position:relative;min-width:0;padding:0 0 14px}",
  ".pib-flow-stage:last-child{padding-bottom:0}",
  `.pib-flow-stage::after{content:"";position:absolute;left:${NODE / 2 - 1}px;top:${NODE + 6}px;bottom:0;width:2px;border-radius:2px;background:var(--pib-flow-line-v)}`,
  ".pib-flow-stage:last-child::after{display:none}",
  `.pib-flow-hit{display:grid;grid-template-columns:${NODE}px minmax(0,1fr);column-gap:12px;align-items:start;padding:2px 0;color:inherit;text-decoration:none;border-radius:10px;min-width:0}`,
  ".pib-flow-body{display:grid;gap:4px;min-width:0}",
  ".pib-flow-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}",
  ".pib-flow-card>summary{list-style:none}",
  ".pib-flow-card>summary::-webkit-details-marker{display:none}",
  ".pib-flow-card[open] .pib-flow-chev{transform:rotate(90deg)}",
  ...[2, 3, 4, 5, 6, 7, 8, 9].map(lineRules),
].join("\n");

const clamp = (lines: number): CSSProperties => ({ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" });

// ---------------------------------------------------------------------------
// One stage
// ---------------------------------------------------------------------------

export type StageState = "active" | "stuck" | "empty" | "none" | "off";

/** How a stage is drawn: switched off, stuck, busy, empty, or not counted yet. */
export function stageState(stage: Pick<FlowStageView, "off" | "stuck" | "count">): StageState {
  if (stage.off) return "off";
  if (stage.stuck > 0) return "stuck";
  if (stage.count === null) return "none";
  return stage.count === 0 ? "empty" : "active";
}

/** 7, 128, 1.2k, 14k. */
export function countText(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/** What a screen reader hears for a stage. */
export function stageSummary(stage: FlowStageView): string {
  if (stage.off) return `Switched off: ${stage.off.reason}.`;
  const count = stage.count === null ? "Not counted yet" : `${stage.count} at this stage`;
  return `${count}${stage.stuck ? `, ${stage.stuck} stuck` : ""}. Waits on ${waitsText(stage.waits)}.`;
}

function waitsText(waits: StageWaits): string {
  return waits.kind === "person" ? "you" : waits.kind === "agent" ? waits.label : waits.kind === "customer" ? "the customer" : "the system";
}

function StageNode({ stage, state }: { stage: FlowStageView; state: StageState }) {
  const accent = moduleAccent(stage.module);
  const warn = tone("warn");
  const look: CSSProperties = state === "stuck"
    ? { background: warn.soft, border: `2px solid ${warn.solid}`, color: warn.fg }
    : state === "active"
      ? { background: accent.soft, border: `2px solid ${accent.solid}`, color: accent.fg }
      : state === "empty"
        ? { background: tokens.card, border: `2px solid ${tokens.border}`, color: tokens.muted }
        : { background: tokens.card, border: `2px dashed ${tokens.border}`, color: tokens.muted };
  // A switched-off stage keeps its count when its module still reports one (leads still arrive without an Account Manager).
  const text = stage.count !== null ? countText(stage.count) : state === "off" ? "Off" : "–";
  return (
    <span
      aria-hidden="true"
      style={{ position: "relative", width: NODE, height: NODE, borderRadius: 999, display: "inline-grid", placeItems: "center", boxSizing: "border-box", flexShrink: 0, fontSize: text === "Off" || text.length > 3 ? 11.5 : 13.5, fontWeight: 650, fontVariantNumeric: "tabular-nums", ...look }}
    >
      {text}
      {stage.stuck > 0 ? (
        <span style={{ position: "absolute", top: -7, right: -10, minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, boxSizing: "border-box", background: warn.solid, color: "#fff", fontSize: 10.5, fontWeight: 700, display: "inline-grid", placeItems: "center", boxShadow: `0 0 0 2px ${tokens.card}` }}>
          {countText(stage.stuck)}
        </span>
      ) : null}
    </span>
  );
}

/** Who the stage waits on: the agent by name, "You", the customer or "Automatic". */
export function WaitsPill({ waits, short = false }: { waits: StageWaits; short?: boolean }) {
  const text = waits.kind === "agent"
    ? (short ? waits.name ?? waits.role ?? "An agent" : waits.label)
    : waits.kind === "person" ? (short ? "You" : "Waits on you") : waits.kind === "customer" ? "Customer" : "Automatic";
  return (
    <Pill size="sm" tone={waits.kind === "person" ? "accent" : "neutral"} icon={WAIT_ICON[waits.kind]} title={`Waits on ${waitsText(waits)}`}>
      {text}
    </Pill>
  );
}

/** The line to the next stage: dashed where either end is switched off, else tinted by this stage's module. */
function lineVars(stage: FlowStageView, next: FlowStageView | undefined): CSSProperties {
  if (!next) return {};
  const broken = !!stage.off || !!next.off;
  const color = broken ? tokens.border : `color-mix(in srgb, ${moduleAccent(stage.module).solid} 40%, ${tokens.border})`;
  return {
    ["--pib-flow-line-v" as string]: broken ? `repeating-linear-gradient(180deg, ${color} 0 5px, transparent 5px 9px)` : color,
    ["--pib-flow-line-h" as string]: broken ? `repeating-linear-gradient(90deg, ${color} 0 5px, transparent 5px 9px)` : color,
  } as CSSProperties;
}

const fixLinkStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: tokens.primary, textDecoration: "none", whiteSpace: "nowrap", minHeight: 24, display: "inline-flex", alignItems: "center" };

function Station({ stage, next, linkFor }: { stage: FlowStageView; next?: FlowStageView; linkFor: LinkPropsFor }) {
  const state = stageState(stage);
  const off = stage.off;
  // A module that is off or not installed has no page to open.
  const pageLink = !off || off.kind === "role" || off.kind === "settings";
  const label = (
    <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, color: off ? tokens.muted : tokens.fg, overflowWrap: "anywhere", ...clamp(2) }}>{stage.label}</span>
  );
  // An empty stage has nothing to add up ("R 0.00" under a 0 is noise).
  const amount = stage.amountMinor !== null && !off && (stage.count ?? 0) > 0
    ? <span style={{ fontSize: 12, color: tokens.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatMoney(stage.amountMinor, stage.currency ?? "ZAR")}</span>
    : null;
  const body = (
    <>
      <StageNode stage={stage} state={state} />
      <span className="pib-flow-body">
        {off && pageLink ? <a {...linkFor(stage.href)} style={{ color: "inherit", textDecoration: "none" }}>{label}</a> : label}
        {off ? null : <span className="pib-flow-meta">{amount}<WaitsPill waits={stage.waits} short /></span>}
        {stage.stuck > 0 ? (
          <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.35, color: tone("warn").fg, overflowWrap: "anywhere", ...clamp(3) }}>{stage.stuckReason ?? `${stage.stuck} stuck`}</span>
        ) : null}
        {off ? (
          <>
            <span style={{ fontSize: 12, lineHeight: 1.35, color: tokens.muted, overflowWrap: "anywhere" }}>{off.reason}</span>
            <a {...linkFor(off.href)} style={fixLinkStyle}>Fix in Setup →</a>
          </>
        ) : null}
        <span className="pib-sr-only">{stageSummary(stage)}</span>
      </span>
    </>
  );
  return (
    <li className="pib-flow-stage" style={lineVars(stage, next)} title={`${MODULES[stage.module]?.title ?? stage.module}: ${stage.description}`} data-stage={stage.key} data-state={state}>
      {off
        ? <div className="pib-flow-hit" style={{ opacity: 0.92 }}>{body}</div>
        : <a {...linkFor(stage.href)} className="pib-flow-hit pib-link-card">{body}</a>}
    </li>
  );
}

/** A flow's stages in order: a line of stations on a wide card, a stack on a phone (`stack`). */
export function FlowRail({ flow, linkFor, stack = false }: { flow: FlowView; linkFor: LinkPropsFor; stack?: boolean }) {
  const n = flow.stages.length;
  return (
    <div className={stack ? "pib-flow" : `pib-flow pib-flow-n${n}`} style={{ minWidth: 0 }}>
      <ol className="pib-flow-rail" aria-label={`${flow.title}: ${n} stages in order`}>
        {flow.stages.map((stage, index) => <Station key={stage.key} stage={stage} next={flow.stages[index + 1]} linkFor={linkFor} />)}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One flow
// ---------------------------------------------------------------------------

/** One short status for a flow: stuck, switched off, or running. */
export function flowStatus(flow: Pick<FlowView, "stuck" | "offStages" | "stages">): { text: string; tone: ToneInput } {
  if (flow.stuck > 0) return { text: `${flow.stuck} stuck`, tone: "warn" };
  if (flow.offStages > 0 && flow.offStages === flow.stages.length) return { text: "Switched off", tone: "neutral" };
  if (flow.offStages > 0) return { text: `${flow.offStages} of ${flow.stages.length} stages off`, tone: "neutral" };
  return { text: "Running", tone: "ok" };
}

function FlowCard({ flow, linkFor, narrow }: { flow: FlowView; linkFor: LinkPropsFor; narrow: boolean }) {
  const status = flowStatus(flow);
  const home = flow.stages[0]?.module ?? "cockpit";
  const pill = <Pill tone={status.tone} dot size="sm">{status.text}</Pill>;
  if (narrow) {
    // Phones: one line per flow; flows with stuck work start open.
    return (
      <details
        id={flowAnchor(flow.key)}
        className="pib-flow-card"
        open={flow.stuck > 0}
        style={{ borderRadius: 14, border: `1px solid ${flow.stuck > 0 ? tone("warn").border : tokens.border}`, background: tokens.card, padding: "10px 14px", minWidth: 0 }}
      >
        <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, minHeight: 44, minWidth: 0 }}>
          <IconBadge icon={FLOW_ICON[flow.key]} accent={flow.stuck > 0 ? tone("warn") : moduleAccent(home)} size="sm" />
          <strong style={{ fontSize: 14, flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>{flow.title}</strong>
          {pill}
          <ChevronRight className="pib-flow-chev" size={16} aria-hidden="true" style={{ color: tokens.muted, flexShrink: 0, transition: "transform 120ms ease" }} />
        </summary>
        <div style={{ display: "grid", gap: 12, paddingTop: 8, minWidth: 0 }}>
          <Muted>{flow.summary}</Muted>
          <FlowRail flow={flow} linkFor={linkFor} stack />
        </div>
      </details>
    );
  }
  return (
    <SectionCard
      id={flowAnchor(flow.key)}
      title={flow.title}
      subtitle={flow.summary}
      icon={FLOW_ICON[flow.key]}
      accent={home}
      tone={flow.stuck > 0 ? "warn" : undefined}
      strip={flow.stuck > 0}
      actions={pill}
    >
      <FlowRail flow={flow} linkFor={linkFor} />
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// The top of the tab: the sentence, what switches the graph back on, what is stuck
// ---------------------------------------------------------------------------

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "3 stages off: New leads, Open deals and Quotes to send" (the first three, then how many more). */
export function stageList(stages: Array<Pick<FlowStageView, "label">>): string {
  const names = stages.map((stage) => stage.label);
  const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : joinAnd(names);
  return `${names.length} ${names.length === 1 ? "stage" : "stages"} off: ${list}`;
}

function FixList({ fixes, linkFor }: { fixes: FixGroup[]; linkFor: LinkPropsFor }) {
  const narrow = useIsNarrow();
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 650, color: tokens.muted }}>Switch these back on</span>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", minWidth: 0 }}>
        {fixes.map((fix, index) => (
          <li key={fix.key} data-fix={fix.key} style={{ display: "flex", gap: 12, alignItems: narrow ? "flex-start" : "center", padding: "10px 0", borderTop: index ? `1px solid ${tokens.border}` : "none", minWidth: 0 }}>
            <IconBadge icon={OFF_ICON[fix.kind]} tone="neutral" size="sm" />
            <span style={{ display: "grid", gap: 2, flex: "1 1 auto", minWidth: 0 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}>{fix.reason}</span>
              <span style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere" }}>{stageList(fix.stages)}</span>
              {narrow ? <a {...linkFor(fix.href)} style={{ ...primaryLinkStyle, minHeight: 40, marginTop: 6, justifySelf: "start" }}>Fix in Setup</a> : null}
            </span>
            {narrow ? null : <a {...linkFor(fix.href)} style={{ ...primaryLinkStyle, minHeight: 36, flexShrink: 0 }}>Fix in Setup</a>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A line under the sentence when numbers are missing: none reported yet, or some stages still to report. */
export function numbersNote(view: Pick<FlowsView, "reported" | "flows">): string | null {
  const waiting = view.flows.flatMap((flow) => flow.stages).filter((stage) => !stage.off && stage.count === null).length;
  if (view.reported === 0) return "No module reports its numbers yet. They show here as each module is updated, and every hour after that.";
  if (waiting === 0) return null;
  return `${waiting} ${waiting === 1 ? "stage has" : "stages have"} no numbers yet (marked –). They show here once their modules are updated.`;
}

export function FlowsStatus({ view, linkFor }: { view: FlowsView; linkFor: LinkPropsFor }) {
  const stuck = view.stuck.length;
  const note = numbersNote(view);
  return (
    <SectionCard title="Flows" icon={Workflow} tone={stuck ? "warn" : view.off ? "neutral" : "ok"} strip subtitle="How work moves through the company, stage by stage. Live.">
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.45, overflowWrap: "anywhere" }}>{view.sentence}</p>
      {stuck || view.reported ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {stuck
            ? <Pill tone="warn" dot>{view.stuckItems} stuck in {stuck} {stuck === 1 ? "stage" : "stages"}</Pill>
            : <Pill tone="ok" dot>Nothing is stuck</Pill>}
        </div>
      ) : null}
      {view.fixes.length ? <FixList fixes={view.fixes} linkFor={linkFor} /> : null}
      {note ? <Muted>{note}</Muted> : null}
    </SectionCard>
  );
}

function StuckRow({ stage, linkFor, first, narrow }: { stage: FlowStageView; linkFor: LinkPropsFor; first: boolean; narrow: boolean }) {
  const warn = tone("warn");
  const age = stage.oldestDays !== null && !/\bdays?\b/.test(stage.stuckReason ?? "") ? `oldest ${stage.oldestDays} ${stage.oldestDays === 1 ? "day" : "days"}` : null;
  const meta = [
    stage.stuckReason,
    age,
    stage.amountMinor !== null ? formatMoney(stage.amountMinor, stage.currency ?? "ZAR") : null,
    stage.off?.kind === "role" ? stage.off.reason : stage.waits.kind === "agent" ? `waits on ${stage.waits.label}` : null,
    stage.off && stage.off.kind !== "role" ? stage.off.reason : null,
  ].filter(Boolean).join(" · ");
  const of = stage.count !== null && stage.count > stage.stuck ? `${stage.stuck} of ${stage.count} stuck` : `${stage.stuck} stuck`;
  return (
    <li>
      <a
        {...linkFor(stage.href)}
        className="pib-link-card"
        data-stuck={stage.key}
        style={{ display: "grid", gridTemplateColumns: "3px minmax(0, 1fr) auto", gap: 12, alignItems: "center", minHeight: 48, padding: "10px 4px", borderTop: first ? "none" : `1px solid ${tokens.border}`, color: tokens.fg, textDecoration: "none", minWidth: 0 }}
      >
        <span aria-hidden="true" style={{ alignSelf: "stretch", borderRadius: 999, background: warn.solid }} />
        <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
          <span style={{ display: "flex", gap: "2px 8px", alignItems: "baseline", flexWrap: "wrap", minWidth: 0 }}>
            <strong style={{ fontSize: 13.5, overflowWrap: "anywhere" }}>{stage.label}</strong>
            <span style={{ fontSize: 12, color: tokens.muted }}>{stage.flowTitle}</span>
          </span>
          {meta ? <span style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere", ...(narrow ? clamp(2) : {}) }}>{meta}</span> : null}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Pill tone="warn" size="sm">{narrow ? `${stage.stuck} stuck` : of}</Pill>
          {narrow
            ? <ChevronRight size={18} aria-hidden="true" style={{ color: tokens.muted, flexShrink: 0 }} />
            : <span style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, whiteSpace: "nowrap" }}>Open →</span>}
        </span>
      </a>
    </li>
  );
}

/** A phone shows this many stuck stages first, then "Show all". */
export const STUCK_SHOWN_NARROW = 5;

/** Stuck stages in the order the list shows them: waiting on you first, then agents, customers, the system; worst first in each. */
export function stuckGroups(stages: FlowStageView[], limit?: number): Array<{ kind: FlowWaitingOn; stages: FlowStageView[] }> {
  const ordered = WAIT_ORDER.flatMap((kind) => stages.filter((stage) => stage.waitingOn === kind));
  const shown = limit === undefined ? ordered : ordered.slice(0, limit);
  return WAIT_ORDER.map((kind) => ({ kind, stages: shown.filter((stage) => stage.waitingOn === kind) })).filter((group) => group.stages.length > 0);
}

/** Every stuck stage, grouped by who it waits on (you first), worst first in each group. */
export function StuckList({ stages, linkFor }: { stages: FlowStageView[]; linkFor: LinkPropsFor }) {
  const narrow = useIsNarrow();
  const [all, setAll] = useState(false);
  const capped = narrow && !all && stages.length > STUCK_SHOWN_NARROW;
  const groups = stuckGroups(stages, capped ? STUCK_SHOWN_NARROW : undefined);
  return (
    <SectionCard id="stuck" title="Stuck now" icon={Hourglass} tone="warn" subtitle="Work that waits too long, worst first. What waits on you comes first.">
      {groups.map((group) => (
        <div key={group.kind} data-group={group.kind} style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 650, color: tokens.muted }}>{WAIT_GROUP_TITLE[group.kind]} ({stages.filter((stage) => stage.waitingOn === group.kind).length})</span>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", minWidth: 0 }}>
            {group.stages.map((stage, index) => <StuckRow key={stage.key} stage={stage} linkFor={linkFor} first={index === 0} narrow={narrow} />)}
          </ul>
        </div>
      ))}
      {capped ? (
        <Button type="button" variant="secondary" style={{ minHeight: 40, justifySelf: "start" }} onClick={() => setAll(true)}>
          Show all {stages.length} stuck stages
        </Button>
      ) : null}
    </SectionCard>
  );
}

/**
 * The Flows tab: the sentence and what switches the graph back on, what is
 * stuck, then every flow (stuck ones first). `focus` is the address's hash
 * (`#flow-books`), to open and show one flow.
 */
export function FlowsPanel({ view, linkFor, focus }: { view: FlowsView; linkFor: LinkPropsFor; focus?: string | null }) {
  const narrow = useIsNarrow();
  useEffect(() => {
    const id = (focus ?? "").replace(/^#/, "");
    if (!/^(flow-[a-z-]+|stuck)$/.test(id) || typeof document === "undefined") return;
    const target = document.getElementById(id);
    if (!target) return;
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <style>{FLOWS_CSS}</style>
      <FlowsStatus view={view} linkFor={linkFor} />
      {view.stuck.length ? <StuckList stages={view.stuck} linkFor={linkFor} /> : null}
      <div style={{ display: "grid", gap: narrow ? 10 : 16, minWidth: 0 }}>
        {view.flows.map((flow) => <FlowCard key={flow.key} flow={flow} linkFor={linkFor} narrow={narrow} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The summary on the Overview
// ---------------------------------------------------------------------------

/** A flow as a row of small dots: amber stuck, module colour busy, pale empty, dashed off. */
export function MiniRail({ flow, compact = false }: { flow: FlowView; compact?: boolean }) {
  const warn = tone("warn");
  const size = compact ? 10 : 11;
  const gap = compact ? 5 : 12;
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", flexWrap: "nowrap", minWidth: 0 }}>
      {flow.stages.map((stage, index) => {
        // Stuck work shows even where a stage is switched off.
        const state = stage.stuck > 0 ? "stuck" : stageState(stage);
        const accent = moduleAccent(stage.module);
        const dot: CSSProperties = state === "stuck"
          ? { background: warn.solid, boxShadow: `0 0 0 3px ${warn.soft}` }
          : state === "active"
            ? { background: accent.solid }
            : state === "empty"
              ? { background: accent.soft, border: `1.5px solid ${accent.border}` }
              : { background: "transparent", border: `1.5px ${state === "off" ? "dashed" : "solid"} ${tokens.border}` };
        const previous = flow.stages[index - 1];
        const broken = !!stage.off || !!previous?.off;
        return (
          <Fragment key={stage.key}>
            {index ? <span style={{ width: gap, height: 0, borderTop: `2px ${broken ? "dotted" : "solid"} ${tokens.border}`, flexShrink: 0 }} /> : null}
            <span style={{ width: size, height: size, borderRadius: 999, boxSizing: "border-box", flexShrink: 0, ...dot }} />
          </Fragment>
        );
      })}
    </span>
  );
}

function SummaryRow({ flow, linkFor, first, narrow }: { flow: FlowView; linkFor: LinkPropsFor; first: boolean; narrow: boolean }) {
  const status = flowStatus(flow);
  const colour = status.tone === "neutral" ? tokens.muted : tone(status.tone).fg;
  const statusText: ReactNode = <span style={{ fontSize: 12.5, fontWeight: 600, color: colour, whiteSpace: "nowrap", justifySelf: "end" }}>{status.text}</span>;
  const title = <span style={{ fontSize: 13.5, fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{flow.title}</span>;
  return (
    <li>
      <a
        {...linkFor(`${FLOWS_PATH}#${flowAnchor(flow.key)}`)}
        className="pib-link-card"
        style={{
          display: "grid",
          gridTemplateColumns: narrow ? "minmax(0, 96px) minmax(0, 1fr) auto" : "minmax(0, 150px) minmax(0, 1fr) auto",
          gap: narrow ? 10 : 14,
          alignItems: "center",
          minHeight: 44,
          padding: "8px 4px",
          borderTop: first ? "none" : `1px solid ${tokens.border}`,
          color: tokens.fg,
          textDecoration: "none",
          minWidth: 0,
        }}
      >
        {title}
        <span style={{ minWidth: 0, overflow: "hidden" }}><MiniRail flow={flow} compact={narrow} /></span>
        {statusText}
        <span className="pib-sr-only">{`${flow.stages.length} stages. ${status.text}.`}</span>
      </a>
    </li>
  );
}

/** The Overview's compact graph: the sentence, and each flow as a row of dots. */
export function FlowsSummary({ view, linkFor }: { view: FlowsView; linkFor: LinkPropsFor }) {
  const narrow = useIsNarrow();
  return (
    <SectionCard
      id="flows"
      title="Flows"
      icon={Workflow}
      tone={view.stuck.length ? "warn" : undefined}
      subtitle={view.sentence}
      actions={<a {...linkFor(FLOWS_PATH)} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none", whiteSpace: "nowrap", minHeight: 32, display: "inline-flex", alignItems: "center" }}>Open Flows →</a>}
    >
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", minWidth: 0 }}>
        {view.flows.map((flow, index) => <SummaryRow key={flow.key} flow={flow} linkFor={linkFor} first={index === 0} narrow={narrow} />)}
      </ul>
    </SectionCard>
  );
}
