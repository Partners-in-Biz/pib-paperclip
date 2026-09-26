/**
 * Growth tab: the scope's Growth Lab program. What worked (7-day lift vs the
 * account's usual), the playbook the agent follows (with versions and
 * pending changes), experiments, and the program settings.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DataTable, MarkdownBlock } from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  ChartPie,
  CircleCheck,
  DonutChart,
  EmptyState,
  Field,
  Gavel,
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
import { Banner, Card, chipStyle, fmtDate, Muted, PlatformBadge, Row, scopeName, scopeParams, SmallButton } from "./parts.js";
import { EXPERIMENT_TONE, VERDICT_TONE, toneOf, verdictSegments } from "./series.js";
import type { GrowthChange, GrowthExperiment, GrowthPost, GrowthSnapshot, RunAction, Snapshot } from "./types.js";

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

function ExperimentCard({ experiment, canDecide, act }: { experiment: GrowthExperiment; canDecide: boolean; act: (key: string, params: Record<string, unknown>, success: string) => Promise<void> }) {
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
          <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => void act("social.growth-approve-experiment", { experimentId: experiment.experimentId }, "Experiment started")}>Approve</Button>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason to reject" style={{ flex: "1 1 200px", height: 28 }} />
          <SmallButton disabled={!reason.trim()} onClick={() => void act("social.growth-reject-experiment", { experimentId: experiment.experimentId, reason }, "Experiment rejected")}>Reject</SmallButton>
        </Row>
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
      <Field label="Cadence"><Input value={cadence} onChange={(e) => setCadence(e.target.value)} placeholder="3 posts a week per platform" /></Field>
      <Row>
        <Button type="button" onClick={() => void act("social.growth-update-program", { ...scopeParams(snapshot), objective, autopilot, topics, brandVoice, platforms, cadence }, "Program saved")}>Save program</Button>
      </Row>
    </Card>
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

  if (error) return <EmptyState tone="bad" title="Growth could not load" description={error} />;
  if (!data) return <p style={{ margin: 0, fontSize: 13 }}>Loading…</p>;

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

      {waiting ? (
        <div style={{ display: "grid", gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Waiting for a decision</strong>
          {data.proposedExperiments.map((e) => <ExperimentCard key={e.experimentId} experiment={e} canDecide={data.canDecide} act={act} />)}
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

      <div style={{ display: "grid", gap: 8 }}>
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

