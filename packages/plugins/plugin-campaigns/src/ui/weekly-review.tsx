import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Input, Pill, Section, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";

interface Arm {
  key: string;
  description: string;
}

export interface ReviewExperiment {
  experimentId: string;
  status: string;
  hypothesis: string;
  hypothesisType: string;
  variable: string;
  arms: Arm[];
  createdAt: string | null;
  startedAt: string | null;
  verdict: string | null;
  reason: string | null;
  note: string | null;
}

export interface ReviewChange {
  changeId: string;
  status: string;
  diff: string;
  reason: string | null;
  experimentId: string | null;
  baseVersion: number | null;
}

export interface WeeklyReviewData {
  autopilot: string;
  playbookVersion: number;
  experiments: ReviewExperiment[];
  changes: ReviewChange[];
}

const card = { display: "grid", gap: 6, padding: 12, border: `1px solid ${tokens.border}`, borderRadius: 8 } as const;
const muted = { color: tokens.muted, fontSize: 12.5 } as const;
const failure = { color: tokens.destructive, fontSize: 13 } as const;
const small = { height: 28, fontSize: 12 } as const;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** The first arm is the control, the others are variants. */
export function armRole(index: number): string {
  return index === 0 ? "Control" : "Variant";
}

function ExperimentCard({ experiment, busy, onApprove, onReject }: { experiment: ReviewExperiment; busy: boolean; onApprove: () => void; onReject: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const proposed = experiment.status === "proposed";
  return (
    <div style={card}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={proposed ? "warn" : experiment.status === "running" ? "info" : "neutral"} dot>{proposed ? "Waiting for approval" : experiment.status}</Pill>
        {experiment.verdict ? <Pill tone="neutral">{experiment.verdict.replace("_", " ")}</Pill> : null}
        <span style={muted}>{experiment.hypothesisType} · {experiment.variable} · {proposed ? `proposed ${day(experiment.createdAt)}` : `started ${day(experiment.startedAt)}`}</span>
      </div>
      <strong>{experiment.hypothesis}</strong>
      <div style={{ display: "grid", gap: 2 }}>
        {experiment.arms.map((arm, index) => (
          <span key={arm.key} style={muted}><strong>{armRole(index)} ({arm.key})</strong>: {arm.description}</span>
        ))}
      </div>
      {experiment.reason ? <span style={muted}>{experiment.reason}</span> : null}
      {proposed ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button type="button" style={small} disabled={busy} onClick={onApprove}>Approve</Button>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason to reject" style={{ flex: "1 1 200px", height: 28 }} />
          <Button type="button" variant="secondary" style={small} disabled={busy || !reason.trim()} onClick={() => onReject(reason.trim())}>Reject</Button>
        </div>
      ) : null}
    </div>
  );
}

/** The Weekly review tab: the experiments and playbook changes a person has to decide, and the ones already running. */
export function WeeklyReview({ client }: { client: string | null }) {
  const load = usePluginAction("campaigns.growth-load");
  const approve = usePluginAction("campaigns.growth-approve-experiment");
  const reject = usePluginAction("campaigns.growth-reject-experiment");
  const decide = usePluginAction("campaigns.growth-decide-change");
  const [data, setData] = useState<WeeklyReviewData | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setData((await load({ client })) as WeeklyReviewData);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [load, client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      await work();
      setMessage(success);
    } catch (e) {
      setMessage(errorText(e));
      setFailed(true);
    }
    await refresh();
    setBusy(false);
  }

  if (error && !data) return <EmptyState title="Could not load the weekly review" description={error} />;
  if (!data) return <span style={muted}>Loading the weekly review…</span>;

  const proposed = data.experiments.filter((e) => e.status === "proposed");
  const others = data.experiments.filter((e) => e.status !== "proposed");
  const nothing = proposed.length === 0 && data.changes.length === 0;
  const list = (children: ReactNode) => <div style={{ display: "grid", gap: 8 }}>{children}</div>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {error ? <div role="alert" style={failure}>Could not refresh the weekly review: {error}. What you see may be out of date.</div> : null}
      {message ? <div role={failed ? "alert" : "status"} style={failed ? failure : muted}>{message}</div> : null}
      {data.autopilot !== "full" ? <span style={muted}>Autopilot is {data.autopilot}: agents propose, a person approves here.</span> : null}
      {nothing ? <EmptyState compact title="Nothing waiting for you" description="New experiments and playbook changes show here when the weekly review proposes them." /> : null}

      {proposed.length ? (
        <Section title={`Experiments to approve (${proposed.length})`}>
          {list(proposed.map((e) => (
            <ExperimentCard
              key={e.experimentId}
              experiment={e}
              busy={busy}
              onApprove={() => void act(() => approve({ experimentId: e.experimentId }), "Approved: the experiment is running")}
              onReject={(reason) => void act(() => reject({ experimentId: e.experimentId, reason }), "Rejected")}
            />
          )))}
        </Section>
      ) : null}

      {data.changes.length ? (
        <Section title={`Playbook changes to decide (${data.changes.length})`}>
          {list(data.changes.map((c) => (
            <div key={c.changeId} style={card}>
              <strong>{c.diff}</strong>
              <span style={muted}>{c.reason}{c.experimentId ? " · from an experiment" : ""}{c.baseVersion !== null ? ` · based on v${c.baseVersion}` : ""}</span>
              <div style={{ display: "flex", gap: 8 }}>
                <Button type="button" style={small} disabled={busy} onClick={() => void act(() => decide({ changeId: c.changeId, decision: "keep" }), `Kept: playbook updated`)}>Keep</Button>
                <Button type="button" variant="secondary" style={small} disabled={busy} onClick={() => void act(() => decide({ changeId: c.changeId, decision: "discard" }), "Discarded")}>Discard</Button>
              </div>
            </div>
          )))}
        </Section>
      ) : null}

      {others.length ? (
        <Section title="Running and measured">
          {list(others.map((e) => <ExperimentCard key={e.experimentId} experiment={e} busy={busy} onApprove={() => undefined} onReject={() => undefined} />))}
        </Section>
      ) : null}
    </div>
  );
}
