/**
 * Growth tab (PAR-10101): the sprint scope's growth experiments. A person approves, rejects or
 * abandons here through the four `seo.growth-*` worker actions (PAR-10100).
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, FlaskConical, Input, Pill, SectionCard, breakAnywhere, errorText, formatShortDate, tokens, type ToneName } from "@partnersinbiz/pib-plugin-ui";
import type { GrowthExperimentRow, GrowthLoad, TabId } from "./types.js";
import { GROWTH_UNLINKED_TEXT, canStart, growthDecider, growthScopeLabel, playbookPointer, splitExperiments } from "./growth-words.js";

const muted: CSSProperties = { fontSize: 12, color: tokens.muted, margin: 0, ...breakAnywhere };
const small: CSSProperties = { minHeight: 40, fontSize: 12 };
const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", minWidth: 0 };
const card: CSSProperties = { display: "grid", gap: 8, padding: 12, border: `1px solid ${tokens.border}`, borderRadius: 10, minWidth: 0 };
const STATUS_TONE: Record<GrowthExperimentRow["status"], ToneName> = { proposed: "warn", running: "info", measured: "ok", rejected: "neutral", abandoned: "neutral" };
const VERDICT_TONE: Record<string, ToneName> = { win: "ok", loss: "bad", no_change: "neutral", inconclusive: "neutral" };
const date = (d: string | null) => (d ? formatShortDate(d) : "");

type Act = (tool: string, params: Record<string, unknown>, success: string) => Promise<boolean>;

function Arms({ x }: { x: GrowthExperimentRow }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      {x.arms.map((a) => {
        const c = x.counts?.[a.key];
        return <p key={a.key} style={muted}><strong>{a.key}</strong>: {a.description}{c ? ` · ${c.posts} tagged, ${c.scored} scored` : ""}</p>;
      })}
    </div>
  );
}

function Head({ x }: { x: GrowthExperimentRow }) {
  return (
    <>
      <div style={row}>
        <Pill tone={STATUS_TONE[x.status]} size="sm">{x.status}</Pill>
        {x.verdict ? <Pill tone={VERDICT_TONE[x.verdict] ?? "neutral"} size="sm">{x.verdict.replace("_", " ")}</Pill> : null}
        <span style={muted}>{x.hypothesisType}</span>
      </div>
      <strong style={{ fontSize: 13, ...breakAnywhere }}>{x.hypothesis}</strong>
    </>
  );
}

function ProposedCard({ x, g, act }: { x: GrowthExperimentRow; g: GrowthLoad; act: Act }) {
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const full = !canStart(g);
  const run = async (tool: string, params: Record<string, unknown>, ok: string) => {
    setBusy(true);
    const done = await act(tool, params, ok);
    if (!done) setBusy(false);
  };
  return (
    <div style={card}>
      <Head x={x} />
      <Arms x={x} />
      <p style={muted}>Proposed {date(x.createdAt)} · window {x.windowDays} days · at least {x.minPerArm} per arm</p>
      {confirm ? (
        <div role="group" aria-label="Confirm start" style={{ ...card, background: tokens.secondary }}>
          <p style={{ ...muted, color: tokens.fg }}>Start this experiment? It changes live pages for {x.windowDays} days. You can abandon it later on this tab.</p>
          <div style={row}>
            <Button type="button" disabled={busy} style={small} onClick={() => void run("seo.growth-approve-experiment", { experimentId: x.experimentId }, "Experiment started")}>Start experiment</Button>
            <Button type="button" variant="secondary" disabled={busy} style={small} onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div style={row}>
          <Button type="button" disabled={full || busy} style={small} onClick={() => setConfirm(true)}>Approve</Button>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason to reject" aria-label="Reason to reject" style={{ flex: "1 1 200px", minWidth: 0 }} />
          <Button type="button" variant="secondary" disabled={!reason.trim() || busy} style={small} onClick={() => void run("seo.growth-reject-experiment", { experimentId: x.experimentId, reason: reason.trim() }, "Experiment rejected")}>Reject</Button>
        </div>
      )}
      {full ? <p style={muted}>{g.maxRunning} experiments are already running, so this one cannot start yet. Wait for one to be measured, or abandon one below.</p> : null}
    </div>
  );
}

function RunningCard({ x, act }: { x: GrowthExperimentRow; act: Act }) {
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const params: Record<string, unknown> = { experimentId: x.experimentId };
    if (reason.trim()) params.reason = reason.trim();
    if (!(await act("seo.growth-abandon-experiment", params, "Experiment abandoned"))) setBusy(false);
  };
  return (
    <div style={card}>
      <Head x={x} />
      <Arms x={x} />
      <p style={muted}>Started {date(x.startedAt)} · window {x.windowDays} days</p>
      {confirm ? (
        <div role="group" aria-label="Confirm abandon" style={{ ...card, background: tokens.secondary }}>
          <p style={{ ...muted, color: tokens.fg }}>Abandon this experiment? It stops and is not measured.</p>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason to abandon" style={{ minWidth: 0 }} />
          <div style={row}>
            <Button type="button" disabled={busy} style={small} onClick={() => void go()}>Abandon experiment</Button>
            <Button type="button" variant="secondary" disabled={busy} style={small} onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div style={row}><Button type="button" variant="secondary" style={small} onClick={() => setConfirm(true)}>Abandon</Button></div>
      )}
    </div>
  );
}

function FinishedCard({ x }: { x: GrowthExperimentRow }) {
  return (
    <div style={card}>
      <Head x={x} />
      <p style={muted}>{x.startedAt ? `Started ${date(x.startedAt)}` : `Proposed ${date(x.createdAt)}`}{x.measuredAt ? ` · measured ${date(x.measuredAt)}` : ""}</p>
      {x.reason ? <p style={muted}>{x.reason}</p> : null}
      {x.note ? <p style={muted}>Decision note: {x.note}</p> : null}
    </div>
  );
}

export function GrowthTab({ sprintId, onMessage, onOpenTab }: { sprintId: string; onMessage: (m: string) => void; onOpenTab: (tab: TabId) => void }) {
  const fetchGrowth = usePluginAction("seo.growth-experiments");
  const approve = usePluginAction("seo.growth-approve-experiment");
  const reject = usePluginAction("seo.growth-reject-experiment");
  const abandon = usePluginAction("seo.growth-abandon-experiment");
  const [data, setData] = useState<GrowthLoad | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData((await fetchGrowth({ sprintId })) as GrowthLoad);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [fetchGrowth, sprintId]);
  useEffect(() => { void load(); }, [load]);

  const act: Act = async (tool, params, success) => {
    const fn = tool.includes("approve") ? approve : tool.includes("reject") ? reject : abandon;
    try {
      await fn(params);
      onMessage(success);
      await load();
      return true;
    } catch (e) {
      onMessage(errorText(e));
      return false;
    }
  };

  if (error) return <EmptyState tone="bad" title="Growth experiments did not load" description={error} />;
  if (!data) return <p style={{ color: tokens.muted, fontSize: 13 }}>Loading experiments…</p>;
  if (data.scope === "unlinked") return <EmptyState icon={FlaskConical} title="No client linked" description={GROWTH_UNLINKED_TEXT} />;

  const scope = growthScopeLabel(data);
  const { proposed, running, finished } = splitExperiments(data.experiments);
  const pointer = playbookPointer(data.pendingPlaybookChanges);
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <p style={{ ...muted, fontSize: 13 }}><strong>{scope}</strong> · {growthDecider(data.autopilot)} · {data.running} of {data.maxRunning} running</p>
      {pointer ? (
        <p style={{ ...muted, fontSize: 13 }}>
          {pointer}{" "}
          <Button type="button" variant="secondary" style={small} onClick={() => onOpenTab("playbook")}>Open Playbook</Button>
        </p>
      ) : null}
      {data.experiments.length === 0 ? (
        <EmptyState icon={FlaskConical} title="No experiments yet" description={`No experiments yet for ${scope}. The SEO agent proposes them in its weekly review.`} />
      ) : null}
      {proposed.length ? (
        <SectionCard title="Waiting for you" subtitle="Approve starts it on live pages; reject needs a reason" icon={FlaskConical} tone="warn">
          <div style={{ display: "grid", gap: 12 }}>{proposed.map((x) => <ProposedCard key={x.experimentId} x={x} g={data} act={act} />)}</div>
        </SectionCard>
      ) : null}
      {running.length ? (
        <SectionCard title="Running" icon={FlaskConical} tone="info" id="running-experiments">
          <div style={{ display: "grid", gap: 12 }}>{running.map((x) => <RunningCard key={x.experimentId} x={x} act={act} />)}</div>
        </SectionCard>
      ) : null}
      {finished.length ? (
        <SectionCard title="Finished" subtitle="Measured, rejected and abandoned" icon={FlaskConical}>
          <div style={{ display: "grid", gap: 12 }}>{finished.map((x) => <FinishedCard key={x.experimentId} x={x} />)}</div>
        </SectionCard>
      ) : null}
    </div>
  );
}
