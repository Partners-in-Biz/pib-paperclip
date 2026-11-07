/**
 * The sales desk (CRM 0.37.0): the Today tab a person works through, the
 * "Log outcome" dialog, Call / Email quick actions, Give to agent on a CRM
 * record, and the sales snapshot (activity, funnel, lead batches) the
 * Overview shows. The rules (buckets, outcome suggestions, links) are in
 * `../desk.ts`; this file only draws them.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useHostNavigation, useHostNewIssue, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  BarList,
  Bot,
  Button,
  Calendar,
  CircleCheck,
  Clock,
  ColumnChart,
  EmptyState,
  Field,
  GiveToAgentButton,
  Input,
  KpiCard,
  ListChecks,
  Mail,
  Modal,
  Pill,
  SectionCard,
  Select,
  Sun,
  TextArea,
  errorText,
  fluidColumns,
  formatMoney,
  formatShortDate,
  tokens,
  tone,
  useIsNarrow,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import {
  BUCKET_LABEL,
  OUTCOMES_BY_CHANNEL,
  OUTCOME_CHANNELS,
  OUTCOME_LABEL,
  composeHref,
  dueDateInDays,
  outcomeSuggestion,
  recordPath,
  telHref,
  type ActivitySeries,
  type BatchRow,
  type DeskBucket,
  type Funnel,
  type Outcome,
  type OutcomeChannel,
  type QueueCounts,
  type QueueItem,
} from "../desk.js";
export type { QueueItem } from "../desk.js";
import { BandPill, Muted } from "./overview.js";
import { MoreMenu, whenText } from "./parts.js";

export interface DeskView {
  timezone: string;
  items: QueueItem[];
  counts: QueueCounts;
  activity: ActivitySeries;
  funnel: Funnel;
  batches: BatchRow[];
}

const NEXT_LABEL: Record<string, string> = { call: "Call", email: "Email", meet: "Meet" };
const BUCKET_TONE: Record<DeskBucket, ToneInput> = { overdue: "bad", today: "warn", soon: "info", later: "neutral", undated: "neutral" };
const smallButton: CSSProperties = { height: 30, fontSize: 12, padding: "0 10px" };

// ---------------------------------------------------------------------------
// Glyphs the UI kit has no icon for
// ---------------------------------------------------------------------------

export function PhoneGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ display: "block", flexShrink: 0 }}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Call and Email: the two quick actions, as links the browser handles
// ---------------------------------------------------------------------------

/** A `tel:` link (the Mac, phone or softphone dials) and the Mailbox compose link, as small buttons. */
export function ReachButtons({ phone, email, emailOk = true, name, size = "sm" }: { phone: string | null | undefined; email: string | null | undefined; emailOk?: boolean; name: string; size?: "sm" | "md" }) {
  const nav = useHostNavigation();
  const tel = telHref(phone);
  const mail = composeHref(email);
  const style: CSSProperties = size === "sm" ? { ...smallButton, display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", borderRadius: 9, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.secondaryFg, fontWeight: 600 } : { display: "inline-flex", alignItems: "center", gap: 6, height: 36, padding: "0 14px", textDecoration: "none", borderRadius: 9, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.secondaryFg, fontWeight: 600, fontSize: 13 };
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      {tel ? (
        <a href={tel} title={`Call ${name} on ${phone}`} aria-label={`Call ${name}`} style={style}><PhoneGlyph /> Call</a>
      ) : null}
      {mail && emailOk ? (
        <a {...nav.linkProps(mail)} title={`Email ${name} at ${email}`} aria-label={`Email ${name}`} style={style}><Mail size={14} aria-hidden="true" /> Email</a>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Give to agent on a CRM record
// ---------------------------------------------------------------------------

/** The host's New Task popup, prefilled from the record by the worker (`crm.give-prepare`), then linked (`crm.give-record`). */
export function CrmGiveButton({ recordType, recordId, onDone, onError, label = "Give to agent", variant = "secondary", small = false }: {
  recordType: "company" | "contact" | "deal";
  recordId: string;
  onDone?: (out: { message: string; warning: string | null }) => void;
  onError?: (message: string) => void;
  label?: string;
  variant?: "primary" | "secondary";
  small?: boolean;
}) {
  const host = useHostNewIssue();
  const prepare = usePluginAction("crm.give-prepare");
  const record = usePluginAction("crm.give-record");
  const newIssue = useMemo(() => ({ open: (defaults?: Parameters<typeof host.open>[0]) => host.open(defaults) }), [host]);
  const button = (
    <GiveToAgentButton
      newIssue={newIssue}
      label={label}
      variant={variant}
      prepare={async () => {
        const out = (await prepare({ recordType, recordId })) as { title: string; description: string; projectId?: string };
        return { title: out.title, description: out.description, ...(out.projectId ? { projectId: out.projectId } : {}) };
      }}
      record={async (issue) => (await record({ recordType, recordId, issueId: issue.id })) as { message: string; warning: string | null }}
      onDone={(out) => onDone?.({ message: out.message, warning: out.warning })}
      onError={(message) => onError?.(message)}
    />
  );
  return small ? <span style={{ display: "inline-flex" }} className="pib-small-give">{button}</span> : button;
}

// ---------------------------------------------------------------------------
// Log outcome
// ---------------------------------------------------------------------------

export interface OutcomeTarget {
  recordType: "contact" | "deal";
  recordId: string;
  name: string;
  /** The next action already on the record, so the dialog can say what it replaces. */
  kind?: string | null;
  lifecycle?: string | null;
}

export interface OutcomeSubmission {
  recordType: "contact" | "deal";
  recordId: string;
  channel: OutcomeChannel;
  outcome: Outcome;
  note: string;
  nextActionKind: string | null;
  nextActionDueAt: string | null;
  lifecycle?: string;
}

/** What happened, what was said, and the next step (prefilled from the outcome). One save. */
export function LogOutcomeModal({ target, timezone, busy, onClose, onSave }: {
  target: OutcomeTarget | null;
  timezone: string | null | undefined;
  busy: boolean;
  onClose: () => void;
  onSave: (out: OutcomeSubmission) => void;
}) {
  const [channel, setChannel] = useState<OutcomeChannel>("call");
  const [outcome, setOutcome] = useState<Outcome>("reached");
  const [note, setNote] = useState("");
  const [nextKind, setNextKind] = useState<string>("email");
  const [nextDue, setNextDue] = useState("");
  const [moveLifecycle, setMoveLifecycle] = useState(false);

  // Each time the dialog opens for a record, start from a call that reached them.
  useEffect(() => {
    if (!target) return;
    const start: OutcomeChannel = target.kind === "email" ? "email" : target.kind === "meet" ? "meeting" : "call";
    setChannel(start);
    applyOutcome(OUTCOMES_BY_CHANNEL[start][0]!);
    setNote("");
    setMoveLifecycle(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.recordType, target?.recordId]);

  function applyOutcome(next: Outcome) {
    setOutcome(next);
    const suggestion = outcomeSuggestion(next);
    setNextKind(suggestion.kind ?? "");
    setNextDue(suggestion.kind && suggestion.inDays != null ? dueDateInDays(Date.now(), suggestion.inDays, timezone) : "");
  }

  const suggestion = outcomeSuggestion(outcome);
  const lifecycleOffer = target?.recordType === "contact" && suggestion.lifecycle && suggestion.lifecycle !== target.lifecycle ? suggestion.lifecycle : null;
  const outcomes = OUTCOMES_BY_CHANNEL[channel];

  return (
    <Modal
      open={Boolean(target)}
      title={target ? `Log outcome: ${target.name}` : "Log outcome"}
      description="What happened and what comes next. The next step replaces the one on the record."
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            disabled={busy || !target || (Boolean(nextKind) && !nextDue)}
            onClick={() => target && onSave({
              recordType: target.recordType,
              recordId: target.recordId,
              channel,
              outcome,
              note,
              nextActionKind: nextKind || null,
              nextActionDueAt: nextKind ? nextDue : null,
              ...(moveLifecycle && lifecycleOffer ? { lifecycle: lifecycleOffer } : {}),
            })}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      )}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
        <Field label="How">
          <Select value={channel} onChange={(event) => { const next = event.target.value as OutcomeChannel; setChannel(next); applyOutcome(OUTCOMES_BY_CHANNEL[next][0]!); }}>
            {OUTCOME_CHANNELS.map((option) => <option key={option} value={option}>{option === "call" ? "Call" : option === "email" ? "Email" : option === "meeting" ? "Meeting" : "Message"}</option>)}
          </Select>
        </Field>
        <Field label="What happened">
          <Select value={outcome} onChange={(event) => applyOutcome(event.target.value as Outcome)}>
            {outcomes.map((option) => <option key={option} value={option}>{OUTCOME_LABEL[option]}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Notes (what was said or agreed)">
        <TextArea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Facts only, in plain words." rows={4} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
        <Field label="Next step">
          <Select value={nextKind} onChange={(event) => { setNextKind(event.target.value); if (!event.target.value) setNextDue(""); else if (!nextDue) setNextDue(dueDateInDays(Date.now(), 1, timezone)); }}>
            <option value="">Nothing planned</option>
            <option value="call">Call</option>
            <option value="email">Email</option>
            <option value="meet">Meet</option>
          </Select>
        </Field>
        <Field label="When">
          <Input type="date" value={nextDue} disabled={!nextKind} onChange={(event) => setNextDue(event.target.value)} />
        </Field>
      </div>
      {lifecycleOffer ? (
        <label style={{ display: "inline-flex", alignItems: "flex-start", gap: 8, fontSize: 13, lineHeight: 1.45 }}>
          <input type="checkbox" checked={moveLifecycle} onChange={(event) => setMoveLifecycle(event.target.checked)} style={{ marginTop: 3 }} />
          <span>Also mark {target?.name} as <strong>{lifecycleOffer}</strong>{lifecycleOffer === "churned" ? " (stops their sequences)" : ""}</span>
        </label>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

function BriefBox({ brief }: { brief: { body: string; at: string } }) {
  const [open, setOpen] = useState(false);
  const short = brief.body.length > 320 && !open;
  return (
    <div style={{ display: "grid", gap: 4, padding: "8px 10px", borderRadius: 10, background: tone("info").soft, border: `1px solid ${tone("info").border}`, minWidth: 0 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: tokens.muted, display: "flex", alignItems: "center", gap: 6 }}><Bot size={13} aria-hidden="true" /> Agent brief · {whenText(brief.at)}</span>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{short ? `${brief.body.slice(0, 319)}…` : brief.body}</p>
      {brief.body.length > 320 ? (
        <button type="button" onClick={() => setOpen(!open)} style={{ appearance: "none", border: "none", background: "transparent", padding: 0, fontSize: 12, fontWeight: 600, color: tokens.primary, cursor: "pointer", fontFamily: "inherit", justifySelf: "start" }}>
          {open ? "Show less" : "Read the whole brief"}
        </button>
      ) : null}
    </div>
  );
}

function dueText(item: QueueItem): string {
  if (!item.dueAt) return "no date";
  const t = Date.parse(item.dueAt);
  if (Number.isNaN(t)) return "no date";
  if (item.bucket === "today") return "today";
  const days = Math.round((Date.now() - t) / 86_400_000);
  if (item.bucket === "overdue") return days <= 1 ? "yesterday" : `${days} days ago`;
  return formatShortDate(t);
}

export function QueueRow({ item, busy, onOutcome, onSnooze, onDone, onGiven, onError }: {
  item: QueueItem;
  busy: boolean;
  onOutcome: (item: QueueItem) => void;
  onSnooze: (item: QueueItem, inDays: number) => void;
  onDone: (item: QueueItem) => void;
  onGiven: (out: { message: string; warning: string | null }) => void;
  onError: (message: string) => void;
}) {
  const nav = useHostNavigation();
  const narrow = useIsNarrow();
  const path = recordPath(item);
  const kindLabel = NEXT_LABEL[item.kind] ?? item.kind;
  const t = BUCKET_TONE[item.bucket];
  return (
    <div style={{ display: "grid", gap: 10, padding: narrow ? 12 : "12px 14px", borderRadius: 12, border: `1px solid ${item.bucket === "overdue" ? tone("bad").border : tokens.border}`, background: tokens.bg, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap", minWidth: 0 }}>
        <div style={{ display: "grid", gap: 3, flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {path ? <a {...nav.linkProps(path)} style={{ fontWeight: 700, fontSize: 14, color: tokens.fg, textDecoration: "none", overflowWrap: "anywhere" }}>{item.name}</a> : <strong style={{ fontSize: 14 }}>{item.name}</strong>}
            {item.band ? <BandPill band={item.band} /> : null}
            {item.deal ? <Pill size="sm" tone="accent">{item.deal.title}{item.deal.amountMinor > 0 ? ` · ${formatMoney(item.deal.amountMinor, item.deal.currency)}` : ""}</Pill> : null}
          </div>
          <span style={{ fontSize: 12.5, color: tokens.muted, overflowWrap: "anywhere" }}>
            {[item.company, item.phone, item.email].filter(Boolean).join(" · ") || "No phone or email on the record"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Pill tone={t} size="sm" icon={Clock} dot>{kindLabel} · {dueText(item)}</Pill>
        </div>
      </div>
      {item.brief ? <BriefBox brief={item.brief} /> : null}
      {item.lastTouch ? (
        <span style={{ fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" }}>
          Last: {item.lastTouch.kind.replace(/_/g, " ")} {whenText(item.lastTouch.at)} · {item.lastTouch.body.length > 140 ? `${item.lastTouch.body.slice(0, 139)}…` : item.lastTouch.body}
        </span>
      ) : null}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <ReachButtons phone={item.phone} email={item.email} emailOk={item.emailOk} name={item.name} />
        <Button type="button" style={smallButton} disabled={busy} onClick={() => onOutcome(item)}>Log outcome</Button>
        <MoreMenu
          label={`More for ${item.name}`}
          items={[
            { key: "tomorrow", label: "Snooze to tomorrow", onSelect: () => onSnooze(item, 1) },
            { key: "3days", label: "Snooze 3 days", onSelect: () => onSnooze(item, 3) },
            { key: "week", label: "Snooze a week", onSelect: () => onSnooze(item, 7) },
            { key: "done", label: "Done, nothing planned", onSelect: () => onDone(item) },
          ]}
        />
        <CrmGiveButton recordType={item.recordType} recordId={item.recordId} onDone={onGiven} onError={onError} small />
      </div>
    </div>
  );
}

export function SalesDesk({ view, busy, onOutcome, onSnooze, onDone, onGiven, onError }: {
  view: DeskView | null;
  busy: boolean;
  onOutcome: (item: QueueItem) => void;
  onSnooze: (item: QueueItem, inDays: number) => void;
  onDone: (item: QueueItem) => void;
  onGiven: (out: { message: string; warning: string | null }) => void;
  onError: (message: string) => void;
}) {
  const [showLater, setShowLater] = useState(false);
  if (!view) return <Muted>Loading today's list…</Muted>;
  const groups: Array<{ bucket: DeskBucket; items: QueueItem[] }> = (["overdue", "today", "soon", "undated", "later"] as DeskBucket[])
    .map((bucket) => ({ bucket, items: view.items.filter((item) => item.bucket === bucket) }))
    .filter((group) => group.items.length > 0 && (showLater || group.bucket !== "later"));
  const week = view.activity.thisWeek;
  const last = view.activity.lastWeek;
  const touches = week.call + week.email + week.meeting + week.message;
  const touchesLast = last.call + last.email + last.meeting + last.message;
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
        <KpiCard size="sm" label="Due now" value={view.counts.now} tone={view.counts.now > 0 ? "warn" : "ok"} hint={view.counts.overdue > 0 ? `${view.counts.overdue} overdue` : "Nothing overdue"} icon={Sun} />
        <KpiCard size="sm" label="Calls this week" value={week.call} delta={week.call - last.call} hint={`${last.call} last week`} icon={ListChecks} />
        <KpiCard size="sm" label="Touches this week" value={touches} delta={touches - touchesLast} hint="Calls, emails, meetings, messages" icon={Mail} />
        <KpiCard size="sm" label="Coming up" value={view.counts.soon} hint={`${view.counts.undated} with no date`} icon={Calendar} />
      </div>
      {view.items.length === 0 ? (
        <EmptyState
          title="Nothing on the desk"
          icon={CircleCheck}
          tone="ok"
          description="Set a next action on a contact or deal, or ask the Sales Lead for a call list: it lands here with the brief next to the Call button."
        />
      ) : null}
      {groups.map((group) => (
        <section key={group.bucket} style={{ display: "grid", gap: 8, minWidth: 0 }} aria-label={BUCKET_LABEL[group.bucket]}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: group.bucket === "overdue" ? tone("bad").fg : tokens.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>{BUCKET_LABEL[group.bucket]}</span>
            <span style={{ fontSize: 12, color: tokens.muted }}>{group.items.length}</span>
          </div>
          {group.items.map((item) => (
            <QueueRow key={item.key} item={item} busy={busy} onOutcome={onOutcome} onSnooze={onSnooze} onDone={onDone} onGiven={onGiven} onError={onError} />
          ))}
        </section>
      ))}
      {!showLater && view.counts.later > 0 ? (
        <div>
          <Button type="button" variant="secondary" style={smallButton} onClick={() => setShowLater(true)}>Show {view.counts.later} planned for later</Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sales snapshot on the Overview
// ---------------------------------------------------------------------------

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

export function SalesSnapshot({ view, onToday }: { view: DeskView | null; onToday: () => void }) {
  if (!view) return null;
  const days = view.activity.days;
  const data = days.map((day) => ({ label: day.date.slice(5).replace("-", "/"), title: formatShortDate(day.date), values: { call: day.call, email: day.email, meeting: day.meeting + day.message, note: day.note } }));
  const f = view.funnel;
  const funnelItems = [
    { label: "Leads and prospects", value: f.leads, tone: "info" as ToneInput },
    { label: `Contacted (${pct(f.contacted, f.leads)})`, value: f.contacted, tone: "accent" as ToneInput },
    { label: `Qualified (${pct(f.prospects, f.leads)})`, value: f.prospects, tone: "warn" as ToneInput },
    { label: `With a deal (${pct(f.withDeal, f.leads)})`, value: f.withDeal, tone: "warn" as ToneInput },
    { label: `Won or customer (${pct(f.won, f.leads)})`, value: f.won, tone: "ok" as ToneInput },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 16, alignItems: "start" }}>
      <SectionCard title="Sales activity" subtitle="Calls, emails, meetings and notes logged per day, last 4 weeks." icon={ListChecks} actions={<Button type="button" variant="secondary" style={smallButton} onClick={onToday}>Open today's list</Button>}>
        <ColumnChart
          title="Activity per day"
          data={data}
          series={[
            { key: "call", label: "Calls", tone: "ok" },
            { key: "email", label: "Emails", tone: "info" },
            { key: "meeting", label: "Meetings and messages", tone: "accent" },
            { key: "note", label: "Notes", tone: "neutral" },
          ]}
          height={120}
          emptyText="Nothing logged in the last 4 weeks. Log outcomes from today's list and this fills up."
        />
        <div style={{ display: "grid", gridTemplateColumns: fluidColumns(120), gap: 8 }}>
          <KpiCard size="sm" label="Overdue follow-ups" value={view.counts.overdue} tone={view.counts.overdue > 0 ? "bad" : "ok"} invert hint="Next actions past their date" icon={Clock} />
          <KpiCard size="sm" label="Due today" value={view.counts.today} tone={view.counts.today > 0 ? "warn" : "neutral"} icon={Sun} />
          <KpiCard size="sm" label="Calls this week" value={view.activity.thisWeek.call} delta={view.activity.thisWeek.call - view.activity.lastWeek.call} icon={ListChecks} />
        </div>
      </SectionCard>
      <SectionCard title="Lead funnel" subtitle="Everyone who is not churned, and how far each step got." icon={Clock}>
        <BarList title="How far each lead got" items={funnelItems} bare />
        {view.batches.length > 0 ? (
          <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: tokens.muted }}>Lead batches from the agents</span>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
                <thead>
                  <tr style={{ color: tokens.muted, textAlign: "left" }}>
                    <th style={th}>Batch</th><th style={thNum}>Leads</th><th style={thNum}>Called</th><th style={thNum}>Replied</th><th style={thNum}>Deals</th><th style={thNum}>Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {view.batches.slice(0, 8).map((row) => (
                    <tr key={row.tag} style={{ borderTop: `1px solid ${tokens.border}` }}>
                      <td style={td}>{row.tag.replace(/^lead-batch-/, "")}</td>
                      <td style={tdNum}>{row.contacts}</td>
                      <td style={tdNum}>{row.called}</td>
                      <td style={tdNum}>{row.replied}</td>
                      <td style={tdNum}>{row.deals}</td>
                      <td style={{ ...tdNum, color: row.overdue > 0 ? tone("bad").fg : undefined }}>{row.overdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

const th: CSSProperties = { padding: "4px 6px 6px 0", fontWeight: 600 };
const thNum: CSSProperties = { ...th, textAlign: "right" };
const td: CSSProperties = { padding: "6px 6px 6px 0" };
const tdNum: CSSProperties = { ...td, textAlign: "right" };

export function deskBadge(view: DeskView | null): { count: number | null; countTone?: "warn" } {
  if (!view) return { count: null };
  return view.counts.now > 0 ? { count: view.counts.now, countTone: "warn" } : { count: view.items.length || null };
}
