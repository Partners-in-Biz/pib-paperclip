/**
 * Growth tab: the scope's Growth Lab program. What worked (7-day lift vs the
 * account's usual), the playbook the agent follows (with versions and
 * pending changes), experiments, and the program settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DataTable, MarkdownBlock, useHostNewIssue } from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  ChartPie,
  CircleCheck,
  DonutChart,
  EmptyState,
  Field,
  Gavel,
  GiveToAgentButton,
  Input,
  KpiCard,
  Lightbulb,
  Modal,
  Pill,
  ProgressBar,
  Scale,
  SectionCard,
  Select,
  Target,
  TextArea,
  Toolbar,
  TrendingUp,
  errorText,
  fluidColumns,
  tokens,
  tone,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { Banner, Card, chipStyle, fmtDate, Muted, PlatformBadge, platformLabel, Row, scopeName, scopeParams, SmallButton } from "./parts.js";
import { EXPERIMENT_TONE, VERDICT_TONE, toneOf, verdictSegments } from "./series.js";
import type { GrowthChange, GrowthExperiment, GrowthFocusView, GrowthHookBoard, GrowthPartRow, GrowthPost, GrowthSnapshot, RunAction, Snapshot } from "./types.js";

export function fmtLift(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;
}

const AUTOPILOT_HELP: Record<string, string> = {
  off: "Agents only read the review and the playbook. Scores and measurements still run.",
  safe: "Agents propose; a person approves experiments and keeps or discards playbook changes (one approval issue a week).",
  full: "Agent proposals start at once, the agent may decide playbook changes, and wins are kept automatically.",
};

function Chip({ children, tone: t }: { children: string; tone?: ToneInput }) {
  return <Pill size="sm" tone={t ?? "neutral"} variant={t ? "soft" : "outline"}>{children}</Pill>;
}

function liftTone(value: number | null | undefined): "ok" | "bad" | "neutral" {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return "neutral";
  return value > 0 ? "ok" : "bad";
}

/** Median lift per feature value as bars either side of zero: green right for positive, red left for negative. */
export function LiftBars({ items }: { items: Array<{ key: string; label: string; lift: number; count: number }> }) {
  if (items.length === 0) return <Muted>Not enough scored posts yet.</Muted>;
  const max = Math.max(...items.map((i) => Math.abs(i.lift)), 0.01);
  const summary = `Feature lifts: ${items.map((i) => `${i.label} ${fmtLift(i.lift)} over ${i.count} posts`).join(", ")}`;
  return (
    <div role="img" aria-label={summary} style={{ display: "grid", gap: 10, minWidth: 0 }}>
      {items.map((item) => {
        const t = tone(liftTone(item.lift));
        const width = `${Math.max((Math.abs(item.lift) / max) * 100, item.lift ? 4 : 0)}%`;
        return (
          <div key={item.key} aria-hidden="true" style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, minWidth: 0 }}>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.label} <span style={{ color: tokens.muted }}>· {item.count} posts</span></span>
              <span style={{ color: t.fg, fontWeight: 650, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmtLift(item.lift)}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", height: 8, borderRadius: 999, background: tokens.track, overflow: "hidden", position: "relative" }}>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>{item.lift < 0 ? <div style={{ width, height: "100%", background: t.solid, borderRadius: "999px 0 0 999px" }} /> : null}</div>
              <div style={{ display: "flex" }}>{item.lift > 0 ? <div style={{ width, height: "100%", background: t.solid, borderRadius: "0 999px 999px 0" }} /> : null}</div>
              <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: tokens.muted, opacity: 0.6 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PostRow({ post, tz }: { post: GrowthPost; tz: string }) {
  return (
    <div style={{ display: "grid", gap: 4, paddingTop: 8, borderTop: `1px solid ${tokens.border}` }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Row>
          <Pill tone={liftTone(post.lift)} variant="solid" size="sm">{fmtLift(post.lift)}</Pill>
          <Row style={{ gap: 4 }}>{post.platforms.map((p) => <PlatformBadge key={p} platform={p} size={20} />)}</Row>
          <Muted>{fmtDate(post.publishedAt, tz, false)}</Muted>
        </Row>
        {post.arm ? <Chip tone="info">{`experiment · ${post.arm}`}</Chip> : null}
      </Row>
      <div style={{ fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{post.caption}</div>
      <Row>{Object.entries(post.features).map(([k, v]) => <Chip key={k}>{`${k}: ${v.replace(/_/g, " ")}`}</Chip>)}</Row>
    </div>
  );
}

function ArmLine({ experiment }: { experiment: GrowthExperiment }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      {experiment.arms.map((arm) => {
        const c = experiment.counts?.[arm.key];
        return (
          <div key={arm.key} style={{ display: "grid", gap: 4 }}>
            <Muted>
              <strong>{arm.key}</strong>: {arm.description}
              {c ? ` · ${c.posts} tagged, ${c.published} published` : ""}
            </Muted>
            {c ? <ProgressBar done={Math.min(c.scored, experiment.minPerArm)} total={experiment.minPerArm} size="xs" label={`${arm.key} scored`} valueText={`${c.scored}/${experiment.minPerArm} scored`} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function ExperimentCard({ experiment, canDecide, act, full = false, maxRunning = 0 }: { experiment: GrowthExperiment; canDecide: boolean; full?: boolean; maxRunning?: number; act: (key: string, params: Record<string, unknown>, success: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  return (
    <Card style={{ gap: 6, borderLeft: `3px solid ${tone(experiment.verdict ? toneOf(VERDICT_TONE, experiment.verdict) : toneOf(EXPERIMENT_TONE, experiment.status)).solid}` }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Row>
          <Pill tone={toneOf(EXPERIMENT_TONE, experiment.status)} dot>{experiment.status}</Pill>
          {experiment.verdict ? <Pill tone={toneOf(VERDICT_TONE, experiment.verdict)} variant="solid">{experiment.verdict.replace("_", " ")}</Pill> : null}
          <Muted>{experiment.hypothesisType}</Muted>
        </Row>
        <Muted>{experiment.startedAt ? `started ${fmtDate(experiment.startedAt, undefined, false)}` : `proposed ${fmtDate(experiment.createdAt, undefined, false)}`}</Muted>
      </Row>
      <strong style={{ fontSize: 13 }}>{experiment.hypothesis}</strong>
      <ArmLine experiment={experiment} />
      {experiment.reason ? <Muted>{experiment.reason}</Muted> : null}
      {experiment.playbookDiff ? <Muted>Playbook: {experiment.playbookDiff} ({experiment.playbookDecision ?? "no change"})</Muted> : null}
      {experiment.note ? <Muted>Note: {experiment.note}</Muted> : null}
      {canDecide && experiment.status === "proposed" ? (
        <Row>
          <Button type="button" disabled={full} style={{ height: 28, fontSize: 12 }} onClick={() => void act("social.growth-approve-experiment", { experimentId: experiment.experimentId }, "Experiment started")}>Approve</Button>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason to reject" style={{ flex: "1 1 200px", height: 28 }} />
          <SmallButton disabled={!reason.trim()} onClick={() => void act("social.growth-reject-experiment", { experimentId: experiment.experimentId, reason }, "Experiment rejected")}>Reject</SmallButton>
        </Row>
      ) : null}
      {canDecide && experiment.status === "proposed" && full ? (
        <Muted>
          {maxRunning} experiments are already running, so this one cannot start yet. Wait for one to be measured, or{" "}
          <SmallButton onClick={() => document.getElementById("running-experiments")?.scrollIntoView({ behavior: "smooth", block: "start" })}>abandon one below</SmallButton>.
        </Muted>
      ) : null}
      {canDecide && experiment.status === "running" ? (
        <Row>
          <SmallButton onClick={() => void act("social.growth-abandon-experiment", { experimentId: experiment.experimentId }, "Experiment abandoned")}>Abandon</SmallButton>
        </Row>
      ) : null}
    </Card>
  );
}

function ChangeCard({ change, canDecide, act }: { change: GrowthChange; canDecide: boolean; act: (key: string, params: Record<string, unknown>, success: string) => Promise<void> }) {
  return (
    <Card style={{ gap: 6 }}>
      <strong style={{ fontSize: 13 }}>{change.diff}</strong>
      <Muted>{change.reason}{change.experimentId ? " · from an experiment" : ""} · based on v{change.baseVersion}</Muted>
      {canDecide ? (
        <Row>
          <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => void act("social.growth-decide-change", { changeId: change.changeId, decision: "keep" }, "Kept: new playbook version")}>Keep</Button>
          <SmallButton onClick={() => void act("social.growth-decide-change", { changeId: change.changeId, decision: "discard" }, "Discarded")}>Discard</SmallButton>
        </Row>
      ) : null}
    </Card>
  );
}

interface CadenceDay {
  day: string;
  label: string;
  accounts: Array<{ id: string; name: string; target: number; have: number }>;
  free: Array<{ time: string; accounts: string[] }>;
}
interface CadenceData {
  cadence: { postsPerDay: number; perPlatform: Record<string, number>; days: number[]; windowStart: string; windowEnd: string; lookaheadDays: number } | null;
  summary: string;
  days: CadenceDay[];
}
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const WEEK_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The scope's posting cadence: posts a day per account (a number per platform where it differs), the days and the hours.
 * The daily calendar check counts each account's posts against it and gives the Social agent the free slots.
 */
function CadenceCard({ snapshot, run }: { snapshot: Snapshot; run: RunAction }) {
  const [data, setData] = useState<CadenceData | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [perDay, setPerDay] = useState("3");
  const [perPlatform, setPerPlatform] = useState<Record<string, string>>({});
  const [days, setDays] = useState<number[]>(WEEK);
  const [start, setStart] = useState("07:00");
  const [end, setEnd] = useState("19:00");
  const [ahead, setAhead] = useState("2");
  const [busy, setBusy] = useState(false);
  const fill = (next: CadenceData) => {
    setData(next);
    const c = next.cadence;
    if (!c) return;
    setPerDay(String(c.postsPerDay));
    setPerPlatform(Object.fromEntries(Object.entries(c.perPlatform).map(([k, v]) => [k, String(v)])));
    setDays(c.days);
    setStart(c.windowStart);
    setEnd(c.windowEnd);
    setAhead(String(c.lookaheadDays));
  };
  const scopeKey = snapshot.space === "me" ? "me" : snapshot.scope ?? "own";
  useEffect(() => {
    if (snapshot.space === "me") return;
    run("social.get-cadence", scopeParams(snapshot)).then((r) => fill(r as CadenceData)).catch((e: unknown) => setError(errorText(e)));
  }, [scopeKey]);
  if (snapshot.space === "me") return null;
  const platforms = Array.from(new Set(snapshot.accounts.filter((a) => a.status !== "disabled").map((a) => a.platform)));
  const isPerson = Boolean(snapshot.viewer.userId);
  const save = async (clear: boolean) => {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const params = clear
        ? { ...scopeParams(snapshot), clear: true }
        : { ...scopeParams(snapshot), postsPerDay: Number(perDay), perPlatform: Object.fromEntries(Object.entries(perPlatform).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v)])), days, windowStart: start, windowEnd: end, lookaheadDays: Number(ahead) };
      fill((await run("social.set-cadence", params)) as CadenceData);
      setSaved(clear ? "Cadence cleared." : "Cadence saved. The daily calendar check fills the gaps from tomorrow morning.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const perDayTotal = platforms.length ? snapshot.accounts.filter((a) => a.status !== "disabled").reduce((n, a) => n + Number(perPlatform[a.platform]?.trim() ? perPlatform[a.platform] : perDay || 0), 0) : 0;
  return (
    <Card>
      <strong style={{ fontSize: 13 }}>Posting cadence for {scopeName(snapshot)}</strong>
      <Muted>{data ? data.summary : "Loading…"} Every morning the calendar check counts each account's posts against it and gives the Social agent the free slots to fill. Nothing goes out without approval.</Muted>
      {error ? <Banner tone="error" title="Cadence">{error}</Banner> : null}
      {saved ? <Banner tone="info" title="Cadence">{saved}</Banner> : null}
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: fluidColumns(160, "auto-fit") }}>
        <Field label="Posts a day, each account"><Input type="number" min={0} max={50} value={perDay} disabled={!isPerson} onChange={(e) => setPerDay(e.target.value)} /></Field>
        {platforms.map((p) => (
          <Field key={p} label={`${platformLabel(p)} (blank = same)`}>
            <Input type="number" min={0} max={50} value={perPlatform[p] ?? ""} disabled={!isPerson} placeholder={perDay} onChange={(e) => setPerPlatform({ ...perPlatform, [p]: e.target.value })} />
          </Field>
        ))}
        <Field label="First post"><Input type="time" value={start} disabled={!isPerson} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Last post"><Input type="time" value={end} disabled={!isPerson} onChange={(e) => setEnd(e.target.value)} /></Field>
        <Field label="Plan ahead">
          <Select value={ahead} disabled={!isPerson} onChange={(e) => setAhead(e.target.value)}>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={String(n)}>{n === 1 ? "1 day" : `${n} days`}</option>)}
          </Select>
        </Field>
      </div>
      <Row style={{ flexWrap: "wrap", gap: 6 }}>
        <Muted>Days:</Muted>
        {WEEK.map((d) => {
          const on = days.includes(d);
          return (
            <button key={d} type="button" disabled={!isPerson} aria-pressed={on} onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d])} style={{ ...chipStyle(on), cursor: isPerson ? "pointer" : "default", fontFamily: "inherit" }}>
              {WEEK_NAME[d]}
            </button>
          );
        })}
        {platforms.length ? <Muted>About {perDayTotal} account-posts a day ({platforms.length} platform{platforms.length === 1 ? "" : "s"}).</Muted> : <Muted>No connected accounts in this scope yet.</Muted>}
      </Row>
      {isPerson ? (
        <Row>
          <Button type="button" disabled={busy} onClick={() => void save(false)}>Save cadence</Button>
          {data?.cadence ? <SmallButton disabled={busy} onClick={() => void save(true)}>Clear</SmallButton> : null}
        </Row>
      ) : null}
      {data?.days.length ? (
        <div style={{ display: "grid", gap: 4 }}>
          <Muted style={{ fontWeight: 600 }}>Days ahead</Muted>
          {data.days.map((d) => (
            <Muted key={d.day}>
              <strong>{d.label}</strong>: {d.accounts.map((a) => `${a.name} ${a.have}/${a.target}`).join(" · ")}
              {d.free.length ? ` — ${d.free.length} free slot${d.free.length === 1 ? "" : "s"} (${d.free.slice(0, 6).map((f) => f.time).join(", ")}${d.free.length > 6 ? ", …" : ""})` : " — full"}
            </Muted>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function ProgramSettings({ data, snapshot, act }: { data: GrowthSnapshot; snapshot: Snapshot; act: (key: string, params: Record<string, unknown>, success: string) => Promise<void> }) {
  const p = data.program;
  const [objective, setObjective] = useState(p.objective);
  const [autopilot, setAutopilot] = useState(p.autopilot);
  const [topics, setTopics] = useState(p.topics.join(", "));
  const [brandVoice, setBrandVoice] = useState(p.brandVoice ?? "");
  const [platforms, setPlatforms] = useState(p.platforms ?? "");
  const [cadence, setCadence] = useState(p.cadence ?? "");
  return (
    <Card>
      <strong style={{ fontSize: 13 }}>Program for {scopeName(snapshot)}</strong>
      <Muted>Metric: {p.metric}. Each post is compared with the same account's median over the 30 days before it.</Muted>
      <Field label="Goal"><Input value={objective} onChange={(e) => setObjective(e.target.value)} /></Field>
      <Field label="Autopilot">
        <Select value={autopilot} onChange={(e) => setAutopilot(e.target.value as typeof autopilot)}>
          <option value="off">Off</option>
          <option value="safe">Safe (a person approves)</option>
          <option value="full">Full</option>
        </Select>
      </Field>
      <Muted>{AUTOPILOT_HELP[autopilot]}</Muted>
      <Field label="Topics (comma separated; Jev tags each post with one)"><Input value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="pricing, case studies, team, tips" /></Field>
      <Field label="Brand voice"><Input value={brandVoice} onChange={(e) => setBrandVoice(e.target.value)} placeholder="Plain, warm, South African English" /></Field>
      <Field label="Platforms"><Input value={platforms} onChange={(e) => setPlatforms(e.target.value)} placeholder="LinkedIn and Instagram first" /></Field>
      <Field label="Cadence notes (free text for the agent; the numbers are in Posting cadence above)"><Input value={cadence} onChange={(e) => setCadence(e.target.value)} placeholder="Video on weekdays, carousels on weekends" /></Field>
      <Row>
        <Button type="button" onClick={() => void act("social.growth-update-program", { ...scopeParams(snapshot), objective, autopilot, topics, brandVoice, platforms, cadence }, "Program saved")}>Save program</Button>
      </Row>
    </Card>
  );
}

const VERDICT_PILL: Record<GrowthPartRow["verdict"], ToneInput | undefined> = { "double down": "ok", drop: "bad", "keep testing": "info", "too little reach": undefined };

/** This month's focus of the scope: what every post serves. People set it here; agents set it with `set-focus`. */
function FocusCard({ view, snapshot, canEdit, save }: { view: GrowthFocusView; snapshot: Snapshot; canEdit: boolean; save: (params: Record<string, unknown>) => Promise<boolean> }) {
  const f = view.focus;
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState("");
  const [audience, setAudience] = useState("");
  const [offer, setOffer] = useState("");
  const [proof, setProof] = useState("");
  const [metric, setMetric] = useState("");
  const [learned, setLearned] = useState("");
  const [saving, setSaving] = useState(false);
  // A focus of another month is closed with what it taught before this month's starts.
  const closing = Boolean(f) && view.state !== "current";
  const start = () => {
    const keep = f && !closing ? f : null;
    setTheme(keep?.theme ?? "");
    setAudience(keep?.audience ?? f?.audience ?? "");
    setOffer(keep?.offer ?? "");
    setProof((keep?.proof ?? []).join("\n"));
    setMetric(keep?.metric ?? "");
    setLearned("");
    setOpen(true);
  };
  const ready = theme.trim() && audience.trim() && offer.trim() && proof.trim() && metric.trim() && (!closing || learned.trim());
  return (
    <Card>
      <Row style={{ justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13 }}>Focus for {f && !closing ? f.month : view.thisMonth}</strong>
        {canEdit ? <SmallButton onClick={start}>{f && !closing ? "Edit" : "Set the focus"}</SmallButton> : null}
      </Row>
      {f && !closing ? (
        <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
          <strong style={{ fontSize: 15 }}>{f.theme}</strong>
          <span><Muted>For</Muted> {f.audience}</span>
          <span><Muted>The ask</Muted> {f.offer}</span>
          <span><Muted>It worked when</Muted> {f.metric}</span>
          <Muted>Built from: {f.proof.join(" · ")}</Muted>
        </div>
      ) : (
        <Muted>{closing && f ? `The last focus was ${f.month}: "${f.theme}". Close it with what it taught and set this month's.` : "No focus yet. One theme, one audience and one ask for the month, so every post pulls the same way and the numbers can show what worked."}</Muted>
      )}
      {view.past.length ? <Muted>Before: {view.past.map((p) => `${p.month} ${p.theme}${p.learned ? ` (${p.learned})` : ""}`).join(" · ")}</Muted> : null}
      <Modal open={open} title={`Focus for ${view.thisMonth}: ${scopeName(snapshot)}`} onClose={() => setOpen(false)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" disabled={!ready || saving} onClick={() => {
            setSaving(true);
            // A refused save keeps the form open with what was typed.
            void save({ ...scopeParams(snapshot), theme, audience, offer, proof: proof.split("\n"), metric, learned: learned || undefined }).then((ok) => {
              setSaving(false);
              if (ok) setOpen(false);
            });
          }}>Save focus</Button>
        </>
      )}>
        <div style={{ display: "grid", gap: 10 }}>
          {closing && f ? <Field label={`What did ${f.month} ("${f.theme}") teach? Hooks and formats to keep, and to drop`}><TextArea rows={2} value={learned} onChange={(e) => setLearned(e.target.value)} /></Field> : null}
          <Field label="Theme: what the month is about, in one line"><Input value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="Stop losing leads after hours" /></Field>
          <Field label="Audience: one kind of person, and the moment they are in"><Input value={audience} onChange={(e) => setAudience(e.target.value)} /></Field>
          <Field label="The ask: the one thing we want them to do"><Input value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="Download the app" /></Field>
          <Field label="Proof: real material to build from, one per line (results with their source, stories, screens)"><TextArea rows={4} value={proof} onChange={(e) => setProof(e.target.value)} /></Field>
          <Field label="The number that says the month worked"><Input value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="200 app downloads from social" /></Field>
        </div>
      </Modal>
    </Card>
  );
}

type GivePart = "hook" | "body" | "cta" | "board";
type Give = (part: GivePart, name: string | null) => ReactNode;

/** Give to agent from the hook board: the worker writes the prefill; the person edits it in the host's New Task popup. */
function useHookGive(snapshot: Snapshot, run: RunAction, periodDays: number, onDone: (message: string, tone: "ok" | "error") => void): Give {
  const host = useHostNewIssue();
  const newIssue = useMemo(() => ({ open: (defaults?: Parameters<typeof host.open>[0]) => host.open(defaults) }), [host]);
  if (!snapshot.viewer.userId) return () => null;
  return (part, name) => (
    <GiveToAgentButton
      newIssue={newIssue}
      label={part === "board" ? "Give the board to an agent" : "Give to agent"}
      style={part === "board" ? undefined : { height: 26, fontSize: 11, padding: "0 8px" }}
      prepare={async () => (await run("social.hook-give-prepare", { ...scopeParams(snapshot), part, name, periodDays })) as { title: string; description: string; projectId?: string; assigneeAgentId?: string }}
      record={async () => undefined}
      onDone={(out) => onDone(`${out.message} The Social agent picks it up.`, "ok")}
      onError={(message) => onDone(message, "error")}
    />
  );
}

function PartTable({ title, one, part, rows, give }: { title: string; one: string; part: Exclude<GivePart, "board">; rows: GrowthPartRow[]; give: Give }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <strong style={{ fontSize: 12 }}>{title}</strong>
      <DataTable
        columns={[
          { key: "name", header: one },
          { key: "posts", header: "Posts" },
          { key: "reach", header: "Reached" },
          { key: "rate", header: "Acted per 100" },
          // The host table prints cell values as text: an element must come from `render`.
          { key: "verdict", header: "Verdict", render: (value) => <Chip tone={VERDICT_PILL[value as GrowthPartRow["verdict"]]}>{String(value)}</Chip> },
          { key: "give", header: "", render: (_value, row) => give(part, String((row as { name: string }).name)) },
        ]}
        rows={rows.map((r) => ({
          id: r.name,
          name: r.name,
          posts: r.posts,
          reach: r.reach,
          rate: r.rate === null ? "—" : String(r.rate),
          verdict: r.verdict,
          give: "",
        }))}
      />
    </div>
  );
}

/** Which hooks, bodies and asks worked, from the tags on published posts. */
function HookBoardCard({ board, give, notice }: { board: GrowthHookBoard; give: Give; notice: { message: string; tone: "ok" | "error" } | null }) {
  const control = [board.control.hook ? `hook "${board.control.hook}"` : null, board.control.body ? `body "${board.control.body}"` : null, board.control.cta ? `ask "${board.control.cta}"` : null].filter(Boolean);
  const empty = board.hooks.length + board.bodies.length + board.ctas.length === 0;
  return (
    <SectionCard title="Hook board" subtitle={`${board.tagged} of ${board.published} published posts tagged · ${board.reach} people reached · last ${board.periodDays} days`} icon={Target} actions={give("board", null)}>
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        {notice ? <Banner tone={notice.tone === "ok" ? "info" : "error"} title={notice.tone === "ok" ? "Task created" : "Not created"}>{notice.message}</Banner> : null}
        {control.length ? <Muted>The control to beat: {control.join(", ")}.</Muted> : null}
        {board.notes.map((note) => <Muted key={note}>{note}</Muted>)}
        {empty ? (
          <EmptyState compact icon={Lightbulb} title="No tagged posts yet" description="Posts tagged hook:, body: and cta: show up here once they are published, ranked by how many of the people they reached acted." />
        ) : (
          <>
            <PartTable title="Hooks" one="Hook" part="hook" rows={board.hooks} give={give} />
            <PartTable title="Bodies" one="Body" part="body" rows={board.bodies} give={give} />
            <PartTable title="Asks" one="Ask" part="cta" rows={board.ctas} give={give} />
          </>
        )}
      </div>
    </SectionCard>
  );
}

export function GrowthTab({ snapshot, run }: { snapshot: Snapshot; run: RunAction }) {
  const [data, setData] = useState<GrowthSnapshot | null>(null);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState(28);
  const [editing, setEditing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const seq = useRef(0);
  const tz = snapshot.config.timezone;
  const [giveNotice, setGiveNotice] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const give = useHookGive(snapshot, run, period, (message, t) => setGiveNotice({ message, tone: t }));

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = (await run("social.growth-load", { ...scopeParams(snapshot), periodDays: period })) as GrowthSnapshot;
      if (mine === seq.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, [run, snapshot.scope, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (key: string, params: Record<string, unknown>, success: string) => {
    try {
      await run(key, params, success);
    } catch {
      return;
    }
    await load();
  }, [run, load]);

  const saveFocus = useCallback(async (params: Record<string, unknown>) => {
    try {
      await run("social.growth-set-focus", params, "Focus saved");
    } catch {
      return false;
    }
    await load();
    return true;
  }, [run, load]);

  if (error) return <EmptyState tone="bad" title="Growth could not load" description={error} />;
  if (!data) return <p style={{ margin: 0, fontSize: 13 }}>Loading…</p>;

  const atCapacity = data.runningExperiments.length >= data.maxRunning;
  const waiting = data.proposedExperiments.length + data.pendingChanges.length;
  const version = viewVersion !== null ? data.versions.find((v) => v.version === viewVersion) ?? null : null;
  const open = data.experiments.filter((e) => e.status === "proposed" || e.status === "running");
  const done = data.experiments.filter((e) => e.status !== "proposed" && e.status !== "running");
  const measured = data.experiments.filter((e) => e.verdict);
  const verdicts = verdictSegments(data.experiments);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {!data.jevConfigured ? (
        <Banner tone="info" title="Jev is not set up">
          Posts still get scores and code features (format, length, daypart), but no hook, CTA, topic or tone, and the inbox is not triaged. Add the TypeSafe key under Settings → Plugins → Social → Jev.
        </Banner>
      ) : null}
      {data.notes.map((note) => <Banner key={note} tone="info" title="Note">{note}</Banner>)}
      {data.focus ? <FocusCard view={data.focus} snapshot={snapshot} canEdit={data.canDecide} save={saveFocus} /> : null}
      <Toolbar>
        {[7, 28, 90].map((days) => (
          <SmallButton key={days} aria-pressed={period === days} onClick={() => setPeriod(days)} style={chipStyle(period === days)}>Last {days} days</SmallButton>
        ))}
      </Toolbar>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: fluidColumns(150), minWidth: 0 }}>
        <KpiCard label="Posts scored" value={data.summary.postsScored} icon={CircleCheck} hint={`${data.summary.postsWithLift} with a lift · last ${data.periodDays} days`} />
        <KpiCard label="Median lift" value={fmtLift(data.summary.medianLift)} icon={TrendingUp} tone={data.summary.medianLift !== null && data.summary.medianLift < 0 ? "bad" : undefined} hint="vs each account's usual" />
        <KpiCard label="Running experiments" value={data.runningExperiments.length} icon={Target} />
        <KpiCard label="Waiting for a decision" value={waiting} icon={Gavel} tone={waiting ? "warn" : undefined} hint={waiting ? "Experiments or playbook changes" : "Nothing waiting"} />
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: fluidColumns(340), minWidth: 0 }}>
        <SectionCard title="Experiment verdicts" subtitle={`${measured.length} measured`} icon={ChartPie}>
          {measured.length ? (
            <DonutChart title="Experiment verdicts" segments={verdicts} centerValue={measured.length} centerLabel="measured" />
          ) : <EmptyState compact icon={Scale} title="No verdicts yet" description="An experiment gets a verdict once each arm has enough scored posts." />}
        </SectionCard>
        <SectionCard title="Feature lifts" subtitle="Median 7-day lift of posts with each feature value (at least 3 posts)" icon={Lightbulb}>
          <LiftBars items={data.featureLifts.map((f) => ({ key: f.key, label: f.key.replace("=", ": ").replace(/_/g, " "), lift: f.medianLift, count: f.count }))} />
        </SectionCard>
      </div>

      {data.hookBoard ? <HookBoardCard board={data.hookBoard} give={give} notice={giveNotice} /> : null}

      {waiting ? (
        <div style={{ display: "grid", gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Waiting for a decision</strong>
          {data.proposedExperiments.map((e) => <ExperimentCard key={e.experimentId} experiment={e} canDecide={data.canDecide} act={act} full={atCapacity} maxRunning={data.maxRunning} />)}
          {data.pendingChanges.map((c) => <ChangeCard key={c.changeId} change={c} canDecide={data.canDecide} act={act} />)}
        </div>
      ) : null}

      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <strong style={{ fontSize: 13 }}>Playbook v{data.program.playbookVersion}</strong>
          <Row>
            <SmallButton onClick={() => { setEditing(data.playbook); setReason(""); }}>Edit</SmallButton>
          </Row>
        </Row>
        <MarkdownBlock content={data.playbook} />
        <div style={{ display: "grid", gap: 2 }}>
          <Muted>Versions</Muted>
          {data.versions.map((v) => (
            <Row key={v.version}>
              <SmallButton onClick={() => setViewVersion(v.version)}>v{v.version}</SmallButton>
              <Muted>{v.reason} · {fmtDate(v.createdAt, tz)}</Muted>
            </Row>
          ))}
        </div>
      </Card>

      <div id="running-experiments" style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Experiments</strong>
        {data.experiments.length === 0 ? <Muted>No experiments yet. The Social agent proposes them in its weekly review.</Muted> : null}
        {open.filter((e) => e.status === "running").map((e) => <ExperimentCard key={e.experimentId} experiment={e} canDecide={data.canDecide} act={act} />)}
        {done.map((e) => <ExperimentCard key={e.experimentId} experiment={e} canDecide={false} act={act} />)}
      </div>

      <Card>
        <strong style={{ fontSize: 13 }}>What to test next</strong>
        <Muted>Ranked by UCB: types never tried come first, then the ones that won, with a bonus for being tried less.</Muted>
        <DataTable
          columns={[
            { key: "type", header: "Hypothesis type" },
            { key: "tries", header: "Tries" },
            { key: "rank", header: "Score" },
            { key: "observed", header: "Posts so far" },
          ]}
          rows={data.rankedHypothesisTypes.map((r) => ({
            id: r.type,
            type: `${r.type}${r.running ? " (running)" : ""}`,
            tries: r.tries,
            rank: r.untried ? "untried" : String(r.score),
            observed: r.observedPosts ? `${fmtLift(r.observedLift)} over ${r.observedPosts} posts` : "—",
          }))}
          emptyMessage="Nothing to rank yet."
        />
      </Card>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: fluidColumns(320) }}>
        <Card>
          <strong style={{ fontSize: 13 }}>Top posts</strong>
          {data.top.length === 0 ? <Muted>No scored posts with a lift yet.</Muted> : data.top.map((p) => <PostRow key={p.postId} post={p} tz={tz} />)}
        </Card>
        <Card>
          <strong style={{ fontSize: 13 }}>Bottom posts</strong>
          {data.bottom.length === 0 ? <Muted>Shown once there are more than 5 scored posts.</Muted> : data.bottom.map((p) => <PostRow key={p.postId} post={p} tz={tz} />)}
        </Card>
      </div>

      <Card>
        <strong style={{ fontSize: 13 }}>Feature questions</strong>
        <Muted>Built in: {data.featureQuestions.builtIn.join(", ")}. The agent adds its own questions when the top and bottom posts differ in a way these do not capture ({data.featureQuestions.slotsLeft} of 12 left).</Muted>
        {data.featureQuestions.custom.map((q) => (
          <Row key={q.key} style={{ justifyContent: "space-between" }}>
            <Muted><strong>{q.key}</strong> ({q.type}): {q.question}{q.options ? ` [${q.options.join(", ")}]` : ""}{q.levels ? ` [${q.levels.join(" → ")}]` : ""}</Muted>
            {data.canDecide ? <SmallButton onClick={() => void act("social.growth-retire-question", { ...scopeParams(snapshot), key: q.key }, "Question retired")}>Retire</SmallButton> : null}
          </Row>
        ))}
      </Card>

      <CadenceCard snapshot={snapshot} run={run} />
      <ProgramSettings key={data.program.programId + data.program.autopilot} data={data} snapshot={snapshot} act={act} />

      <Modal open={editing !== null} title={`Edit playbook (v${data.program.playbookVersion} → v${data.program.playbookVersion + 1})`} onClose={() => setEditing(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button type="button" disabled={!editing?.trim()} onClick={() => {
            const playbook = editing ?? "";
            setEditing(null);
            void act("social.growth-save-playbook", { ...scopeParams(snapshot), playbook, reason: reason || undefined }, "Playbook saved");
          }}>Save new version</Button>
        </>
      )}>
        <Field label="Playbook (markdown)"><TextArea rows={18} value={editing ?? ""} onChange={(e) => setEditing(e.target.value)} /></Field>
        <Field label="Why (shown in the history)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Edited by hand" /></Field>
      </Modal>
      <Modal open={version !== null} title={version ? `Playbook v${version.version}` : "Playbook"} description={version ? `${version.reason} · ${fmtDate(version.createdAt, tz)}` : undefined} onClose={() => setViewVersion(null)}>
        {version ? <MarkdownBlock content={version.playbook} /> : null}
      </Modal>
    </div>
  );
}

/** Growth Lab arm tag on a post, for the composer. Value "" is untagged, else "<experimentId>|<arm>". */
export function ExperimentSelect({ snapshot, value, onChange }: { snapshot: Snapshot; value: string; onChange: (value: string) => void }) {
  const known = value === "" || snapshot.experiments.some((e) => value.startsWith(`${e.experimentId}|`));
  if (snapshot.experiments.length === 0 && value === "") return null;
  return (
    <Field label="Growth Lab experiment (optional)">
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Experiment arm">
        <option value="">Not part of an experiment</option>
        {!known ? <option value={value}>Current experiment (closed)</option> : null}
        {snapshot.experiments.map((e) => (
          <optgroup key={e.experimentId} label={`${e.hypothesis.slice(0, 80)}${e.status === "proposed" ? " (waiting for approval)" : ""}`}>
            {e.arms.map((arm) => <option key={arm.key} value={`${e.experimentId}|${arm.key}`}>{arm.key}: {arm.description.slice(0, 80)}</option>)}
          </optgroup>
        ))}
      </Select>
    </Field>
  );
}

