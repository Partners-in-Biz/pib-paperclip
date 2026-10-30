/**
 * Cockpit → Policy: the owner's standing approval (what the Cockpit may answer for them
 * after an ask's deadline), one switch, the change ledger and the answers it applied.
 * Read from `ownerDefaults.load`; the switch calls `ownerDefaults.save`, which the
 * worker allows for the owner alone.
 */
import { useCallback, useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, PageMessage, Pill, ShieldCheck, TriangleAlert, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { PolicyView } from "../register-w1c-policy.js";
import { Card, Muted, type LinkPropsFor } from "./components.js";

const wrap = { overflowWrap: "anywhere", minWidth: 0 } as const;

function when(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "–";
}

const list = { margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 14, color: tokens.fg, ...wrap } as const;

/** The view, without loading: also what the tests and the visual checks render. */
export function PolicyBody({ view, linkFor, busy = false, onToggle }: { view: PolicyView; linkFor: LinkPropsFor; busy?: boolean; onToggle?: (enabled: boolean) => void }) {
  const { proposal } = view;
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <Card title={proposal.name} icon={ShieldCheck} subtitle="After an ask's deadline, the Cockpit answers with the agent's recommended option, only inside this scope.">
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
            <Pill tone={view.enabled ? "ok" : "neutral"} dot>{view.enabled ? "On" : "Off"}</Pill>
            {view.canChange ? (
              <Button type="button" variant={view.enabled ? "secondary" : "primary"} disabled={busy || !onToggle} onClick={() => onToggle?.(!view.enabled)}>
                {busy ? "Saving…" : view.enabled ? "Turn off" : "Turn on"}
              </Button>
            ) : (
              <Muted>Only the owner can change this.</Muted>
            )}
          </div>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", minWidth: 0 }}>
            <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: tokens.muted }}>Issue trees covered</span>
              {proposal.roots.length ? (
                <ul style={list}>
                  {proposal.roots.map((r) => (
                    <li key={r.identifier}>{r.identifier}{r.issueId ? "" : " (not found)"}</li>
                  ))}
                </ul>
              ) : (
                <Muted>None.</Muted>
              )}
            </div>
            <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: tokens.muted }}>Kinds of question</span>
              <ul style={list}>{proposal.classes.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
            <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: tokens.muted }}>Never covered</span>
              <ul style={list}>{proposal.exclusions.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: tokens.muted }}>Floor</span>
              <span style={{ fontSize: 14, color: tokens.fg }}>An ask waits at least {proposal.floorHours} hours; a re-ask never resets the clock.</span>
            </div>
          </div>
        </div>
      </Card>
      <Card title="Changes">
        {view.ledger.length ? (
          <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
            {view.ledger.map((row) => (
              <div key={row.id} style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 14, color: tokens.fg, ...wrap }}>{row.action === "enable" ? "Turned on" : "Turned off"}: {row.detail}</span>
                <span style={{ fontSize: 12, color: tokens.muted, ...wrap }}>{when(row.at)} · {row.actor}</span>
              </div>
            ))}
          </div>
        ) : (
          <Muted>No changes yet. The policy has never been turned on.</Muted>
        )}
      </Card>
      <Card title="Answers the policy gave">
        {view.applied.length ? (
          <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
            {view.applied.map((row) => (
              <div key={row.askId} style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 14, color: tokens.fg, ...wrap }}>
                  {row.issueIdentifier ? <a {...linkFor(`/issues/${row.issueIdentifier}`)} style={{ color: tokens.primary, fontWeight: 600 }}>{row.issueIdentifier}</a> : "Issue"}
                  {row.issueTitle ? ` ${row.issueTitle}` : ""}
                </span>
                {row.question ? <span style={{ fontSize: 13, color: tokens.muted, ...wrap }}>{row.question}</span> : null}
                <span style={{ fontSize: 14, color: tokens.fg, ...wrap }}>Answered: {row.answer ?? "–"}</span>
                <span style={{ fontSize: 12, color: tokens.muted }}>{when(row.at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <Muted>The policy has not answered anything yet.</Muted>
        )}
      </Card>
    </div>
  );
}

/** The Policy tab. */
export function PolicyPanel({ linkFor, refreshKey = 0 }: { linkFor: LinkPropsFor; refreshKey?: number }) {
  const load = usePluginAction("ownerDefaults.load");
  const save = usePluginAction("ownerDefaults.save");
  const [view, setView] = useState<PolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setView((await load({})) as PolicyView);
    } catch (err) {
      setError(errorText(err));
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await save({ enabled });
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (error && !view) {
    return <EmptyState tone="bad" icon={TriangleAlert} title="The policy could not load" description={error} action={<Button type="button" variant="secondary" onClick={() => void reload()}>Try again</Button>} />;
  }
  if (!view) return <Muted>Loading the policy…</Muted>;
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {error ? <PageMessage message={error} tone="bad" /> : null}
      <PolicyBody view={view} linkFor={linkFor} busy={busy} onToggle={(enabled) => void toggle(enabled)} />
    </div>
  );
}
