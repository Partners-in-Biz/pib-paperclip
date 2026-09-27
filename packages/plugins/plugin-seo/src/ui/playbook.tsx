/**
 * Playbook tab (0.7.0): the learned SEO playbook of the sprint's scope (one
 * client, or PiB's own sites), shared by every sprint of that client. Shows
 * the current version, what waits for a decision (Keep / Discard) and the
 * version history with reasons.
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { MarkdownBlock, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Activity, BookOpen, Button, Gavel, Modal, Pill, SectionCard, breakAnywhere, errorText, tokens, tone, type ToneName } from "@partnersinbiz/pib-plugin-ui";

type Change = {
  changeId: string;
  status: "pending" | "kept" | "discarded";
  source: "measured" | "agent" | "person";
  op: "add" | "remove" | "replace";
  diff: string;
  reason: string;
  optimizationId: string | null;
  baseVersion: number;
  resultVersion: number | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  createdAt: string | null;
};

type Version = { version: number; reason: string; optimizationId: string | null; decidedBy: string | null; createdAt: string | null; playbook?: string };

export type PlaybookData = {
  playbookId: string;
  client: string | null;
  clientName: string | null;
  sprintId: string | null;
  autopilotMode: string | null;
  version: number;
  playbook: string;
  pendingChanges: Change[];
  recentDecisions: Change[];
  versions: Version[];
};

const small: CSSProperties = { height: 28, fontSize: 12, padding: "0 10px" };
const muted: CSSProperties = { fontSize: 12, color: tokens.muted, ...breakAnywhere };

const SOURCE: Record<Change["source"], string> = {
  measured: "Drafted from a measured optimization",
  agent: "Proposed by the SEO Specialist",
  person: "Proposed by a person",
};

const STATUS_TONE: Record<Change["status"], ToneName> = { pending: "warn", kept: "ok", discarded: "neutral" };

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function whoDecides(mode: string | null): string {
  if (mode === "full") return "Full autopilot: the SEO Specialist keeps or discards changes itself, and measured wins are kept automatically.";
  if (mode === "off") return "Autopilot off: the SEO Specialist only reads the playbook. Measured results still draft changes for you to decide.";
  return "Safe autopilot: you keep or discard each change here (they are also listed once on the sprint's weekly Needs you issue).";
}

function ChangeCard({ change, busy, onDecide }: { change: Change; busy: boolean; onDecide: (decision: "keep" | "discard") => void }) {
  return (
    <div style={{ border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${tone("warn").solid}`, borderRadius: 12, padding: 12, display: "grid", gap: 6, minWidth: 0 }}>
      <strong style={{ fontSize: 13, lineHeight: 1.45, ...breakAnywhere }}>{change.diff}</strong>
      <span style={{ fontSize: 13, ...breakAnywhere }}>{change.reason}</span>
      <span style={muted}>{SOURCE[change.source]} · based on v{change.baseVersion} · {day(change.createdAt)}</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" style={small} disabled={busy} onClick={() => onDecide("keep")}>Keep</Button>
        <Button type="button" variant="secondary" style={small} disabled={busy} onClick={() => onDecide("discard")}>Discard</Button>
      </div>
    </div>
  );
}

export function PlaybookTab({ sprintId, onChanged, onMessage }: { sprintId: string; onChanged: () => Promise<void>; onMessage: (m: string) => void }) {
  const callAction = usePluginAction("seo.call");
  const [data, setData] = useState<PlaybookData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData((await callAction({ tool: "get-playbook", params: { sprintId, includeVersionText: true } })) as PlaybookData);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [callAction, sprintId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(change: Change, decision: "keep" | "discard") {
    setBusy(true);
    try {
      const result = (await callAction({ tool: "decide-playbook-change", params: { changeId: change.changeId, decision } })) as { playbookVersion: number };
      await load();
      await onChanged();
      onMessage(decision === "keep" ? `Kept: playbook v${result.playbookVersion}.` : "Discarded.");
    } catch (e) {
      onMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p style={{ color: tokens.muted, fontSize: 13 }}>{error}</p>;
  if (!data) return <p style={{ color: tokens.muted, fontSize: 13 }}>Loading playbook…</p>;
  const scope = data.client ? data.clientName ?? "this client" : "Partners in Biz's own sites";
  const version = data.versions.find((v) => v.version === viewing) ?? null;
  const discarded = data.recentDecisions.filter((c) => c.status === "discarded");

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <SectionCard
        title={`Waiting for a decision (${data.pendingChanges.length})`}
        subtitle={whoDecides(data.autopilotMode)}
        icon={Gavel}
        tone={data.pendingChanges.length ? "warn" : undefined}
      >
        {data.pendingChanges.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Nothing waits. When an optimization is measured as a win or a loss, its lesson appears here as a proposed rule.</p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {data.pendingChanges.map((c) => <ChangeCard key={c.changeId} change={c} busy={busy} onDecide={(d) => void decide(c, d)} />)}
          </div>
        )}
      </SectionCard>

      <SectionCard title={`Playbook v${data.version}`} subtitle={`Shared by every sprint of ${scope}. The SEO Specialist reads it before working tasks.`} icon={BookOpen}>
        <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <MarkdownBlock content={data.playbook} />
        </div>
      </SectionCard>

      <SectionCard title="History" subtitle="Every version with the reason it changed" icon={Activity}>
        <div style={{ display: "grid", gap: 8 }}>
          {data.versions.map((v) => (
            <div key={v.version} style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap", minWidth: 0 }}>
              <Button type="button" variant="secondary" style={small} onClick={() => setViewing(v.version)}>v{v.version}</Button>
              <span style={{ display: "grid", gap: 2, flex: "1 1 220px", minWidth: 0 }}>
                <span style={{ fontSize: 13, ...breakAnywhere }}>{v.reason}</span>
                <span style={muted}>{day(v.createdAt)}{v.decidedBy === "autopilot" ? " · kept by full autopilot" : ""}{v.optimizationId ? " · from a measured optimization" : ""}</span>
              </span>
            </div>
          ))}
          {discarded.length > 0 ? (
            <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
              <strong style={{ fontSize: 12, color: tokens.muted }}>Recently discarded</strong>
              {discarded.map((c) => (
                <div key={c.changeId} style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap", minWidth: 0 }}>
                  <Pill tone={STATUS_TONE[c.status]} size="sm">{c.status}</Pill>
                  <span style={{ ...muted, flex: "1 1 220px" }}>{c.diff}{c.note ? ` — ${c.note}` : ""}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </SectionCard>

      <Modal open={version !== null} title={version ? `Playbook v${version.version}` : "Playbook"} description={version ? `${version.reason} · ${day(version.createdAt)}` : undefined} onClose={() => setViewing(null)}>
        {version?.playbook ? <MarkdownBlock content={version.playbook} /> : <p style={muted}>No text stored for this version.</p>}
      </Modal>
    </div>
  );
}
