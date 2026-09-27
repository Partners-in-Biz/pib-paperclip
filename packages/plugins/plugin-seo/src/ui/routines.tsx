/**
 * The SEO routines on the own SEO page: the page reads their schedule
 * triggers (the worker cannot) and reports them, so Setup's checklist is
 * right, and the setup link `/seo?routines=on` opens a one-click "Switch on".
 */
import { useEffect, useRef, useState } from "react";
import { Button, Modal, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { readRoutine, routineReportParams, routineRunning, scheduleOn, switchOnRoutine, type RoutineInfo } from "./routine-client.js";

export interface RoutineRef {
  key: string;
  title: string;
  id: string | null;
  status: string | null;
  /** From the page's last report; null when never checked. */
  triggersOn: boolean | null;
}

/** Read each routine once per id/status and report its schedule when the worker's copy is out of date. */
export function useRoutineReports(input: { routines: RoutineRef[] | null | undefined; report: (params: Record<string, unknown>) => Promise<unknown>; onReported: () => void }) {
  const [infos, setInfos] = useState<Record<string, RoutineInfo>>({});
  const callbacks = useRef(input);
  callbacks.current = input;
  const refs = (input.routines ?? []).filter((r): r is RoutineRef & { id: string } => Boolean(r.id));
  const signature = refs.map((r) => `${r.id}:${r.status}:${r.triggersOn}`).join("|");
  useEffect(() => {
    if (refs.length === 0) return;
    let live = true;
    void (async () => {
      let reported = false;
      for (const ref of refs) {
        const info = await readRoutine(ref.id).catch(() => null);
        if (!live || !info) continue;
        setInfos((prev) => ({ ...prev, [ref.key]: info }));
        if (ref.triggersOn !== scheduleOn(info) || ref.status !== info.status) {
          await callbacks.current.report(routineReportParams(info)).catch(() => undefined);
          reported = true;
        }
      }
      if (live && reported) callbacks.current.onReported();
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return { infos, setInfos };
}

const noteStyle = { margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 } as const;

/** The one-click prompt behind Setup's "Switch them on" link. */
export function RoutinesSwitchOn({ routines, infos, report, onClose, onSwitched }: {
  routines: RoutineRef[];
  infos: Record<string, RoutineInfo>;
  report: (params: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
  onSwitched: (infos: Record<string, RoutineInfo>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const known = routines.filter((r) => r.id);
  const off = known.filter((r) => !routineRunning(infos[r.key] ?? null));
  const reading = known.some((r) => !infos[r.key]);
  const switchOn = async () => {
    setBusy(true);
    setError("");
    const next: Record<string, RoutineInfo> = { ...infos };
    try {
      for (const r of off) {
        const info = infos[r.key];
        if (!info) continue;
        next[r.key] = await switchOnRoutine(info);
        await report(routineReportParams(next[r.key]!)).catch(() => undefined);
      }
      onSwitched(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="Switch on the SEO routines"
      onClose={onClose}
      footer={known.length === 0 || (off.length === 0 && !reading) ? (
        <Button type="button" onClick={onClose}>Close</Button>
      ) : (
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Not now</Button>
          <Button type="button" disabled={busy || reading} onClick={() => void switchOn()}>{busy ? "Switching on…" : "Switch on"}</Button>
        </>
      )}
    >
      {known.length === 0 ? (
        <p style={noteStyle}>The routines are created, already switched on, when the SEO agent is linked. Staff the SEO Specialist in Setup → Team first.</p>
      ) : off.length === 0 && !reading ? (
        <p style={noteStyle}>Both routines are already on: daily at 06:30 and Mondays at 07:00.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <p style={noteStyle}>"Run today's SEO" runs every morning at 06:30: the SEO agent works every active sprint. "Weekly SEO review" runs on Mondays at 07:00: it reviews the optimization proposals. Anything that publishes or changes a live site still waits for sign-off.</p>
          <p style={noteStyle}>This sets {off.length ? off.map((r) => `"${r.title}"`).join(" and ") : "them"} active with the schedule on. You can pause them any time under Routines.</p>
          {reading ? <p style={noteStyle}>Reading the routines…</p> : null}
        </div>
      )}
      {error ? <p role="alert" style={{ ...noteStyle, color: "var(--destructive)" }}>Not switched on: {error}. Open Routines and switch them on there.</p> : null}
    </Modal>
  );
}
