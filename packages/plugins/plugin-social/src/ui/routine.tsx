/**
 * The weekly plan routine on the own Social page: the page reads its trigger
 * (the worker cannot) and reports it, so Setup's checklist is right, and the
 * setup link `/social?routine=on` opens a one-click "Switch on".
 */
import { useEffect, useRef, useState } from "react";
import { Button, Modal, errorText } from "@partnersinbiz/pib-plugin-ui";
import { Banner, Muted } from "./parts.js";
import { readRoutine, routineReportParams, routineRunning, scheduleOn, switchOnRoutine, type RoutineInfo } from "./routine-client.js";
import type { WeeklyRoutineRef } from "./types.js";

/** Read the routine once per id/status and report its trigger when the worker's copy is out of date. */
export function useWeeklyRoutine(input: { routine: WeeklyRoutineRef | null | undefined; report: (params: Record<string, unknown>) => Promise<unknown>; onReported: () => void }) {
  const [info, setInfo] = useState<RoutineInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef(input);
  callbacks.current = input;
  const ref = input.routine ?? null;
  useEffect(() => {
    setError(null);
    if (!ref) {
      setInfo(null);
      return;
    }
    let live = true;
    readRoutine(ref.id)
      .then(async (next) => {
        if (!live || !next) return;
        setInfo(next);
        if (ref.triggersOn !== scheduleOn(next) || ref.status !== next.status) {
          await callbacks.current.report(routineReportParams(next)).catch(() => undefined);
          if (live) callbacks.current.onReported();
        }
      })
      .catch((e: unknown) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [ref?.id, ref?.status, ref?.triggersOn]);
  return { info, error, setInfo };
}

/** The one-click prompt behind Setup's "Switch it on" link. */
export function RoutineSwitchOn({ routine, info, onClose, onSwitched, report }: {
  routine: WeeklyRoutineRef | null;
  info: RoutineInfo | null;
  onClose: () => void;
  onSwitched: (info: RoutineInfo) => void;
  report: (params: Record<string, unknown>) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = routineRunning(info);
  const switchOn = async () => {
    if (!info) return;
    setBusy(true);
    setError("");
    try {
      const next = await switchOnRoutine(info);
      await report(routineReportParams(next)).catch(() => undefined);
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
      title="Switch on the weekly plan"
      description={routine?.title ? `The "${routine.title}" routine` : undefined}
      onClose={onClose}
      footer={running || !routine ? (
        <Button type="button" onClick={onClose}>Close</Button>
      ) : (
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Not now</Button>
          <Button type="button" disabled={busy || !info} onClick={() => void switchOn()}>{busy ? "Switching on…" : "Switch on"}</Button>
        </>
      )}
    >
      {!routine ? (
        <Muted>The weekly routine is created when the Social agent is linked. Staff the Social agent in Setup → Team first.</Muted>
      ) : running ? (
        <Banner tone="info" title="It is already on">Every Monday at 07:00 the Social agent reviews last week and drafts next week's posts for approval.</Banner>
      ) : (
        <>
          <Muted>Every Monday at 07:00 the Social agent reviews last week's results, proposes experiments and drafts next week's posts for each client and for PiB. Nothing is published until a person approves it.</Muted>
          <Muted>This sets the routine active and switches its Monday trigger on. You can pause it any time under Routines.</Muted>
          {!info ? <Muted>Reading the routine…</Muted> : null}
        </>
      )}
      {error ? <Banner tone="error" title="Not switched on">{error}. Open Routines and switch it on there.</Banner> : null}
    </Modal>
  );
}
