/**
 * Growth tab: the scope's Growth Lab program. What worked (7-day lift vs the
 * account's usual), the playbook the agent follows (with versions and
 * pending changes), experiments, and the program settings.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DataTable, MarkdownBlock, MetricCard, StatusBadge, type StatusBadgeVariant } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Field, Input, Modal, Select, StatRow, TextArea, Toolbar, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { Banner, Card, fmtDate, Muted, platformLabel, Row, scopeName, scopeParams, SmallButton } from "./parts.js";
import type { GrowthChange, GrowthExperiment, GrowthPost, GrowthSnapshot, RunAction, Snapshot } from "./types.js";

export function fmtLift(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;
}

const EXPERIMENT_TONE: Record<string, StatusBadgeVariant> = {
  proposed: "warning",
  running: "info",
  measured: "ok",
  rejected: "pending",
  abandoned: "pending",
};

const VERDICT_TONE: Record<string, StatusBadgeVariant> = {
  win: "ok",
  loss: "error",
  no_change: "pending",
  inconclusive: "warning",
};

const AUTOPILOT_HELP: Record<string, string> = {
  off: "Agents only read the review and the playbook. Scores and measurements still run.",
  safe: "Agents propose; a person approves experiments and keeps or discards playbook changes (one approval issue a week).",
  full: "Agent proposals start at once, the agent may decide playbook changes, and wins are kept automatically.",
};

function Chip({ children, tone }: { children: string; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "#15803d" : tone === "bad" ? "var(--destructive)" : tokens.muted;
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${tokens.border}`, color }}>{children}</span>;
}

function PostRow({ post, tz }: { post: GrowthPost; tz: string }) {
  return (
    <div style={{ display: "grid", gap: 4, paddingTop: 8, borderTop: `1px solid ${tokens.border}` }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Row>
          <strong style={{ fontSize: 13, color: post.lift !== null && post.lift < 0 ? "var(--destructive)" : "#15803d" }}>{fmtLift(post.lift)}</strong>
          <Muted>{post.platforms.map(platformLabel).join(", ")} · {fmtDate(post.publishedAt, tz, false)}</Muted>
        </Row>
        {post.arm ? <Chip>{`experiment · ${post.arm}`}</Chip> : null}
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
          <Muted key={arm.key}>
            <strong>{arm.key}</strong>: {arm.description}
            {c ? ` · ${c.posts} tagged, ${c.published} published, ${c.scored}/${experiment.minPerArm} scored` : ""}
          </Muted>
        );
      })}
    </div>
  );
}

function ExperimentCard({ experiment, canDecide, act }: { experiment: GrowthExperiment; canDecide: boolean; act: (key: string, params: Record<string, unknown>, success: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  return (
    <Card style={{ gap: 6 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Row>
          <StatusBadge label={experiment.status} status={EXPERIMENT_TONE[experiment.status] ?? "pending"} />
          {experiment.verdict ? <StatusBadge label={experiment.verdict.replace("_", " ")} status={VERDICT_TONE[experiment.verdict] ?? "pending"} /> : null}
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

  if (error) return <EmptyState title="Growth could not load" description={error} />;
  if (!data) return <p style={{ margin: 0, fontSize: 13 }}>Loading…</p>;

  const waiting = data.proposedExperiments.length + data.pendingChanges.length;
  const version = viewVersion !== null ? data.versions.find((v) => v.version === viewVersion) ?? null : null;
  const open = data.experiments.filter((e) => e.status === "proposed" || e.status === "running");
  const done = data.experiments.filter((e) => e.status !== "proposed" && e.status !== "running");

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
          <SmallButton key={days} onClick={() => setPeriod(days)} style={period === days ? { background: tokens.primary, color: tokens.primaryFg } : undefined}>Last {days} days</SmallButton>
        ))}
      </Toolbar>
      <StatRow>
        <MetricCard label="Posts scored" value={data.summary.postsScored} />
        <MetricCard label="Median lift" value={fmtLift(data.summary.medianLift)} />
        <MetricCard label="Running experiments" value={data.runningExperiments.length} />
        <MetricCard label="Waiting for a decision" value={waiting} />
      </StatRow>

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

      <Card>
        <strong style={{ fontSize: 13 }}>Feature lifts</strong>
        <Muted>Median 7-day lift of posts with each feature value (at least 3 posts).</Muted>
        <DataTable
          columns={[
            { key: "feature", header: "Feature" },
            { key: "count", header: "Posts" },
            { key: "lift", header: "Median lift" },
          ]}
          rows={data.featureLifts.map((f) => ({ id: f.key, feature: f.key.replace("=", ": ").replace(/_/g, " "), count: f.count, lift: fmtLift(f.medianLift) }))}
          emptyMessage="Not enough scored posts yet."
        />
      </Card>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
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

