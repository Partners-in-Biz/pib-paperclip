/**
 * The Memory tab's presentational pieces (no host hooks, so they render in
 * tests). Tables become cards on a phone, like the Agents table; everything
 * else wraps. Colours come from `tone()`.
 */
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import {
  BookOpen,
  Bot,
  Button,
  FileText,
  Gauge,
  Info,
  Input,
  KpiCard,
  Lightbulb,
  MessageSquare,
  Pill,
  Select,
  Sparkles,
  StackedBar,
  TrendingUp,
  Users,
  breakAnywhere,
  relativeTime,
  tokens,
  tone,
  useIsNarrow,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { Card, Details, Muted, grid, type LinkPropsFor } from "./components.js";
import {
  LEARNED_HINT,
  METHOD_HELP,
  METHOD_LABEL,
  ORIGIN_HELP,
  ORIGIN_LABEL,
  STATUS_LABEL,
  agentRef,
  areaLabel,
  attentionCount,
  clientLabel,
  clientResolution,
  clientOptions,
  compareBrief,
  coverageLines,
  factActions,
  filtersActive,
  formatCount,
  isExpired,
  issuePath,
  jevShare,
  kindLabel,
  kindTone,
  memorySentence,
  methodTone,
  originOf,
  pageCount,
  pageLabel,
  scopeInfo,
  shortDate,
  SMART_MATCHING,
  sourcePath,
  truncate,
  type AgentRef,
  type BriefFact,
  type BriefLine,
  type BriefResult,
  type BriefRow,
  type BriefSummary,
  type CoverageLine,
  type FactFilters,
  type FactStatus,
  type MemoryClient,
  type MemoryFact,
  type MemoryLimits,
  type MemoryOverview,
  type MemoryReview,
  type StatusFilter,
} from "./memory-model.js";

const mono: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const th: CSSProperties = { textAlign: "left", fontSize: 11.5, fontWeight: 600, color: tokens.muted, padding: "8px 10px", borderBottom: `1px solid ${tokens.border}`, whiteSpace: "nowrap" };
const td: CSSProperties = { fontSize: 12.5, padding: "10px", borderBottom: `1px solid ${tokens.border}`, verticalAlign: "top" };
const heading: CSSProperties = { margin: 0, fontSize: 12.5, fontWeight: 650, color: tokens.fg };
const tableWrap: CSSProperties = { overflowX: "auto", WebkitOverflowScrolling: "touch", margin: "0 -4px", padding: "0 4px" };
const cardBox: CSSProperties = { display: "grid", gap: 8, padding: 12, borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0 };

export function SmallButton({ style, ...props }: Parameters<typeof Button>[0]) {
  return <Button type="button" variant="secondary" {...props} style={{ height: 28, fontSize: 12, padding: "0 10px", whiteSpace: "nowrap", ...(style ?? {}) }} />;
}

/** A host link that does not also trigger a clickable row around it. */
export function TextLink({ href, linkFor, children, style }: { href: string | null; linkFor: LinkPropsFor; children: ReactNode; style?: CSSProperties }) {
  if (!href) return <span style={style}>{children}</span>;
  const props = linkFor(href);
  return (
    <a
      {...props}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.stopPropagation();
        props.onClick?.(event);
      }}
      style={{ color: tokens.primary, fontWeight: 600, textDecoration: "none", ...breakAnywhere, ...style }}
    >
      {children}
    </a>
  );
}

/** A fact's id: technical, so only behind a Details disclosure. */
export function FactId({ id }: { id: string }) {
  return <code style={{ ...mono, fontSize: 11, color: tokens.muted }}>{id}</code>;
}

/** "Details" with a fact's (or brief's) ids and other technical bits. */
export function IdDetails({ lines }: { lines: Array<string | null | undefined | false> }) {
  const text = lines.filter(Boolean).join("\n");
  return text ? <Details raw={text} /> : null;
}

export function MethodPill({ method }: { method: string }) {
  const m = (method in METHOD_LABEL ? method : "baseline") as BriefRow["method"];
  return (
    <Pill size="sm" tone={methodTone(m)} icon={m === "jev" ? Sparkles : undefined} variant={m === "empty" || m === "search" ? "outline" : "soft"} title={METHOD_HELP[m]}>
      {METHOD_LABEL[m]}
    </Pill>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** Briefs pick facts by keywords; smart matching (an optional AI service) picks only what each task needs. */
function SmartMatchingNote({ href, linkFor }: { href: string; linkFor: LinkPropsFor }) {
  const t = tone("info");
  return (
    <div role="note" style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap", padding: "10px 12px", borderRadius: 12, background: t.soft, border: `1px solid ${t.border}` }}>
      <Info size={16} color={t.solid} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{ fontSize: 13, lineHeight: 1.5, flex: "1 1 240px", minWidth: 0 }}>
        <strong>{SMART_MATCHING}</strong>: briefs now pick facts by keywords. Turn on smart matching in the Cockpit settings to pick only what each task needs.
      </span>
      <a {...linkFor(href)} style={{ display: "inline-flex", alignItems: "center", minHeight: 32, fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none", whiteSpace: "nowrap" }}>Open Cockpit settings →</a>
    </div>
  );
}

/** "Agents asking memory first": finished runs in 7 days that started with a brief, per agent. */
export function CoverageSummary({ lines, linkFor, limit = 8 }: { lines: CoverageLine[]; linkFor: LinkPropsFor; limit?: number }) {
  if (lines.length === 0) return null;
  const shown = lines.slice(0, limit);
  const low = lines.filter((l) => l.low).length;
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: tokens.muted }}>
        Agents asking memory first · finished runs, last 7 days
        {low ? <span style={{ color: tone("warn").fg }}> · {low} {low === 1 ? "agent skips" : "agents skip"} it</span> : null}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
        {shown.map((l) => (
          <a key={l.agentId} {...linkFor(l.href)} title={`${l.name}: ${l.withBrief} of ${l.runs} finished runs started with a memory brief`} style={{ textDecoration: "none", maxWidth: "100%" }}>
            <Pill size="sm" tone={l.low ? "warn" : "neutral"} dot={l.low} icon={l.low ? undefined : Bot}>
              {l.name} {l.withBrief}/{l.runs}
            </Pill>
          </a>
        ))}
        {lines.length > shown.length ? <Pill size="sm" variant="outline">+{lines.length - shown.length} more</Pill> : null}
      </div>
    </div>
  );
}

export function MemoryHeader({ overview, agents, linkFor, settingsHref }: { overview: MemoryOverview; agents: AgentRef[]; linkFor: LinkPropsFor; settingsHref: string }) {
  const { stats, limits } = overview;
  const b = stats.briefs7d;
  const fb = stats.feedback30d;
  const share = jevShare(stats);
  return (
    <Card title="Company memory" icon={Lightbulb} subtitle="What the agents learned, and what each task gets from it.">
      <div style={{ display: "grid", gap: 6, maxWidth: 780 }}>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>{memorySentence(limits)}</p>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: tokens.muted }}>
          {LEARNED_HINT.before}<strong style={{ color: tokens.fg }}>{LEARNED_HINT.marker}</strong>{LEARNED_HINT.after}
        </p>
      </div>
      {overview.jevConfigured ? null : <SmartMatchingNote href={settingsHref} linkFor={linkFor} />}
      <div style={grid(150, 10)}>
        <KpiCard size="sm" label="Active facts" value={formatCount(stats.facts.active)} hint={`${formatCount(stats.facts.pinned)} pinned · ${formatCount(stats.facts.archived)} archived`} icon={BookOpen} />
        <KpiCard size="sm" label="Added this week" value={formatCount(stats.added7d)} hint={`${formatCount(stats.harvested7d ?? 0)} from Learned lines`} icon={TrendingUp} />
        <KpiCard size="sm" label="Clients covered" value={formatCount(stats.facts.clients)} hint="Plus company-wide facts" icon={Users} />
        <KpiCard size="sm" label="Briefs this week" value={formatCount(b.total)} hint={share === null ? "None yet" : share > 0 ? `${share}% by smart matching` : "Picked by keywords"} icon={FileText} />
        <KpiCard
          size="sm"
          label="Average brief"
          value={b.total ? `${formatCount(b.avgFacts, 1)} facts` : "–"}
          hint={`At most ${limits.briefMaxFacts} per task`}
          icon={Gauge}
        />
        <KpiCard
          size="sm"
          label="Feedback, 30 days"
          value={formatCount(fb.missing + fb.noise)}
          tone={fb.missing ? "warn" : "neutral"}
          hint={`${formatCount(fb.missing)} missing · ${formatCount(fb.noise)} not helpful${fb.wrong ? ` · ${formatCount(fb.wrong)} wrong` : ""}`}
          icon={MessageSquare}
        />
      </div>
      {b.total > 0 ? (
        <StackedBar
          title="How this week's briefs were picked"
          height={8}
          segments={[
            { key: "jev", label: "Smart matching", value: b.jev, tone: "info" },
            { key: "baseline", label: "Keywords", value: b.baseline, tone: "neutral" },
            { key: "empty", label: "Nothing matched", value: b.empty, color: "color-mix(in srgb, var(--muted-foreground) 35%, transparent)" },
          ]}
        />
      ) : null}
      <CoverageSummary lines={coverageLines(overview.coverage, agents)} linkFor={linkFor} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export function FactFiltersBar({ filters, search, clients, areas, onSearch, onChange, onClear }: {
  filters: FactFilters;
  search: string;
  clients: MemoryClient[];
  areas: string[];
  onSearch: (value: string) => void;
  onChange: (patch: Partial<FactFilters>) => void;
  onClear: () => void;
}) {
  const field: CSSProperties = { width: "auto", flex: "1 1 140px" };
  // Each client once, even when memory knows it under two refs.
  const options = clientOptions(clients);
  const selected = options.find((option) => option.refs.includes(filters.client))?.value ?? filters.client;
  const unknownClient = filters.client && filters.client !== "own" && !clients.some((c) => c.clientRef === filters.client);
  return (
    <div role="search" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
      <Input type="search" aria-label="Search facts" placeholder="Search facts or client names" value={search} onChange={(event) => onSearch(event.target.value)} style={{ width: "auto", flex: "2 1 220px" }} />
      <Select aria-label="Status" value={filters.status} onChange={(event) => onChange({ status: event.target.value as StatusFilter })} style={field}>
        <option value="active">Active</option>
        <option value="superseded">Replaced</option>
        <option value="archived">Archived</option>
        <option value="all">All statuses</option>
      </Select>
      <Select aria-label="Client" value={selected} onChange={(event) => onChange({ client: event.target.value })} style={{ ...field, flex: "1 1 170px" }}>
        <option value="">All clients</option>
        <option value="own">Company-wide</option>
        {options.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        {unknownClient ? <option value={filters.client}>Another client</option> : null}
      </Select>
      <Select aria-label="Area" value={filters.area} onChange={(event) => onChange({ area: event.target.value })} style={field}>
        <option value="">All areas</option>
        {areas.map((a) => <option key={a} value={a}>{areaLabel(a)}</option>)}
      </Select>
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, whiteSpace: "nowrap", cursor: "pointer" }}>
        <input type="checkbox" checked={filters.pinned} onChange={(event) => onChange({ pinned: event.target.checked })} />
        Pinned only
      </label>
      {filtersActive(filters) ? <SmallButton onClick={onClear}>Clear filters</SmallButton> : null}
    </div>
  );
}

export interface FactHandlers {
  onEdit: (fact: MemoryFact) => void;
  onPin: (fact: MemoryFact, pinned: boolean) => void;
  onStatus: (fact: MemoryFact, status: "active" | "archived") => void;
  onSupersede: (fact: MemoryFact) => void;
}

function FactButtons({ fact, busy, handlers, align }: { fact: MemoryFact; busy: boolean; handlers: FactHandlers; align: "start" | "end" }) {
  const label = truncate(fact.text, 50);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: align === "end" ? "flex-end" : "flex-start", minWidth: 0 }}>
      {factActions(fact).map((action) => {
        switch (action) {
          case "edit":
            return <SmallButton key={action} disabled={busy} aria-label={`Edit: ${label}`} onClick={() => handlers.onEdit(fact)}>Edit</SmallButton>;
          case "pin":
            return <SmallButton key={action} disabled={busy} aria-label={`Pin: ${label}`} onClick={() => handlers.onPin(fact, true)}>Pin</SmallButton>;
          case "unpin":
            return <SmallButton key={action} disabled={busy} aria-label={`Unpin: ${label}`} onClick={() => handlers.onPin(fact, false)}>Unpin</SmallButton>;
          case "archive":
            return <SmallButton key={action} disabled={busy} aria-label={`Archive: ${label}`} onClick={() => handlers.onStatus(fact, "archived")}>Archive</SmallButton>;
          case "restore":
            return <SmallButton key={action} disabled={busy} aria-label={`Restore: ${label}`} onClick={() => handlers.onStatus(fact, "active")}>Restore</SmallButton>;
          case "supersede":
            return <SmallButton key={action} disabled={busy} aria-label={`Replaced by a newer fact: ${label}`} onClick={() => handlers.onSupersede(fact)}>Replaced by…</SmallButton>;
          default:
            return null;
        }
      })}
    </div>
  );
}

function StatusPills({ fact, now }: { fact: Pick<MemoryFact, "status" | "supersededBy" | "expiresAt">; now: Date }) {
  const expired = isExpired(fact.expiresAt, now);
  return (
    <>
      {fact.status !== "active" ? (
        <Pill size="sm" variant="outline">{fact.status === "superseded" ? "Replaced by a newer fact" : STATUS_LABEL[fact.status]}</Pill>
      ) : null}
      {fact.expiresAt ? <Pill size="sm" variant="outline" tone={expired ? "warn" : "neutral"}>{expired ? `Expired ${shortDate(fact.expiresAt)}` : `Expires ${shortDate(fact.expiresAt)}`}</Pill> : null}
    </>
  );
}

function FactText({ fact, now }: { fact: MemoryFact; now: Date }) {
  return (
    <div style={{ display: "grid", gap: 5, minWidth: 0 }}>
      <span style={{ fontSize: 13, lineHeight: 1.45, color: fact.status === "active" ? tokens.fg : tokens.muted, ...breakAnywhere }}>{fact.text}</span>
      {fact.status !== "active" || fact.expiresAt ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
          <StatusPills fact={fact} now={now} />
        </div>
      ) : null}
    </div>
  );
}

function ScopePills({ fact }: { fact: Pick<MemoryFact, "area" | "kind" | "pinned"> }) {
  return (
    <>
      <Pill size="sm">{areaLabel(fact.area)}</Pill>
      <Pill size="sm" tone={kindTone(fact.kind)}>{kindLabel(fact.kind)}</Pill>
      {fact.pinned ? <Pill size="sm" tone="accent" dot title="Always in this client's and area's briefs">Pinned</Pill> : null}
    </>
  );
}

function noisy(fact: Pick<MemoryFact, "noiseCount" | "helpfulCount">): boolean {
  return fact.noiseCount >= 2 && fact.noiseCount > fact.helpfulCount;
}

function FeedbackCounts({ fact }: { fact: MemoryFact }) {
  const bad = noisy(fact);
  return (
    <span style={{ color: bad ? tone("warn").fg : tokens.muted, fontWeight: bad ? 600 : 400 }}>
      {formatCount(fact.helpfulCount)} helpful · {formatCount(fact.noiseCount)} not helpful
    </span>
  );
}

/** "by Sam" for an agent's fact (the badge already says when a person added it). */
function sourceBy(fact: MemoryFact, agents: AgentRef[]): string {
  if (originOf(fact) === "person") return "";
  const agent = agentRef(fact.createdByAgentId, agents);
  return agent ? `by ${agent.name}` : "";
}

function OriginPill({ fact }: { fact: MemoryFact }) {
  const origin = originOf(fact);
  return <Pill size="sm" variant="outline" tone={origin === "harvest" ? "info" : "neutral"} title={ORIGIN_HELP[origin]}>{ORIGIN_LABEL[origin]}</Pill>;
}

function FactCard({ fact, clients, agents, linkFor, busy, handlers, now }: { fact: MemoryFact; clients: MemoryClient[]; agents: AgentRef[]; linkFor: LinkPropsFor; busy: boolean; handlers: FactHandlers; now: Date }) {
  const issue = sourcePath(fact);
  const by = sourceBy(fact, agents);
  return (
    <div style={cardBox}>
      <FactText fact={fact} now={now} />
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
        <Pill size="sm" variant="outline">{clientLabel(fact.clientRef, fact.clientName, clients)}</Pill>
        <ScopePills fact={fact} />
        <OriginPill fact={fact} />
      </div>
      <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, ...breakAnywhere }}>
        Used {formatCount(fact.useCount)}× · <FeedbackCounts fact={fact} />
        {issue || by ? " · " : null}
        {issue ? <TextLink href={issue} linkFor={linkFor}>{fact.sourceIdentifier ?? "Source issue"}</TextLink> : null}
        {by ? `${issue ? " " : ""}${by}` : null}
        {" · "}updated {relativeTime(fact.updatedAt, now) ?? "–"}
      </div>
      <FactButtons fact={fact} busy={busy} handlers={handlers} align="start" />
    </div>
  );
}

export function FactsTable({ facts, clients, agents, linkFor, busyId, handlers, now }: {
  facts: MemoryFact[];
  clients: MemoryClient[];
  agents: AgentRef[];
  linkFor: LinkPropsFor;
  busyId: string | null;
  handlers: FactHandlers;
  now: Date;
}) {
  const narrow = useIsNarrow();
  if (narrow) {
    return <div style={{ display: "grid", gap: 10 }}>{facts.map((fact) => <FactCard key={fact.id} fact={fact} clients={clients} agents={agents} linkFor={linkFor} busy={busyId === fact.id} handlers={handlers} now={now} />)}</div>;
  }
  return (
    <div style={tableWrap}>
      <table style={{ width: "100%", minWidth: 1000, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Fact</th>
            <th style={th}>Client, area and kind</th>
            <th style={th}>Use</th>
            <th style={th}>Source</th>
            <th style={th}>Updated</th>
            <th style={{ ...th, textAlign: "right" }}><span className="pib-sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {facts.map((fact) => {
            const issue = sourcePath(fact);
            const by = sourceBy(fact, agents);
            return (
              <tr key={fact.id}>
                <td style={{ ...td, minWidth: 260 }}><FactText fact={fact} now={now} /></td>
                <td style={{ ...td, minWidth: 150 }}>
                  <div style={{ display: "grid", gap: 5, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, ...breakAnywhere }}>{clientLabel(fact.clientRef, fact.clientName, clients)}</span>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}><ScopePills fact={fact} /></div>
                  </div>
                </td>
                <td style={{ ...td, minWidth: 130, width: 130 }}>
                  <div style={{ display: "grid", gap: 3, minWidth: 110 }}>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>Used {formatCount(fact.useCount)}×</span>
                    <span style={{ fontSize: 11.5, color: tokens.muted }}>{fact.lastUsedAt ? `last ${relativeTime(fact.lastUsedAt, now) ?? "–"}` : "not used yet"}</span>
                    <span style={{ fontSize: 11.5 }}><FeedbackCounts fact={fact} /></span>
                  </div>
                </td>
                <td style={{ ...td, minWidth: 150 }}>
                  <div style={{ display: "grid", gap: 4, minWidth: 0, justifyItems: "start" }}>
                    <OriginPill fact={fact} />
                    {issue ? <TextLink href={issue} linkFor={linkFor}>{fact.sourceIdentifier ?? "Source issue"}</TextLink> : null}
                    {by ? <span style={{ fontSize: 11.5, color: tokens.muted, ...breakAnywhere }}>{by}</span> : null}
                  </div>
                </td>
                <td style={{ ...td, whiteSpace: "nowrap", minWidth: 80, color: tokens.muted }}>{relativeTime(fact.updatedAt, now) ?? "–"}</td>
                <td style={{ ...td, minWidth: 190 }}><FactButtons fact={fact} busy={busyId === fact.id} handlers={handlers} align="end" /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ total, page, loading, onPage }: { total: number; page: number; loading: boolean; onPage: (page: number) => void }) {
  const pages = pageCount(total);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", minWidth: 0 }}>
      <span aria-live="polite" style={{ fontSize: 12.5, color: tokens.muted, fontVariantNumeric: "tabular-nums" }}>{pageLabel(total, page)}{loading ? " · Loading…" : ""}</span>
      {pages > 1 ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <SmallButton disabled={page <= 0 || loading} onClick={() => onPage(page - 1)}>← Previous</SmallButton>
          <span style={{ fontSize: 12.5, color: tokens.muted, fontVariantNumeric: "tabular-nums" }}>Page {page + 1} of {pages}</span>
          <SmallButton disabled={page >= pages - 1 || loading} onClick={() => onPage(page + 1)}>Next →</SmallButton>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

function BriefTask({ brief, linkFor }: { brief: Pick<BriefSummary, "issueId" | "issueIdentifier" | "query">; linkFor: LinkPropsFor }) {
  const issue = issuePath(brief.issueIdentifier, brief.issueId);
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      {issue ? <TextLink href={issue} linkFor={linkFor}>{brief.issueIdentifier ?? "Issue"}</TextLink> : null}
      {brief.query ? <span title={brief.query} style={{ fontSize: issue ? 11.5 : 12.5, color: issue ? tokens.muted : tokens.fg, ...breakAnywhere }}>“{truncate(brief.query, 60)}”</span> : null}
      {!issue && !brief.query ? <span style={{ color: tokens.muted }}>–</span> : null}
    </div>
  );
}

function BriefCard({ brief, agents, linkFor, onOpen, now }: { brief: BriefSummary; agents: AgentRef[]; linkFor: LinkPropsFor; onOpen: (id: string) => void; now: Date }) {
  const agent = agentRef(brief.agentId, agents);
  return (
    <div style={cardBox}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", minWidth: 0 }}>
        <BriefTask brief={brief} linkFor={linkFor} />
        <MethodPill method={brief.method} />
      </div>
      <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, fontVariantNumeric: "tabular-nums", ...breakAnywhere }}>
        {agent ? <><TextLink href={agent.href} linkFor={linkFor} style={{ fontWeight: 500 }}>{agent.name}</TextLink> · </> : null}
        {brief.facts} of {formatCount(brief.totalFacts)} facts · {relativeTime(brief.createdAt, now) ?? "–"}
      </div>
      <div><SmallButton onClick={() => onOpen(brief.id)}>View brief</SmallButton></div>
    </div>
  );
}

export function BriefsList({ briefs, agents, linkFor, onOpen, now }: { briefs: BriefSummary[]; agents: AgentRef[]; linkFor: LinkPropsFor; onOpen: (id: string) => void; now: Date }) {
  const narrow = useIsNarrow();
  if (briefs.length === 0) return <Muted>No briefs yet. An agent gets one each time it starts a task.</Muted>;
  if (narrow) return <div style={{ display: "grid", gap: 10 }}>{briefs.map((b) => <BriefCard key={b.id} brief={b} agents={agents} linkFor={linkFor} onOpen={onOpen} now={now} />)}</div>;
  return (
    <div style={tableWrap}>
      <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Task</th>
            <th style={th}>Agent</th>
            <th style={th}>Picked by</th>
            <th style={th}>Facts</th>
            <th style={th}>When</th>
            <th style={th}><span className="pib-sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>
          {briefs.map((b) => {
            const agent = agentRef(b.agentId, agents);
            return (
              <tr key={b.id} onClick={() => onOpen(b.id)} style={{ cursor: "pointer" }}>
                <td style={{ ...td, minWidth: 140 }}><BriefTask brief={b} linkFor={linkFor} /></td>
                <td style={td}>{agent ? <TextLink href={agent.href} linkFor={linkFor} style={{ fontWeight: 500 }}>{agent.name}</TextLink> : <span style={{ color: tokens.muted }}>–</span>}</td>
                <td style={td}><MethodPill method={b.method} /></td>
                <td style={{ ...td, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{b.facts} of {formatCount(b.totalFacts)}</td>
                <td style={{ ...td, whiteSpace: "nowrap", color: tokens.muted }}>{relativeTime(b.createdAt, now) ?? "–"}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <SmallButton aria-label={`View ${b.issueIdentifier ? `the brief for ${b.issueIdentifier}` : "the brief"}`} onClick={(event) => { event.stopPropagation(); onOpen(b.id); }}>View</SmallButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface FactLineItem {
  id: string;
  text: string | null;
  clientRef: string | null;
  clientName: string | null;
  area: string | null;
  kind: string | null;
  pinned: boolean;
  status?: FactStatus;
  score: number | null;
  marker: { label: string; tone: ToneInput } | null;
}

function marker(line: Pick<BriefLine, "inBrief" | "inBaseline">, method: string): FactLineItem["marker"] {
  if (method !== "jev") return null;
  if (!line.inBrief) return { label: "Keywords only", tone: "neutral" };
  return line.inBaseline ? { label: "Keywords too", tone: "neutral" } : { label: "Smart matching only", tone: "info" };
}

function fromLine(line: BriefLine, method: string): FactLineItem {
  const f = line.fact;
  return { id: line.id, text: f?.text ?? null, clientRef: f?.clientRef ?? null, clientName: f?.clientName ?? null, area: f?.area ?? null, kind: f?.kind ?? null, pinned: f?.pinned ?? false, status: f?.status, score: line.score, marker: marker(line, method) };
}

function fromBriefFact(fact: BriefFact, method: string): FactLineItem {
  return { id: fact.id, text: fact.text, clientRef: fact.clientRef, clientName: fact.clientName, area: fact.area, kind: fact.kind, pinned: fact.pinned, score: fact.score, marker: marker({ inBrief: true, inBaseline: fact.inBaseline }, method) };
}

export function FactLines({ items, clients }: { items: FactLineItem[]; clients: MemoryClient[] }) {
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8, minWidth: 0 }}>
      {items.map((item) => (
        <li key={item.id} style={{ display: "grid", gap: 5, padding: "8px 10px", borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0 }}>
          <span style={{ fontSize: 13, lineHeight: 1.45, ...breakAnywhere }}>{item.text ?? <em style={{ color: tokens.muted }}>This fact is no longer stored.</em>}</span>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
            {item.text !== null ? <Pill size="sm" variant="outline">{clientLabel(item.clientRef, item.clientName, clients)}</Pill> : null}
            {item.area ? <Pill size="sm">{areaLabel(item.area)}</Pill> : null}
            {item.kind ? <Pill size="sm" tone={kindTone(item.kind)}>{kindLabel(item.kind)}</Pill> : null}
            {item.pinned ? <Pill size="sm" tone="accent" dot>Pinned</Pill> : null}
            {item.status && item.status !== "active" ? <Pill size="sm" variant="outline">{STATUS_LABEL[item.status]} now</Pill> : null}
            {item.score !== null ? <Pill size="sm" tone="info" icon={Sparkles} title="How sure smart matching was that this task needs the fact">{Math.round(item.score * 100)}% match</Pill> : null}
            {item.marker ? <Pill size="sm" variant="outline" tone={item.marker.tone}>{item.marker.label}</Pill> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The brief text exactly as the agent reads it. */
export function BriefBody({ body }: { body: string }) {
  return (
    <pre style={{ ...mono, margin: 0, padding: 12, borderRadius: 10, background: tokens.secondary, color: tokens.fg, fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto", ...breakAnywhere }}>
      {body}
    </pre>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 12.5, minWidth: 0 }}>
      <span style={{ color: tokens.muted, minWidth: 64 }}>{label}</span>
      <div style={{ flex: "1 1 180px", minWidth: 0, ...breakAnywhere }}>{children}</div>
    </div>
  );
}

/** A logged brief: what it included and, when smart matching chose, what keyword matching would have picked. Ids sit under Details. */
export function BriefDetail({ brief, facts, clients, agents, linkFor, now }: { brief: BriefRow; facts: MemoryFact[]; clients: MemoryClient[]; agents: AgentRef[]; linkFor: LinkPropsFor; now: Date }) {
  const cmp = compareBrief(brief, facts);
  const agent = agentRef(brief.agentId, agents);
  const clientNames = brief.clientRefs.length ? brief.clientRefs.map((ref) => clientLabel(ref, facts.find((f) => f.clientRef === ref)?.clientName ?? null, clients)).join(", ") : "Company-wide facts only";
  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <MethodPill method={brief.method} />
        <Pill size="sm">{brief.factIds.length} of {formatCount(brief.totalFacts)} facts</Pill>
      </div>
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <MetaRow label="Task"><BriefTask brief={brief} linkFor={linkFor} /></MetaRow>
        <MetaRow label="Agent">{agent ? <TextLink href={agent.href} linkFor={linkFor}>{agent.name}</TextLink> : "–"}</MetaRow>
        <MetaRow label="Client">{clientNames}</MetaRow>
        <MetaRow label="Area">{brief.area ? areaLabel(brief.area) : "Not set (every area)"}</MetaRow>
        <MetaRow label="When">{relativeTime(brief.createdAt, now) ?? "–"}</MetaRow>
      </div>
      <Muted>{METHOD_HELP[brief.method] ?? ""}</Muted>
      <section style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <h3 style={heading}>In the brief ({cmp.included.length})</h3>
        {cmp.included.length ? <FactLines items={cmp.included.map((l) => fromLine(l, brief.method))} clients={clients} /> : <Muted>No facts: {brief.totalFacts ? "none applied to this task." : "the company had no facts yet."}</Muted>}
      </section>
      {brief.method === "jev" ? (
        <section style={{ display: "grid", gap: 8, minWidth: 0 }}>
          <h3 style={heading}>What keyword matching would have picked</h3>
          {cmp.same ? (
            <Muted>The same {brief.factIds.length === 1 ? "fact" : "facts"}.</Muted>
          ) : (
            <>
              <Muted>
                {brief.baselineIds.length} {brief.baselineIds.length === 1 ? "fact" : "facts"}: {cmp.agreed} of the smart picks
                {cmp.baselineOnly.length ? `, plus ${cmp.baselineOnly.length} it left out:` : ", and nothing it left out."}
              </Muted>
              {cmp.baselineOnly.length ? <FactLines items={cmp.baselineOnly.map((l) => fromLine(l, brief.method))} clients={clients} /> : null}
            </>
          )}
        </section>
      ) : null}
      {brief.body ? (
        <details style={{ minWidth: 0 }}>
          <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>What the agent read</summary>
          <div style={{ marginTop: 8 }}><BriefBody body={brief.body} /></div>
        </details>
      ) : null}
      <IdDetails lines={[`Brief: ${brief.id}`, brief.factIds.length ? `Facts: ${brief.factIds.join(", ")}` : null, brief.model ? `Picked with: ${brief.model}` : null, brief.candidateCount ? `Facts compared: ${formatCount(brief.candidateCount)}` : null]} />
    </div>
  );
}

/** A preview: the brief body the agent would get, then its facts (with how sure smart matching was, when it picked). */
export function PreviewResult({ result, clients, linkFor }: { result: BriefResult; clients: MemoryClient[]; linkFor: LinkPropsFor }) {
  const issue = result.issue ? issuePath(result.issue.identifier, result.issue.id) : null;
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <MethodPill method={result.method} />
        <Pill size="sm">{result.facts.length} of {formatCount(result.totalFacts)} facts</Pill>
      </div>
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        {result.issue ? <MetaRow label="Task"><TextLink href={issue} linkFor={linkFor}>{result.issue.identifier ?? "Issue"}</TextLink> {result.issue.title}</MetaRow> : null}
        <MetaRow label="Client">{clientResolution(result.client)}</MetaRow>
        <MetaRow label="Area">{result.area ? areaLabel(result.area) : "Not set (every area)"}</MetaRow>
      </div>
      {result.facts.length ? (
        <section style={{ display: "grid", gap: 8, minWidth: 0 }}>
          <h3 style={heading}>Facts in the brief</h3>
          <FactLines items={result.facts.map((f) => fromBriefFact(f, result.method))} clients={clients} />
        </section>
      ) : <Muted>No stored fact applies to this task.</Muted>}
      <details style={{ minWidth: 0 }}>
        <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>What the agent reads</summary>
        <div style={{ marginTop: 8 }}><BriefBody body={result.body} /></div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ display: "grid", gap: 2 }}>
        <h3 style={heading}>{title}</h3>
        {hint ? <span style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.45 }}>{hint}</span> : null}
      </div>
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>{children}</div>
    </section>
  );
}

export interface AttentionHandlers {
  /** Keep `keepId`; `dropId` becomes superseded by it. `key` marks the busy item. */
  onKeep: (keepId: string, dropId: string, key: string) => void;
  onArchive: (id: string, key: string) => void;
  onShowScope: (clientRef: string | null, area: string) => void;
  /** Save a company-wide fact again for the client it names; the old one is superseded. */
  onMove?: (fact: MisfiledFactView, key: string) => void;
}

/** A company-wide fact that names a client (`memory.review` → `misfiled`). */
export interface MisfiledFactView {
  id: string;
  text: string;
  area: string;
  kind: string;
  clientRef: string;
  clientName: string;
}

export function AttentionList({ review, clients, agents, linkFor, limits, busyKey, handlers }: {
  review: MemoryReview;
  clients: MemoryClient[];
  agents: AgentRef[];
  linkFor: LinkPropsFor;
  limits: Pick<MemoryLimits, "scopeActiveCap">;
  busyKey: string | null;
  handlers: AttentionHandlers;
}) {
  const skipping = coverageLines(review.agentsSkippingMemory ?? [], agents);
  const stale = review.staleCount ? ` ${formatCount(review.staleCount)} active ${review.staleCount === 1 ? "fact has" : "facts have"} not been used in 120 days.` : "";
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <Muted>{review.verdict}{stale}</Muted>
      {attentionCount(review) === 0 ? <Muted>Nothing to clean up: no likely duplicates, unhelpful facts, facts under the wrong client, overfull clients or agents skipping memory.</Muted> : null}

      {review.misfiled?.length ? (
        <Group title={`Company-wide facts that name a client (${review.misfiled.length})`} hint="A company-wide fact reaches every client's brief. Move it to the client it names, so it stays with them.">
          {review.misfiled.map((m) => {
            const key = `move:${m.id}`;
            return (
              <div key={key} style={{ ...cardBox, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 4, flex: "1 1 260px", minWidth: 0 }}>
                  <span style={{ fontSize: 13, lineHeight: 1.45, ...breakAnywhere }}>{m.text}</span>
                  <span style={{ fontSize: 12, color: tokens.muted }}>Names <strong style={{ color: tokens.fg }}>{m.clientName}</strong></span>
                </div>
                {handlers.onMove ? <SmallButton disabled={busyKey === key} onClick={() => handlers.onMove!(m, key)}>{busyKey === key ? "Moving…" : `Move to ${m.clientName}`}</SmallButton> : null}
              </div>
            );
          })}
        </Group>
      ) : null}

      {review.duplicates.length ? (
        <Group title={`Likely duplicates (${review.duplicates.length})`} hint="Keep the better wording; the other one stops appearing in briefs.">
          {review.duplicates.map((d) => {
            const key = `dup:${d.a}:${d.b}`;
            const busy = busyKey === key;
            return (
              <div key={key} style={cardBox}>
                {[["A", d.a, d.aText], ["B", d.b, d.bText]].map(([label, id, text]) => (
                  <div key={label} style={{ display: "grid", gridTemplateColumns: "20px minmax(0, 1fr)", gap: 8, alignItems: "baseline" }}>
                    <strong style={{ fontSize: 12, color: tokens.muted }}>{label}</strong>
                    <span style={{ fontSize: 13, lineHeight: 1.45, ...breakAnywhere }}>{text}</span>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <Pill size="sm" variant="outline">{Math.round(d.overlap * 100)}% same words</Pill>
                  <SmallButton disabled={busy} onClick={() => handlers.onKeep(d.a, d.b, key)}>Keep A</SmallButton>
                  <SmallButton disabled={busy} onClick={() => handlers.onKeep(d.b, d.a, key)}>Keep B</SmallButton>
                </div>
              </div>
            );
          })}
        </Group>
      ) : null}

      {review.noisy.length ? (
        <Group title={`Facts that do not help (${review.noisy.length})`} hint="Agents said these did not help more often than they did. Archive keeps them but stops using them.">
          {review.noisy.map((n) => {
            const key = `noisy:${n.id}`;
            return (
              <div key={key} style={{ ...cardBox, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 4, flex: "1 1 260px", minWidth: 0 }}>
                  <span style={{ fontSize: 13, lineHeight: 1.45, ...breakAnywhere }}>{n.text}</span>
                  <span style={{ fontSize: 12, color: tokens.muted }}><span style={{ color: tone("warn").fg, fontWeight: 600 }}>{formatCount(n.noise)} times no help</span> vs {formatCount(n.helpful)} helpful</span>
                </div>
                <SmallButton disabled={busyKey === key} onClick={() => handlers.onArchive(n.id, key)}>Archive</SmallButton>
              </div>
            );
          })}
        </Group>
      ) : null}

      {skipping.length ? (
        <Group title={`Agents skipping memory (${skipping.length})`} hint="Fewer than half of their finished runs in the last 7 days started with a memory brief. Their skills say every task starts with memory-recall: remind them on their next task, or check their instructions.">
          {skipping.map((l) => (
            <div key={l.agentId} style={{ ...cardBox, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Bot size={15} color={tone("warn").solid} aria-hidden="true" style={{ flexShrink: 0 }} />
              <TextLink href={l.href} linkFor={linkFor}>{l.name}</TextLink>
              <span style={{ fontSize: 12.5, color: tokens.muted }}>{l.withBrief} of {l.runs} runs started with a brief</span>
            </div>
          ))}
        </Group>
      ) : null}

      {review.overCap.length ? (
        <Group title={`Too many facts for one client and area (${review.overCap.length})`} hint={`Above ${limits.scopeActiveCap} active facts for one client and area, the daily clean-up archives the least useful ones. Merge or archive some to choose yourself.`}>
          {review.overCap.map((o) => {
            const scope = scopeInfo(o.scope, clients);
            return (
              <div key={o.scope} style={{ ...cardBox, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 600, flex: "1 1 200px", minWidth: 0, ...breakAnywhere }}>{scope.label}</span>
                <span style={{ fontSize: 12.5, color: tone("warn").fg, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatCount(o.active)} of {formatCount(limits.scopeActiveCap)}</span>
                <SmallButton onClick={() => handlers.onShowScope(scope.clientRef, scope.area)}>Show these facts</SmallButton>
              </div>
            );
          })}
        </Group>
      ) : null}
    </div>
  );
}
