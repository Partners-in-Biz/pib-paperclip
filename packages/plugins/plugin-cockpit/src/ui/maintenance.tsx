/**
 * Cockpit → Maintenance: the standing maintenance window, the weekly upkeep, the next planned
 * stop-first release and the last release notes. Read from `maintenance.load`.
 */
import { useCallback, useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Pill, TriangleAlert, Wrench, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { MaintenanceView, ReleaseNote, ReleaseNotePhase } from "../maintenance.js";
import { Card, Muted } from "./components.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SAST_OFFSET_MS = 2 * 3_600_000;

const PHASE_TONE: Record<ReleaseNotePhase, "warn" | "ok" | "bad"> = { planned: "warn", live: "ok", cancelled: "bad" };
const PHASE_LABEL: Record<ReleaseNotePhase, string> = { planned: "Planned", live: "Live", cancelled: "Cancelled" };
const REASON_LABEL: Record<ReleaseNote["reason"], string> = { migration: "Database change", capability: "New permission", both: "Database change and new permission" };

const two = (n: number) => String(n).padStart(2, "0");

function parts(ms: number) {
  const d = new Date(ms);
  return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, time: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` };
}

/** `26 Oct, 01:00–04:00 UTC (03:00–06:00 SAST)`. SAST is UTC+2 all year. */
export function formatWindow(startIso: string, endIso: string): string {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return "–";
  const u = [parts(s), parts(e)] as const;
  const z = [parts(s + SAST_OFFSET_MS), parts(e + SAST_OFFSET_MS)] as const;
  const range = (p: typeof u) => (p[0].date === p[1].date ? `${p[0].time}–${p[1].time}` : `${p[0].time}–${p[1].date} ${p[1].time}`);
  return `${u[0].date}, ${range(u)} UTC (${z[0].date === u[0].date ? "" : `${z[0].date}, `}${range(z)} SAST)`;
}

const wrap = { overflowWrap: "anywhere", minWidth: 0 } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: tokens.muted }}>{label}</span>
      <span style={{ fontSize: 14, color: tokens.fg, ...wrap }}>{children}</span>
    </div>
  );
}

function NoteDetails({ note }: { note: ReleaseNote }) {
  return (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", minWidth: 0 }}>
      <Row label="Plugin">{note.plugin} {note.version}</Row>
      <Row label="Why it stops">{REASON_LABEL[note.reason]}</Row>
      <Row label="Window">{formatWindow(note.windowStartUtc, note.windowEndUtc)}</Row>
      <Row label="Expected downtime">{note.downtimeMinutes} {note.downtimeMinutes === 1 ? "minute" : "minutes"}</Row>
    </div>
  );
}

/** The view, without loading: also what the tests and the visual checks render. */
export function MaintenanceBody({ view }: { view: MaintenanceView }) {
  const { window: win, weekly, next, recent } = view;
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <Card title="Maintenance window" icon={Wrench} subtitle="Releases that need a restart wait for this window. Everything else ships without a stop.">
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", minWidth: 0 }}>
          <Row label="Every day (UTC)">{win.startUtc}–{win.endUtc}</Row>
          <Row label="Every day (SAST)">{win.startSast}–{win.endSast}</Row>
          <Row label="Weekly upkeep">{weekly.day}s {weekly.startUtc} UTC, report only</Row>
        </div>
      </Card>
      <Card title="Next planned release">
        {next ? (
          <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
            <div><Pill tone={PHASE_TONE[next.phase]} dot>{PHASE_LABEL[next.phase]}</Pill></div>
            <NoteDetails note={next} />
          </div>
        ) : (
          <Muted>No stop-first release is planned. Nothing will restart in the next window.</Muted>
        )}
      </Card>
      <Card title="Recent release notes">
        {recent.length ? (
          <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
            {recent.map((note, i) => (
              <div key={`${note.id}:${note.phase}:${i}`} style={{ display: "grid", gap: 6, minWidth: 0, paddingTop: i ? 12 : 0, borderTop: i ? `1px solid ${tokens.border}` : undefined }}>
                <div><Pill tone={PHASE_TONE[note.phase]} dot>{PHASE_LABEL[note.phase]}</Pill></div>
                <NoteDetails note={note} />
              </div>
            ))}
          </div>
        ) : (
          <Muted>No release notes yet.</Muted>
        )}
      </Card>
    </div>
  );
}

/** The Maintenance tab. */
export function MaintenancePanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const load = usePluginAction("maintenance.load");
  const [view, setView] = useState<MaintenanceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setView((await load({})) as MaintenanceView);
    } catch (err) {
      setError(errorText(err));
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  if (error && !view) {
    return <EmptyState tone="bad" icon={TriangleAlert} title="Maintenance could not load" description={error} action={<Button type="button" variant="secondary" onClick={() => void reload()}>Try again</Button>} />;
  }
  if (!view) return <Muted>Loading maintenance…</Muted>;
  return <MaintenanceBody view={view} />;
}
