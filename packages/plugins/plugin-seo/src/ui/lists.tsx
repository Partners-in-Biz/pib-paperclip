/**
 * The sprint's data tabs: keywords, backlinks, content, audits and
 * optimizations. On a phone each list is compact rows (a title, one muted
 * line, the whole row opens the item); on a desktop a table.
 */
import { useState, type ReactNode } from "react";
import { DataTable } from "@paperclipai/plugin-sdk/ui";
import {
  Activity,
  BarList,
  Button,
  ChartColumn,
  ChartLine,
  ChartPie,
  CircleAlert,
  CircleCheck,
  CompactRows,
  DonutChart,
  EmptyState,
  Eye,
  Field,
  FileText,
  Gauge,
  HeartPulse,
  Input,
  KpiCard,
  Lightbulb,
  ListChecks,
  Modal,
  Pill,
  Rocket,
  SectionCard,
  Select,
  Share2,
  StackedBar,
  StatusDot,
  Target,
  TextArea,
  Toolbar,
  breakAnywhere,
  fluidColumns,
  formatCompact,
  formatDate,
  formatShortDate,
  tokens,
  tone,
  useIsNarrow,
} from "@partnersinbiz/pib-plugin-ui";
import { plural } from "../engine/plain.js";
import { RawDetails, fmt, pct, shortUrl, small, top } from "./parts.js";
import { backlinkSegments, optimizationSegments, positionBuckets, positionTrendTone, severitySegments, statusTone } from "./series.js";
import type { Backlink, CallFn, Content, Finding, Keyword, Optimization, PreviewItem, Snapshot, SprintBundle } from "./types.js";
import { BACKLINK_STATUS_LABEL, BACKLINK_TYPE_LABEL } from "./words.js";

const grid = (min: number, gap = 16) => ({ display: "grid", gap, gridTemplateColumns: fluidColumns(min), minWidth: 0 }) as const;
const cap = (text: string) => (text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text);
const words = (value: string) => cap(value.replace(/_/g, " "));

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span style={{ color: tokens.muted, fontSize: 12 }}>—</span>;
  const width = 90;
  const height = 22;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  // Lower position is better: draw position 1 at the top.
  const points = values.map((v, i) => `${(i / (values.length - 1)) * width},${((v - min) / span) * (height - 4) + 2}`).join(" ");
  const trend = positionTrendTone(values);
  return (
    <svg width={width} height={height} aria-label={`Position ${fmt(values[0])} → ${fmt(values[values.length - 1])}`} role="img">
      <polyline points={points} fill="none" stroke={trend === "neutral" ? tone("accent").solid : tone(trend).solid} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function positionTone(p: number): "ok" | "info" | "warn" | "neutral" {
  return p <= 3 ? "ok" : p <= 10 ? "info" : p <= 20 ? "warn" : "neutral";
}

/** A detail line in a sheet: label and value. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(110px, 38%) minmax(0, 1fr)", gap: 10, fontSize: 13, alignItems: "baseline" }}>
      <span style={{ color: tokens.muted }}>{label}</span>
      <span style={{ minWidth: 0, ...breakAnywhere }}>{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

const INTENTS: Record<string, string> = { problem: "Problem (researching the pain)", solution: "Solution (comparing options)", brand: "Brand (looking for this business)" };

export function KeywordsTab({ bundle, call, working }: { bundle: SprintBundle; call: CallFn; working: string | null }) {
  const narrow = useIsNarrow();
  const [adding, setAdding] = useState(false);
  const [lines, setLines] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [open, setOpen] = useState<Keyword | null>(null);
  const active = bundle.keywords.filter((k) => !k.retiredAt);
  const keywords = bundle.keywords.filter((k) => showRetired || !k.retiredAt);
  const top10 = active.filter((k) => (k.currentPosition ?? 999) <= 10).length;
  const impressions = active.reduce((n, k) => n + (k.impressions ?? 0), 0);
  const trends = active.map((k) => positionTrendTone(k.history.map((h) => h.position).filter((p): p is number => p != null)));
  const improved = trends.filter((t) => t === "ok").length;
  const declined = trends.filter((t) => t === "bad").length;
  const steady = trends.length - improved - declined;
  const selected = open ? bundle.keywords.find((k) => k.id === open.id) ?? open : null;
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <div style={grid(150, 10)}>
        <KpiCard label="Tracked" value={active.length} icon={Target} />
        <KpiCard label="On the first page" value={top10} icon={CircleCheck} tone={top10 ? "ok" : undefined} hint={improved || declined ? `${improved} up · ${declined} down` : "Top 10 in Google"} />
        <KpiCard label="Impressions (8 days)" value={formatCompact(impressions)} icon={Eye} hint="Times shown in Google" />
        <KpiCard label="Priority" value={bundle.keywords.filter((k) => k.isPriority && !k.retiredAt).length} icon={Rocket} />
      </div>
      {active.length ? (
        <div style={grid(320)}>
          <SectionCard style={top} title="Positions" subtitle="Tracked keywords by where they rank in Google" icon={ChartColumn}>
            <BarList bare title="Keywords by position" items={positionBuckets(bundle.keywords)} formatValue={(v) => String(v)} />
          </SectionCard>
          <SectionCard style={top} title="Movement" subtitle="First to latest position in the tracked history" icon={Activity}>
            <StackedBar title="Keyword movement" segments={[{ label: "Moved up", value: improved, tone: "ok" }, { label: "Steady", value: steady, tone: "neutral" }, { label: "Moved down", value: declined, tone: "bad" }]} height={12} />
          </SectionCard>
        </div>
      ) : null}
      {bundle.keywords.length ? (
        <Toolbar>
          <label style={{ fontSize: 12.5, color: tokens.muted, display: "inline-flex", gap: 8, alignItems: "center", minHeight: 40 }}>
            <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired
          </label>
          <Button type="button" onClick={() => setAdding(true)}>+ Keywords</Button>
        </Toolbar>
      ) : null}
      {keywords.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No keywords yet"
          description="Week 2 of the plan picks 20–30 keywords people really search. Positions arrive daily from Google Search Console."
          action={bundle.keywords.length ? undefined : <Button type="button" onClick={() => setAdding(true)}>+ Keywords</Button>}
        />
      ) : narrow ? (
        <CompactRows
          rows={keywords}
          rowKey={(k) => k.id}
          title={(k) => `${k.isPriority ? "★ " : ""}${k.phrase}`}
          meta={(k) => [k.retiredAt ? "Retired" : null, k.currentPosition == null ? "Not ranking yet" : `Position ${fmt(k.currentPosition)}`, k.impressions ? `${formatCompact(k.impressions)} impressions` : null, k.intent].filter(Boolean).join(" · ")}
          trailing={(k) => (k.currentPosition == null ? null : <Pill size="sm" tone={positionTone(k.currentPosition)}>{fmt(k.currentPosition)}</Pill>)}
          onOpen={setOpen}
          label="Keywords"
        />
      ) : (
        <DataTable
          columns={[
            { key: "phrase", header: "Keyword", render: (v, row) => <button type="button" onClick={() => setOpen(row as unknown as Keyword)} style={{ all: "unset", cursor: "pointer", ...breakAnywhere }}>{row.isPriority ? "★ " : ""}{String(v)}{row.retiredAt ? <span style={{ color: tokens.muted }}> (retired)</span> : null}</button> },
            {
              key: "intent",
              header: "Intent",
              render: (v, row) => (
                <Select aria-label="Intent" value={String(v ?? "")} style={{ height: 32, fontSize: 12.5 }} onChange={(e) => void call("update-keyword", { keywordId: row.id, intent: e.target.value })}>
                  <option value="">—</option>
                  <option value="problem">Problem</option>
                  <option value="solution">Solution</option>
                  <option value="brand">Brand</option>
                </Select>
              ),
            },
            { key: "currentPosition", header: "Position", render: (v) => { const p = v as number | null; return p == null ? "—" : <Pill size="sm" tone={positionTone(p)}>{fmt(p)}</Pill>; } },
            { key: "history", header: "Trend", render: (v) => <Sparkline values={((v as Keyword["history"]) ?? []).map((h) => h.position).filter((p): p is number => p != null)} /> },
            { key: "impressions", header: "Impressions", render: (v) => fmt(v as number | null, 0) },
            { key: "clicks", header: "Clicks", render: (v) => fmt(v as number | null, 0) },
            { key: "ctr", header: "Click rate", render: (v) => pct(v as number | null) },
            { key: "targetUrl", header: "Page", render: (v, row) => <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>{shortUrl(String(v ?? row.rankingUrl ?? "")) || "—"}</span> },
          ]}
          rows={keywords}
        />
      )}
      {selected ? <KeywordSheet keyword={selected} call={call} onClose={() => setOpen(null)} /> : null}
      <Modal open={adding} title="Add keywords" description="One per line. Optional: add | problem, | solution or | brand for the intent." onClose={() => setAdding(false)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="button" disabled={working === "add-keywords" || !lines.trim()} onClick={() => {
              const list = lines.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
                const [phrase, intent] = l.split("|").map((p) => p.trim());
                return intent && ["problem", "solution", "brand"].includes(intent) ? { phrase, intent } : { phrase };
              });
              void call("add-keywords", { sprintId: bundle.sprint.sprintId, keywords: list }, `${plural(list.length, "keyword")} added.`).then(() => { setLines(""); setAdding(false); });
            }}>Add</Button>
          </>
        )}
      >
        <TextArea value={lines} onChange={(e) => setLines(e.target.value)} style={{ minHeight: 160 }} placeholder={"guest house ballito | solution\nthings to do in ballito | problem"} />
      </Modal>
    </div>
  );
}

function KeywordSheet({ keyword: k, call, onClose }: { keyword: Keyword; call: CallFn; onClose: () => void }) {
  const positions = k.history.map((h) => h.position).filter((p): p is number => p != null);
  return (
    <Modal
      open
      title={k.phrase}
      description={k.retiredAt ? "Retired: no longer tracked (its history is kept)." : k.isPriority ? "A priority keyword." : "A tracked keyword."}
      onClose={onClose}
      footer={k.retiredAt ? undefined : (
        <>
          <Button type="button" variant="secondary" onClick={() => void call("retire-keyword", { keywordId: k.id }, "Keyword retired.").then(onClose)}>Retire</Button>
          <Button type="button" onClick={() => void call("update-keyword", { keywordId: k.id, priority: !k.isPriority }, k.isPriority ? "No longer a priority." : "Marked as a priority.")}>{k.isPriority ? "Unmark priority" : "Mark as priority"}</Button>
        </>
      )}
    >
      <div style={{ display: "grid", gap: 8 }}>
        <Row label="Position">{k.currentPosition == null ? "Not ranking yet" : fmt(k.currentPosition)}</Row>
        <Row label="Trend"><Sparkline values={positions} /></Row>
        <Row label="Impressions">{fmt(k.impressions, 0)}</Row>
        <Row label="Clicks">{fmt(k.clicks, 0)}{k.ctr != null ? ` (${pct(k.ctr)} click rate)` : ""}</Row>
        <Row label="Page">{shortUrl(k.targetUrl ?? k.rankingUrl) || "—"}</Row>
      </div>
      {k.retiredAt ? null : (
        <Field label="Intent">
          <Select value={k.intent ?? ""} onChange={(e) => void call("update-keyword", { keywordId: k.id, intent: e.target.value }, "Intent saved.")} style={{ width: "100%" }}>
            <option value="">Not set</option>
            {Object.entries(INTENTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

const BACKLINK_STATUSES = ["not_started", "in_progress", "submitted", "live", "rejected", "lost"];
const BACKLINK_TYPES = ["directory", "citation", "community", "guest_post", "link_trade", "organic", "other"];

export function BacklinksTab({ bundle, call }: { bundle: SprintBundle; call: CallFn }) {
  const narrow = useIsNarrow();
  const [editing, setEditing] = useState<{ link: Backlink; status: string } | null>(null);
  const [notes, setNotes] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ domain: "", type: "directory", dr: "", url: "", notes: "" });
  const counts = bundle.backlinks.reduce<Record<string, number>>((acc, b) => { acc[b.status] = (acc[b.status] ?? 0) + 1; return acc; }, {});
  const edit = (link: Backlink, status = link.status) => { setNotes(""); setUrl(link.url ?? ""); setEditing({ link, status }); };
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <div style={grid(150, 10)}>
        <KpiCard label="Live" value={counts.live ?? 0} icon={CircleCheck} tone={counts.live ? "ok" : undefined} />
        <KpiCard label="Submitted" value={counts.submitted ?? 0} icon={Activity} hint="Waiting for the site to list it" />
        <KpiCard label="Not started" value={counts.not_started ?? 0} icon={ListChecks} />
        <KpiCard label="Rejected or lost" value={(counts.rejected ?? 0) + (counts.lost ?? 0)} icon={CircleAlert} />
      </div>
      {bundle.backlinks.length ? (
        <SectionCard title="Backlinks and listings" subtitle={`${bundle.backlinks.length} in the plan. Domain rating (0–100) is how much weight a site's links carry; it is only filled from a real source.`} icon={Share2} actions={<Button type="button" style={small} onClick={() => setAdding(true)}>+ Backlink</Button>}>
          <StackedBar title="Backlinks by status" segments={backlinkSegments(bundle.backlinks)} height={12} />
        </SectionCard>
      ) : null}
      {bundle.backlinks.length === 0 ? (
        <EmptyState icon={Share2} title="No backlinks yet" description="The plan seeds the directories and business profiles that fit this kind of business; add others here." action={<Button type="button" onClick={() => setAdding(true)}>+ Backlink</Button>} />
      ) : narrow ? (
        <CompactRows
          rows={bundle.backlinks}
          rowKey={(b) => b.id}
          title={(b) => b.source}
          meta={(b) => [BACKLINK_TYPE_LABEL[b.type] ?? words(b.type), b.dr != null ? `domain rating ${b.dr}` : null, b.notes ? b.notes.split("\n").at(-1) : null].filter(Boolean).join(" · ")}
          trailing={(b) => <Pill size="sm" tone={statusTone(b.status)}>{BACKLINK_STATUS_LABEL[b.status] ?? words(b.status)}</Pill>}
          onOpen={(b) => edit(b)}
          label="Backlinks"
        />
      ) : (
        <DataTable
          columns={[
            { key: "source", header: "Source", render: (v, row) => <span style={{ display: "grid", gap: 2 }}><span>{String(v)}</span>{row.url ? <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>{shortUrl(String(row.url))}</span> : row.domain !== row.source ? <span style={{ fontSize: 12, color: tokens.muted }}>{String(row.domain)}</span> : null}</span> },
            { key: "type", header: "Type", render: (v) => BACKLINK_TYPE_LABEL[String(v)] ?? words(String(v)) },
            { key: "dr", header: "Domain rating", render: (v) => fmt(v as number | null, 0) },
            {
              key: "status",
              header: "Status",
              render: (v, row) => (
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <StatusDot tone={statusTone(String(v))} label={BACKLINK_STATUS_LABEL[String(v)] ?? String(v)} />
                  <Select aria-label="Status" value={String(v)} style={{ height: 32, fontSize: 12.5 }} onChange={(e) => edit(row as unknown as Backlink, e.target.value)}>
                    {BACKLINK_STATUSES.map((st) => <option key={st} value={st}>{BACKLINK_STATUS_LABEL[st]}</option>)}
                  </Select>
                </span>
              ),
            },
            { key: "notes", header: "Notes", render: (v) => <span style={{ fontSize: 12, color: tokens.muted, whiteSpace: "pre-wrap", ...breakAnywhere }}>{String(v ?? "")}</span> },
          ]}
          rows={bundle.backlinks}
        />
      )}
      <Modal open={!!editing} title={editing ? editing.link.source : ""} description="Submitted, rejected and lost need notes; live needs the listing URL." onClose={() => setEditing(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="button" disabled={!editing || editing.status === editing.link.status && !notes.trim() && url === (editing.link.url ?? "")} onClick={() => {
              if (!editing) return;
              void call("update-backlink", { backlinkId: editing.link.id, status: editing.status, notes: notes || undefined, url: url || undefined }, "Backlink updated.").then(() => setEditing(null));
            }}>Save</Button>
          </>
        )}
      >
        {editing ? (
          <>
            <div style={{ display: "grid", gap: 6 }}>
              <Row label="Type">{BACKLINK_TYPE_LABEL[editing.link.type] ?? words(editing.link.type)}</Row>
              <Row label="Site">{editing.link.domain}</Row>
              <Row label="Domain rating">{fmt(editing.link.dr, 0)}</Row>
              {editing.link.notes ? <Row label="Notes so far"><span style={{ whiteSpace: "pre-wrap" }}>{editing.link.notes}</span></Row> : null}
            </div>
            <Field label="Status">
              <Select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })} style={{ width: "100%" }}>
                {BACKLINK_STATUSES.map((st) => <option key={st} value={st}>{BACKLINK_STATUS_LABEL[st]}</option>)}
              </Select>
            </Field>
          </>
        ) : null}
        <Field label="Listing or linking URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
        <Field label="Notes (where, when, account used, or why)"><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </Modal>
      <Modal open={adding} title="Add a backlink" onClose={() => setAdding(false)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="button" disabled={!form.domain.trim()} onClick={() => void call("add-backlink", { sprintId: bundle.sprint.sprintId, domain: form.domain, type: form.type, dr: form.dr ? Number(form.dr) : undefined, url: form.url || undefined, notes: form.notes || undefined }, "Backlink added.").then(() => { setAdding(false); setForm({ domain: "", type: "directory", dr: "", url: "", notes: "" }); })}>Add</Button>
          </>
        )}
      >
        <Field label="Site (domain)"><Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="yellowpages.co.za" /></Field>
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={{ width: "100%" }}>
            {BACKLINK_TYPES.map((t) => <option key={t} value={t}>{BACKLINK_TYPE_LABEL[t]}</option>)}
          </Select>
        </Field>
        <Field label="Domain rating (only from a real source)"><Input value={form.dr} onChange={(e) => setForm({ ...form, dr: e.target.value })} inputMode="numeric" /></Field>
        <Field label="URL"><Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field>
        <Field label="Notes"><TextArea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const CONTENT_STATUSES = ["idea", "drafting", "review", "scheduled", "live", "archived"];
const CONTENT_TYPES = ["post", "page", "comparison", "alternative", "use-case", "pillar", "cluster", "how-to", "feature"];

const REVIEW_LABEL: Record<string, string> = { pending: "Being checked", passed: "Checked", changes_needed: "Sent back" };
const ANSWER_LABEL: Record<string, string> = { pending: "Waiting for the client", approved: "Client approved", changes_requested: "Client wants changes" };

function copyText(text: string) {
  try {
    void navigator.clipboard.writeText(text);
  } catch {
    // The link stays visible to copy by hand.
  }
}

/** The preview links for the client, with who has checked them and what the client answered. */
function PreviewsSection({ previews }: { previews: PreviewItem[] }) {
  const [showOld, setShowOld] = useState(false);
  const current = previews.filter((p) => !p.superseded);
  const rows = showOld ? previews : current;
  if (previews.length === 0) return null;
  return (
    <SectionCard title="Client previews" subtitle={`${current.length} page${current.length === 1 ? "" : "s"} · a link opens for the client only after the Reviewer has checked it`} icon={Eye}>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((p) => (
          <div key={p.id} style={{ display: "grid", gap: 4, padding: "8px 0", borderTop: `1px solid ${tokens.border}`, opacity: p.superseded ? 0.6 : 1 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13 }}>{p.title}</strong>
              <Pill tone={p.reviewStatus === "passed" ? "success" : p.reviewStatus === "changes_needed" ? "warn" : "neutral"} dot>{REVIEW_LABEL[p.reviewStatus] ?? p.reviewStatus}</Pill>
              {p.reviewStatus === "passed" ? <Pill tone={p.status === "approved" ? "success" : p.status === "changes_requested" ? "warn" : "neutral"} dot>{ANSWER_LABEL[p.status] ?? p.status}</Pill> : null}
              {p.superseded ? <Pill tone="neutral">Older version</Pill> : null}
            </div>
            <span style={{ fontSize: 12, color: tokens.muted }}>
              {shortUrl(p.pageUrl)} · {p.keptPct != null ? `${p.renderedChecked ? "as a visitor sees it, " : "page source: "}keeps ${p.keptPct}% of the live text, adds ${p.addedWords ?? 0} words · ` : ""}made {formatShortDate(p.createdAt)} · expires {formatShortDate(p.expiresAt)}
            </span>
            {p.reviewNote ? <span style={{ fontSize: 12 }}>Reviewer: {p.reviewNote}</span> : null}
            {p.decisionNote ? <span style={{ fontSize: 12 }}>Client: {p.decisionNote}</span> : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button type="button" variant="secondary" onClick={() => copyText(p.url)} disabled={p.reviewStatus !== "passed"} title={p.reviewStatus === "passed" ? "Copy the client link" : "Not checked yet: the client would only see a waiting page"}>Copy client link</Button>
              <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, alignSelf: "center", color: tokens.fg }}>Open</a>
              {p.reviewUrl ? <a href={p.reviewUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, alignSelf: "center", color: tokens.fg }}>Live vs proposal</a> : null}
            </div>
          </div>
        ))}
        {previews.length > current.length ? (
          <div><Button type="button" variant="secondary" onClick={() => setShowOld((v) => !v)}>{showOld ? "Hide older versions" : `Show ${previews.length - current.length} older version${previews.length - current.length === 1 ? "" : "s"}`}</Button></div>
        ) : null}
      </div>
    </SectionCard>
  );
}


/** What the copy may claim about how the client's business works. create-preview refuses claims that are not here. */
function ClientFactsSection({ sprintId, facts, call }: { sprintId: string; facts: NonNullable<SprintBundle["clientFacts"]>; call: CallFn }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const say = facts.facts.filter((f) => f.kind === "say");
  const avoid = facts.facts.filter((f) => f.kind === "avoid");
  const statusText = facts.status === "confirmed" ? "Confirmed by you" : facts.status === "draft" ? "Drafted from the client's own pages: please check and confirm" : "No fact sheet yet";
  const open = () => {
    setText(facts.facts.map((f) => `${f.kind === "say" ? "+" : "-"} ${f.text}${f.source ? ` | ${f.source}` : ""}`).join("\n"));
    setEditing(true);
  };
  const save = async (confirm: boolean) => {
    await call("set-client-facts", { sprintId, text, confirm }, confirm ? "Fact sheet confirmed." : "Fact sheet saved as a draft.");
    setEditing(false);
  };
  return (
    <SectionCard title="What the copy may claim" subtitle={`${statusText} · ${say.length} approved wording${say.length === 1 ? "" : "s"}, ${avoid.length} never to say`} icon={ListChecks}>
      <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
        <span style={{ color: tokens.muted, fontSize: 12 }}>Claims about how the business works (bidding, ownership, fees, delivery, guarantees, licences) are only allowed in the approved wordings below. The preview tool refuses anything else and the Reviewer checks against this list.</span>
        {say.slice(0, 6).map((f, i) => <div key={`s${i}`}>✓ {f.text}{f.source ? <span style={{ color: tokens.muted }}> ({f.source})</span> : null}</div>)}
        {say.length > 6 ? <span style={{ color: tokens.muted }}>… and {say.length - 6} more</span> : null}
        {avoid.map((f, i) => <div key={`a${i}`} style={{ color: tokens.destructive }}>✗ Never say: {f.text}</div>)}
        <div><Button type="button" variant="secondary" onClick={open}>{facts.status === "none" ? "Add facts" : "Edit"}</Button></div>
      </div>
      <Modal open={editing} title="What the copy may claim" description="One per line. + approved wording | where it comes from. - something never to say." onClose={() => setEditing(false)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="button" variant="secondary" onClick={() => void save(false)}>Save as draft</Button>
            <Button type="button" onClick={() => void save(true)}>Save and confirm</Button>
          </>
        )}
      >
        <TextArea value={text} rows={14} onChange={(e) => setText(e.target.value)} />
      </Modal>
    </SectionCard>
  );
}


export function ContentTab({ bundle, call }: { bundle: SprintBundle; call: CallFn }) {
  const narrow = useIsNarrow();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", type: "post", targetKeywordId: "", targetUrl: "" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [liveFor, setLiveFor] = useState<Content | null>(null);
  const [liveUrl, setLiveUrl] = useState("");
  const pillars = bundle.content.filter((c) => c.type === "pillar");
  const selected = openId ? bundle.content.find((c) => c.id === openId) ?? null : null;
  const setStatus = (row: Content, status: string) => {
    if (status === "live" && !row.targetUrl) {
      setLiveUrl("");
      setLiveFor(row);
      return;
    }
    void call("update-content", { contentId: row.id, status }, `Marked ${status}.`);
  };
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <PreviewsSection previews={bundle.previews ?? []} />
      {bundle.clientFacts ? <ClientFactsSection sprintId={bundle.sprint.sprintId} facts={bundle.clientFacts} call={call} /> : null}
      {bundle.content.length ? (
        <div style={grid(150, 10)}>
          <KpiCard label="Live" value={bundle.content.filter((c) => c.status === "live").length} icon={CircleCheck} />
          <KpiCard label="Being written" value={bundle.content.filter((c) => ["idea", "drafting", "scheduled"].includes(c.status)).length} icon={FileText} />
          <KpiCard label="Waiting for sign-off" value={bundle.content.filter((c) => c.status === "review").length} icon={Eye} tone={bundle.content.some((c) => c.status === "review") ? "warn" : undefined} />
          <KpiCard label="Clicks" value={formatCompact(bundle.content.reduce((n, c) => n + (c.clicks ?? 0), 0))} icon={ChartLine} hint="Live pages, Google Search Console" />
        </div>
      ) : null}
      {bundle.content.length === 0 ? (
        <EmptyState icon={FileText} title="No content yet" description="Core pages, posts, the guide and its supporting posts land here as the plan writes them." action={<Button type="button" onClick={() => setAdding(true)}>+ Content</Button>} />
      ) : (
        <>
          <Toolbar><Button type="button" onClick={() => setAdding(true)}>+ Content</Button></Toolbar>
          {narrow ? (
            <CompactRows
              rows={bundle.content}
              rowKey={(c) => c.id}
              title={(c) => c.title}
              meta={(c) => [cap(c.type), cap(c.status), c.impressions ? `${formatCompact(c.impressions)} impressions` : null, c.publishedOn ? `live ${formatShortDate(c.publishedOn)}` : null].filter(Boolean).join(" · ")}
              trailing={(c) => <StatusDot tone={statusTone(c.status)} label={c.status} />}
              onOpen={(c) => setOpenId(c.id)}
              label="Content"
            />
          ) : (
            <DataTable
              columns={[
                { key: "title", header: "Title", render: (v, row) => <button type="button" onClick={() => setOpenId(String(row.id))} style={{ all: "unset", cursor: "pointer", display: "grid", gap: 2 }}><span style={breakAnywhere}>{String(v)}</span>{row.targetUrl ? <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>{shortUrl(String(row.targetUrl))}</span> : null}</button> },
                { key: "type", header: "Type", render: (v) => cap(String(v)) },
                {
                  key: "status",
                  header: "Status",
                  render: (v, row) => (
                    <Select aria-label="Status" value={String(v)} style={{ height: 32, fontSize: 12.5 }} onChange={(e) => setStatus(row as unknown as Content, e.target.value)}>
                      {CONTENT_STATUSES.map((st) => <option key={st} value={st}>{cap(st)}</option>)}
                    </Select>
                  ),
                },
                { key: "impressions", header: "Impressions", render: (v) => fmt(v as number | null, 0) },
                { key: "clicks", header: "Clicks", render: (v) => fmt(v as number | null, 0) },
                { key: "position", header: "Position", render: (v) => fmt(v as number | null) },
                { key: "publishedOn", header: "Live since", render: (v) => (v ? formatShortDate(String(v)) : "—") },
              ]}
              rows={bundle.content}
            />
          )}
        </>
      )}
      {selected ? (
        <Modal open title={selected.title} description={`${cap(selected.type)}${selected.publishedOn ? ` · live since ${formatDate(selected.publishedOn)}` : ""}`} onClose={() => setOpenId(null)}>
          <div style={{ display: "grid", gap: 6 }}>
            <Row label="Page">{selected.targetUrl ? <a href={selected.targetUrl} target="_blank" rel="noreferrer" style={{ color: tokens.fg }}>{shortUrl(selected.targetUrl)}</a> : "Not live yet"}</Row>
            <Row label="Impressions">{fmt(selected.impressions, 0)}</Row>
            <Row label="Clicks">{fmt(selected.clicks, 0)}</Row>
            <Row label="Social posts">{selected.socialPostIds.length || "None linked yet"}</Row>
          </div>
          <Field label="Status">
            <Select value={selected.status} onChange={(e) => setStatus(selected, e.target.value)} style={{ width: "100%" }}>
              {CONTENT_STATUSES.map((st) => <option key={st} value={st}>{cap(st)}</option>)}
            </Select>
          </Field>
          {selected.type !== "pillar" && pillars.length ? (
            <Field label="Links to the guide (pillar)">
              <Select value={selected.linksToPillarIds[0] ?? ""} onChange={(e) => void call("update-content", { contentId: selected.id, linksToPillarIds: e.target.value ? [e.target.value] : [] }, "Saved.")} style={{ width: "100%" }}>
                <option value="">No</option>
                {pillars.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </Select>
            </Field>
          ) : null}
        </Modal>
      ) : null}
      <Modal open={adding} title="Add content" onClose={() => setAdding(false)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="button" disabled={!form.title.trim()} onClick={() => void call("add-content", { sprintId: bundle.sprint.sprintId, title: form.title, type: form.type, targetKeywordId: form.targetKeywordId || undefined, targetUrl: form.targetUrl || undefined }, "Content added.").then(() => { setAdding(false); setForm({ title: "", type: "post", targetKeywordId: "", targetUrl: "" }); })}>Add</Button>
          </>
        )}
      >
        <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={{ width: "100%" }}>
            {CONTENT_TYPES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
          </Select>
        </Field>
        <Field label="Target keyword">
          <Select value={form.targetKeywordId} onChange={(e) => setForm({ ...form, targetKeywordId: e.target.value })} style={{ width: "100%" }}>
            <option value="">None</option>
            {bundle.keywords.filter((k) => !k.retiredAt).map((k) => <option key={k.id} value={k.id}>{k.phrase}</option>)}
          </Select>
        </Field>
        <Field label="URL (when it exists)"><Input value={form.targetUrl} onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} /></Field>
      </Modal>
      <Modal open={!!liveFor} title="Mark live" description="Live content needs its URL: Google Search Console numbers attach to it, and Social is told once it answers." onClose={() => setLiveFor(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setLiveFor(null)}>Cancel</Button>
            <Button type="button" disabled={!liveUrl.trim()} onClick={() => { if (!liveFor) return; void call("update-content", { contentId: liveFor.id, status: "live", targetUrl: liveUrl }, "Marked live.").then(() => setLiveFor(null)); }}>Save</Button>
          </>
        )}
      >
        <Field label="Live URL"><Input value={liveUrl} onChange={(e) => setLiveUrl(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Note" };

function snapshotLine(s: Snapshot): string {
  const r = s.rankings as { top10?: number; tracked?: number };
  const a = s.authority as { liveBacklinks?: number };
  const t = s.traffic as { impressions?: number; clicks?: number };
  return [
    s.capturedOn ? formatShortDate(s.capturedOn) : null,
    t.impressions != null ? `${formatCompact(t.impressions)} impressions` : null,
    `${r.top10 ?? 0} of ${r.tracked ?? 0} on page one`,
    `${plural(a.liveBacklinks ?? 0, "live link")}`,
  ].filter(Boolean).join(" · ");
}

export function AuditsTab({ bundle, call, working }: { bundle: SprintBundle; call: CallFn; working: string | null }) {
  const narrow = useIsNarrow();
  const [finding, setFinding] = useState<Finding | null>(null);
  const bySeverity = bundle.findings.reduce<Record<string, number>>((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {});
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <SectionCard title="Open findings" subtitle={bundle.findings.length ? `${plural(bundle.findings.length, "problem")} from the site checks; each clears when a re-run no longer finds it` : "Site checks record problems here"} icon={HeartPulse} tone={(bySeverity.critical ?? 0) + (bySeverity.high ?? 0) ? "bad" : bundle.findings.length ? "warn" : "ok"}>
        {bundle.findings.length ? <StackedBar title="Open findings by severity" segments={severitySegments(bundle.findings)} height={10} /> : null}
        {bundle.findings.length === 0 ? (
          <EmptyState compact tone="ok" icon={CircleCheck} title="No open findings" description="The site checks record problems here and clear them when a re-run no longer finds them." />
        ) : narrow ? (
          <CompactRows
            rows={bundle.findings}
            rowKey={(f) => f.id}
            title={(f) => f.finding}
            meta={(f) => [SEVERITY_LABEL[f.severity] ?? cap(f.severity), f.category, f.url ? shortUrl(f.url) : null].filter(Boolean).join(" · ")}
            trailing={(f) => <StatusDot tone={statusTone(f.severity)} label={f.severity} />}
            onOpen={setFinding}
            label="Open findings"
          />
        ) : (
          <DataTable
            columns={[
              { key: "severity", header: "Severity", render: (v) => <Pill size="sm" tone={statusTone(String(v))}>{SEVERITY_LABEL[String(v)] ?? cap(String(v))}</Pill> },
              { key: "category", header: "Area", render: (v) => cap(String(v ?? "")) },
              { key: "finding", header: "Finding", render: (v) => <span style={breakAnywhere}>{String(v)}</span> },
              { key: "url", header: "Page", render: (v) => <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>{shortUrl(String(v ?? "")) || "—"}</span> },
              { key: "id", header: "", width: "110px", render: (v) => <Button type="button" variant="secondary" style={small} onClick={() => void call("resolve-finding", { findingId: v }, "Finding resolved.")}>Resolve</Button> },
            ]}
            rows={bundle.findings}
          />
        )}
      </SectionCard>
      <SectionCard title="Snapshots" subtitle="Day 0, 30, 60 and 90, then monthly" icon={Gauge} actions={<Button type="button" variant="secondary" style={small} disabled={working === "run-audit-snapshot"} onClick={() => void call("run-audit-snapshot", { sprintId: bundle.sprint.sprintId }, "Snapshot recorded.")}>{working === "run-audit-snapshot" ? "Taking…" : "Take one now"}</Button>}>
        {bundle.snapshots.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>The daily run takes snapshots on days 0, 30, 60 and 90, then monthly.</p>
        ) : narrow ? (
          <CompactRows rows={bundle.snapshots} rowKey={(s) => s.id} title={(s) => `Day ${s.day}${s.kind === "manual" ? " (taken by hand)" : ""}`} meta={snapshotLine} label="Snapshots" />
        ) : (
          <DataTable
            columns={[
              { key: "day", header: "Day", render: (v, row) => `${String(v)}${row.kind === "manual" ? " (by hand)" : ""}` },
              { key: "capturedOn", header: "Taken", render: (v) => (v ? formatDate(String(v)) : "—") },
              { key: "traffic", header: "Impressions", render: (v) => fmt((v as { impressions?: number }).impressions ?? null, 0) },
              { key: "id", header: "Clicks", render: (_v, row) => fmt(((row.traffic as { clicks?: number }) ?? {}).clicks ?? null, 0) },
              { key: "rankings", header: "On page one", render: (v) => { const r = v as { top10?: number; tracked?: number }; return `${r.top10 ?? 0} of ${r.tracked ?? 0}`; } },
              { key: "authority", header: "Live links (sites)", render: (v) => { const a = v as { liveBacklinks?: number; referringDomains?: number }; return `${a.liveBacklinks ?? 0} (${a.referringDomains ?? 0})`; } },
              { key: "content", header: "Live content", render: (v) => fmt((v as { live?: number }).live ?? 0, 0) },
            ]}
            rows={bundle.snapshots}
          />
        )}
      </SectionCard>
      {finding ? (
        <Modal open title={finding.finding} description={[SEVERITY_LABEL[finding.severity] ?? cap(finding.severity), finding.category].filter(Boolean).join(" · ")} onClose={() => setFinding(null)}
          footer={<Button type="button" onClick={() => void call("resolve-finding", { findingId: finding.id }, "Finding resolved.").then(() => setFinding(null))}>Mark resolved</Button>}
        >
          <div style={{ display: "grid", gap: 6 }}>
            <Row label="Page">{finding.url ? shortUrl(finding.url) : "The whole site"}</Row>
            {finding.source ? <Row label="Found by">{finding.source.replace(/-/g, " ")}</Row> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Optimizations
// ---------------------------------------------------------------------------

const RESULT_LABEL: Record<string, string> = { win: "Win", loss: "Loss", no_change: "No change", inconclusive: "Inconclusive" };

export function OptimizationsTab({ bundle, call }: { bundle: SprintBundle; call: CallFn }) {
  const narrow = useIsNarrow();
  const [rejecting, setRejecting] = useState<Optimization | null>(null);
  const [reason, setReason] = useState("");
  const proposed = bundle.optimizations.filter((o) => o.status === "proposed");
  const others = bundle.optimizations.filter((o) => o.status !== "proposed");
  const board = Object.entries(bundle.scoreboard ?? {});
  const results = optimizationSegments(bundle.scoreboard, bundle.optimizations);
  const full = bundle.sprint.autopilotMode === "full";
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <SectionCard title={proposed.length ? `Changes to approve: ${proposed.length}` : "Changes to approve"} subtitle={full ? "Full autopilot: the SEO agent decides these itself" : "The weekly review suggests at most 2 a week at first; each is measured 14 days after you approve it"} icon={Lightbulb} tone={proposed.length && !full ? "warn" : undefined}>
        {proposed.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Nothing to approve. The weekly review (Mondays) suggests changes when it finds a problem.</p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {proposed.map((o) => (
              <div key={o.id} style={{ border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${tone(statusTone(o.severity)).solid}`, borderRadius: 12, padding: 12, display: "grid", gap: 6, minWidth: 0 }}>
                <strong style={{ fontSize: 14, ...breakAnywhere }}>{o.hypothesis}</strong>
                <span style={{ fontSize: 13, ...breakAnywhere }}>{o.proposedAction}</span>
                <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>Found: {words(o.signalType)} ({o.severity}) · Tasks: {o.proposedTasks.map((t) => t.title).join("; ")}</span>
                <RawDetails raw={JSON.stringify(o.evidence, null, 2)} label="The numbers behind it" />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button type="button" style={small} onClick={() => void call("approve-optimization", { optimizationId: o.id }, "Approved: the tasks are added for this week and measured in 14 days.")}>Approve</Button>
                  <Button type="button" variant="secondary" style={small} onClick={() => { setReason(""); setRejecting(o); }}>Reject</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      {results.some((r) => r.value > 0) ? (
        <div style={grid(320)}>
          <SectionCard style={top} title="Results" subtitle="Approved changes, measured after 14 days" icon={ChartPie}>
            <DonutChart title="Optimization results" segments={results} centerValue={results.reduce((n, r) => n + r.value, 0)} centerLabel="measured" />
          </SectionCard>
          <SectionCard style={top} title="Win rate by kind of change" subtitle="Wins out of measured changes" icon={ChartColumn}>
            <BarList bare title="Win rate by kind of change" items={board.map(([type, e]) => { const n = e.wins + e.losses + e.noChange + (e.inconclusive ?? 0); return { label: words(type), value: n ? Math.round((e.wins / n) * 100) : 0, tone: e.wins > e.losses ? "ok" as const : e.losses > e.wins ? "bad" as const : "neutral" as const }; })} formatValue={(v) => `${v}%`} />
          </SectionCard>
        </div>
      ) : null}
      <SectionCard title="History" icon={Activity}>
        {others.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Nothing approved or rejected yet.</p>
        ) : narrow ? (
          <CompactRows
            rows={others}
            rowKey={(o) => o.id}
            title={(o) => o.hypothesis}
            meta={(o) => [cap(o.status), o.result ? RESULT_LABEL[o.result] ?? o.result : o.measureOn ? `measured ${formatShortDate(o.measureOn)}` : null, o.rejectedReason].filter(Boolean).join(" · ")}
            label="Optimization history"
          />
        ) : (
          <DataTable
            columns={[
              { key: "hypothesis", header: "Change", render: (v) => <span style={breakAnywhere}>{String(v)}</span> },
              { key: "status", header: "Status", render: (v) => <Pill size="sm" tone={statusTone(String(v))}>{cap(String(v))}</Pill> },
              { key: "measureOn", header: "Measured on", render: (v) => (v ? formatShortDate(String(v)) : "—") },
              { key: "result", header: "Result", render: (v, row) => (v ? <span title={((row.outcome as { reasons?: string[] } | null)?.reasons ?? []).join(" ")}><Pill size="sm" tone={statusTone(String(v))}>{RESULT_LABEL[String(v)] ?? String(v)}</Pill></span> : row.rejectedReason ? String(row.rejectedReason) : "—") },
            ]}
            rows={others}
          />
        )}
      </SectionCard>
      {board.length ? (
        <SectionCard title="Scoreboard" subtitle="Per kind of change: wins, losses, no change, inconclusive" icon={ListChecks}>
          <CompactRows
            rows={board.map(([type, e]) => ({ id: type, type, ...e }))}
            title={(r) => words(r.type)}
            meta={(r) => `${plural(r.wins, "win")} · ${plural(r.losses, "loss", "losses")} · ${r.noChange} no change · ${r.inconclusive ?? 0} inconclusive`}
            label="Scoreboard"
          />
        </SectionCard>
      ) : null}
      <Modal open={!!rejecting} title="Reject this change" onClose={() => setRejecting(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button type="button" disabled={!reason.trim()} onClick={() => { if (!rejecting) return; void call("reject-optimization", { optimizationId: rejecting.id, reason }, "Rejected.").then(() => setRejecting(null)); }}>Reject</Button>
          </>
        )}
      >
        <Field label="Why"><TextArea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}
