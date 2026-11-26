/**
 * Cockpit → Browser → "Watch live" and "Take over browser" (PAR-14514 design 4, stages S3 and S4): a drawer with the
 * server browser's screen. The ticket comes from `browser.live.ticket`, the socket is the plugin's websocket route,
 * and the screen is drawn by noVNC. noVNC is imported on open, so it is its own chunk (esbuild `splitting`) and never
 * loads with the other Cockpit pages.
 *
 * Watch live is read-only (`viewOnly`). Take over (mode `control`, one identity) gives keyboard and mouse; the drawer
 * polls `browser.live.status` for the countdown and the lease's end, names the tasks "Done" will wake
 * (`browser.takeover.waiting`), and has "Done - resume agent" ("Done - check login" when none) and "Stop". When the
 * daemon reports the lease ended because the login was seen, the drawer shows "Logged in" and sends Done by itself.
 *
 * The host closes every socket after 5 minutes; the drawer then asks for a fresh ticket and connects again (a take-over
 * only while its lease is live). Errors are shown. The ticket is never logged and is dropped as soon as the socket opens.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Button, Modal, Pill, Sheet, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { PLUGIN_KEY } from "../constants.js";
import { useCockpitAction } from "./actions.js";

export type LiveState = "connecting" | "live" | "reconnecting" | "error" | "ended";
export type LiveMode = "view" | "control";

/** Fails in a row, with no screen shown in between, before the drawer stops and says so. */
export const MAX_FAILED_CONNECTS = 3;
const RECONNECT_DELAY_MS = 1000;
/** A connection that lasts at least this long counts as good; a quicker drop counts as a failed attempt. */
export const STABLE_CONNECT_MS = 5000;
const STATUS_POLL_MS = 3000;
const WAITING_POLL_MS = 10_000;

export type DisconnectDecision = { action: "reconnect" | "retry" | "fail"; failed: number };

/** What to do when the live socket closes. A connect that drops within STABLE_CONNECT_MS, or never connected, counts as failed. */
export function afterDisconnect(input: { shown: boolean; connectedAt: number; now: number; failed: number }): DisconnectDecision {
  if (input.shown && input.now - input.connectedAt >= STABLE_CONNECT_MS) return { action: "reconnect", failed: 0 };
  const failed = input.failed + 1;
  return { action: failed >= MAX_FAILED_CONNECTS ? "fail" : "retry", failed };
}

/** The route's address, relative to this page (`wss:` on https). The ticket is single use and lasts 30 seconds. */
export function liveSocketUrl(origin: { protocol: string; host: string }, companyId: string, ticket: string): string {
  const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${origin.host}/api/plugins/${encodeURIComponent(PLUGIN_KEY)}/api/browser/live?companyId=${encodeURIComponent(companyId)}&ticket=${encodeURIComponent(ticket)}`;
}

/** Where one identity's take-over stands, from the daemon's `/status` `lease`. */
export type TakeoverPhase =
  | { kind: "none" }
  | { kind: "live"; secondsLeft: number }
  | { kind: "other"; identity: string }
  | { kind: "logged_in" }
  | { kind: "ended"; reason: string };

export function takeoverPhase(lease: unknown, identity: string): TakeoverPhase {
  if (!lease || typeof lease !== "object") return { kind: "none" };
  const l = lease as Record<string, unknown>;
  const leaseIdentity = typeof l.identity === "string" ? l.identity : "";
  if (l.state === "live") {
    if (leaseIdentity !== identity) return { kind: "other", identity: leaseIdentity };
    return { kind: "live", secondsLeft: typeof l.secondsLeft === "number" && l.secondsLeft > 0 ? Math.floor(l.secondsLeft) : 0 };
  }
  // "ended, not confirmed" is only ever this identity's when it names it; another identity's ended lease is not ours.
  if (l.state === "ended" && leaseIdentity === identity) return l.reason === "logged_in" ? { kind: "logged_in" } : { kind: "ended", reason: typeof l.reason === "string" ? l.reason : "ended" };
  return { kind: "none" };
}

/**
 * The take-over is over for the drawer: a result, or the lease not live any more after it was seen live (its end,
 * Done from elsewhere, a daemon restart). Before it was seen live, an "ended" lease is an older take-over's.
 */
export const takeoverOver = (phase: TakeoverPhase, hasResult: boolean, seenLive: boolean) => hasResult || (seenLive && phase.kind !== "live");
/** What the drawer shows: an older take-over's end is not this one's. */
export const shownPhase = (phase: TakeoverPhase, seenLive: boolean): TakeoverPhase => (!seenLive && (phase.kind === "ended" || phase.kind === "logged_in") ? { kind: "none" } : phase);

export interface WaitingTask { identifier: string; title: string }
export const doneLabel = (tasks: readonly WaitingTask[]) => (tasks.length ? "Done - resume agent" : "Done - check login");

const END_WORDS: Record<string, string> = {
  time_limit: "the 20 minutes ran out",
  no_control_stream: "no screen was connected for a minute",
  window_closed: "the login window was closed",
  window_failed: "the login window could not open",
  released: "it was released",
  shutdown: "the browser service restarted",
};
export const endWords = (reason: string) => END_WORDS[reason] ?? reason;

export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const LABELS: Record<LiveState, string> = { connecting: "Connecting…", live: "Live, view only", reconnecting: "Reconnecting…", error: "Not connected", ended: "Take-over ended" };

/** Take-over only: whether a (re)connect may open a control stream. A new control stream would start a new lease. */
export interface ControlGate {
  /** Done, Stop or the lease's end was seen: never connect again. */
  over: MutableRefObject<boolean>;
  /** The lease was seen live once: every later connect first checks it still is. */
  seenLive: MutableRefObject<boolean>;
  stillLive: () => Promise<boolean>;
}

function useLiveScreen(companyId: string, open: boolean, expanded: boolean, identity: string | null, mode: LiveMode, gate: ControlGate) {
  const getTicket = useCockpitAction("browser.live.ticket");
  const screen = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<LiveState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ticketAction = useRef(getTicket);
  ticketAction.current = getTicket;
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const stopRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let rfb: { disconnect(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failed = 0;
    let first = true;

    const fail = (message: string) => {
      if (stopped) return;
      stopped = true;
      setError(message);
      setState("error");
    };
    const connect = async () => {
      if (stopped || !screen.current) return;
      try {
        // A take-over reconnects only while its lease is live: a new control stream would start a new take-over.
        if (mode === "control") {
          const g = gateRef.current;
          if (g.over.current || ((g.seenLive.current || !first) && !(await g.stillLive()))) {
            stopped = true;
            setState("ended");
            return;
          }
        }
        first = false;
        const params = mode === "control" ? { mode, identity } : { mode: "view", ...(identity ? { identity } : {}) };
        const [{ default: RFB }, ticket] = await Promise.all([import("@novnc/novnc"), ticketAction.current(params) as Promise<{ ticket: string }>]);
        if (stopped || !screen.current) return;
        const connection = new RFB(screen.current, liveSocketUrl(window.location, companyId, ticket.ticket), {});
        connection.viewOnly = mode !== "control";
        connection.scaleViewport = true;
        connection.background = "transparent";
        rfb = connection;
        let shown = false;
        let connectedAt = 0;
        connection.addEventListener("connect", () => {
          shown = true;
          connectedAt = Date.now();
          setError(null);
          setState("live");
          if (mode === "control") connection.focus();
        });
        connection.addEventListener("disconnect", () => {
          rfb = null;
          if (stopped) return;
          // After a screen was shown for a while, the 5-minute end or a drop is expected: connect again with a fresh ticket.
          // A quick drop counts as a failed attempt, so a server that accepts and drops at once cannot loop forever.
          const decision = afterDisconnect({ shown, connectedAt, now: Date.now(), failed });
          failed = decision.failed;
          if (decision.action === "fail") return fail("The live screen could not be reached.");
          setState("reconnecting");
          timer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
        });
        connection.addEventListener("securityfailure", () => fail("The live screen refused the connection."));
        connection.addEventListener("credentialsrequired", () => fail("The live screen asked for a password. It should not."));
      } catch (err) {
        // A refused ticket (setting off, not an owner or admin) will not get better by asking again.
        fail(errorText(err));
      }
    };

    stopRef.current = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      rfb?.disconnect();
      setState("ended");
    };
    setState("connecting");
    setError(null);
    void connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      rfb?.disconnect();
    };
  // `expanded` swaps the container (sheet or modal), so the screen box is a new element and must connect again.
  }, [open, companyId, attempt, expanded, identity, mode]);

  return { screen, state, error, retry: useCallback(() => setAttempt((n) => n + 1), []), end: useCallback(() => stopRef.current(), []) };
}

/** Take-over only: the lease (polled), the tasks Done wakes, Done and Stop, and the automatic Done after a seen login. */
function useTakeover(open: boolean, identity: string | null, enabled: boolean) {
  const readStatus = useCockpitAction("browser.live.status");
  const readWaiting = useCockpitAction("browser.takeover.waiting");
  const sendDone = useCockpitAction("browser.takeover.done");
  const sendStop = useCockpitAction("browser.takeover.stop");
  const [phase, setPhase] = useState<TakeoverPhase>({ kind: "none" });
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [tasks, setTasks] = useState<WaitingTask[]>([]);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const seenLive = useRef(false);
  const over = useRef(false);
  const autoSent = useRef(false);
  const actions = useRef({ readStatus, readWaiting, sendDone, sendStop });
  actions.current = { readStatus, readWaiting, sendDone, sendStop };
  const active = open && enabled && identity !== null;

  const poll = useCallback(async (): Promise<TakeoverPhase> => {
    if (!identity) return { kind: "none" };
    const out = (await actions.current.readStatus({})) as { status?: { lease?: unknown } | null };
    const next = takeoverPhase(out?.status?.lease ?? null, identity);
    if (next.kind === "live") {
      seenLive.current = true;
      setSecondsLeft(next.secondsLeft);
    }
    setPhase(next);
    return next;
  }, [identity]);

  useEffect(() => {
    if (!active) return;
    seenLive.current = false;
    over.current = false;
    autoSent.current = false;
    setResult(null);
    setPhase({ kind: "none" });
    setSecondsLeft(null);
    let alive = true;
    const tick = () => void poll().catch(() => undefined);
    const loadTasks = () => void (actions.current.readWaiting({ identity }) as Promise<{ tasks: WaitingTask[] }>).then((r) => { if (alive) setTasks(Array.isArray(r?.tasks) ? r.tasks : []); }, () => undefined);
    tick();
    loadTasks();
    const a = setInterval(tick, STATUS_POLL_MS);
    const b = setInterval(loadTasks, WAITING_POLL_MS);
    const c = setInterval(() => setSecondsLeft((s) => (s === null ? s : Math.max(0, s - 1))), 1000);
    return () => { alive = false; clearInterval(a); clearInterval(b); clearInterval(c); };
  }, [active, identity, poll]);

  const finish = useCallback(async (kind: "done" | "stop") => {
    if (!identity || busy) return;
    setBusy(true);
    try {
      const r = (await (kind === "done" ? actions.current.sendDone : actions.current.sendStop)({ identity })) as { ok: boolean; message: string };
      setResult({ ok: kind === "done" ? r.ok === true : true, message: String(r.message ?? "") });
    } catch (err) {
      setResult({ ok: false, message: errorText(err) });
    } finally {
      setBusy(false);
    }
  }, [identity, busy]);

  // The daemon saw the logged-in page and ended the lease: send Done once, by itself.
  useEffect(() => {
    if (active && phase.kind === "logged_in" && seenLive.current && !autoSent.current && !result) {
      autoSent.current = true;
      void finish("done");
    }
  }, [active, phase, result, finish]);

  const stillLive = useCallback(async () => {
    try {
      return (await poll()).kind === "live";
    } catch {
      return false;
    }
  }, [poll]);

  return { phase, secondsLeft, tasks, result, busy, done: () => void finish("done"), stop: () => void finish("stop"), stillLive, seenLive, over };
}

/** The screen box keeps 16:10 and never grows past the viewport: wide as the panel allows, at most as tall as 90vh less the chrome. */
const SCREEN_STYLE = { aspectRatio: "16 / 10", minWidth: 0, overflow: "hidden", borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.secondary } as const;
const muted = { fontSize: 12.5, color: tokens.muted, overflowWrap: "anywhere", minWidth: 0 } as const;

function Notice({ tone, children }: { tone: "ok" | "bad" | "warn"; children: ReactNode }) {
  const t = tokens.tones[tone];
  return <div role={tone === "bad" ? "alert" : "status"} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.soft, color: t.fg, fontSize: 13, overflowWrap: "anywhere", minWidth: 0 }}>{children}</div>;
}

/** The take-over's status line, wake list and end notice. Pure, for the render tests. */
export function TakeoverPanel({ identity, phase, secondsLeft, tasks, result }: { identity: string; phase: TakeoverPhase; secondsLeft: number | null; tasks: readonly WaitingTask[]; result: { ok: boolean; message: string } | null }) {
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {result ? <Notice tone={result.ok ? "ok" : "bad"}>{result.message}</Notice> : null}
      {!result && phase.kind === "logged_in" ? <Notice tone="ok">Logged in. Checking the login and waking the tasks…</Notice> : null}
      {!result && phase.kind === "ended" ? <Notice tone="warn">Login finished, not confirmed: the take-over ended because {endWords(phase.reason)}. If you logged in, press {doneLabel(tasks)}. Nothing is woken until you press it.</Notice> : null}
      {!result && phase.kind === "other" ? <Notice tone="warn">Someone is taking over {phase.identity} right now. Only one take-over runs at a time.</Notice> : null}
      {!result && phase.kind === "live" && secondsLeft !== null ? <span style={muted}>{countdown(secondsLeft)} left. Log in to {identity} in the window, then press {doneLabel(tasks)}.</span> : null}
      {!result ? (
        tasks.length ? (
          <div style={muted}>
            Done wakes:{" "}
            {tasks.map((t, i) => (
              <span key={t.identifier}>{i ? ", " : ""}<strong style={{ color: tokens.fg }}>{t.identifier}</strong>{t.title ? ` ${t.title}` : ""}</span>
            ))}
          </div>
        ) : (
          <span style={muted}>No task is waiting for this login. Done checks the login and wakes nothing.</span>
        )
      ) : null}
    </div>
  );
}

export function BrowserLiveDrawer({ open, companyId, onClose, defaultExpanded = false, identity = null, mode = "view" }: {
  open: boolean;
  companyId: string;
  onClose: () => void;
  /** The login identity to watch (from the chip) or to take over; the ticket carries it. */
  identity?: string | null;
  /** Large from the start (take over). */
  defaultExpanded?: boolean;
  /** `control`: take over `identity` (keyboard and mouse). */
  mode?: LiveMode;
}) {
  const control = mode === "control" && identity !== null;
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (open) setExpanded(defaultExpanded);
  }, [open, defaultExpanded]);
  const takeover = useTakeover(open, identity, control);
  const { screen, state, error, retry, end } = useLiveScreen(companyId, open, expanded, identity, control ? "control" : "view", takeover);
  const over = takeoverOver(takeover.phase, takeover.result !== null, takeover.seenLive.current);
  if (control && over) takeover.over.current = true;
  useEffect(() => {
    if (control && over) end();
  }, [control, over, end]);
  const title = control ? `Take over: ${identity}` : "Watch live";
  const pill = control
    ? takeover.result
      ? { tone: takeover.result.ok ? "ok" : "bad", text: takeover.result.ok ? "Login works" : "Not logged in" }
      : takeover.phase.kind === "logged_in" && takeover.seenLive.current
        ? { tone: "ok", text: "Logged in" }
        : over
          ? { tone: "warn", text: LABELS.ended }
          : { tone: state === "live" ? "ok" : state === "error" ? "bad" : "warn", text: state === "live" ? "Live, you have the keyboard and mouse" : LABELS[state] }
    : { tone: state === "live" ? "ok" : state === "error" ? "bad" : "warn", text: LABELS[state] };
  const body = (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
        <Pill tone={pill.tone as "ok" | "bad" | "warn"} dot>{pill.text}</Pill>
        <span style={{ ...muted, flex: "1 1 160px" }}>{control ? (over ? "The take-over has ended: your keyboard and mouse no longer reach the server browser." : "Your typing and clicks go to the server browser. Paste works; nothing is copied back out. Agents' browser steps wait until this ends.") : "You can see the server browser. Typing and clicking do nothing."}</span>
        <Button type="button" variant="secondary" aria-pressed={expanded} onClick={() => setExpanded((v) => !v)}>{expanded ? "Shrink" : "Enlarge"}</Button>
      </div>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {control ? <TakeoverPanel identity={identity!} phase={shownPhase(takeover.phase, takeover.seenLive.current)} secondsLeft={takeover.secondsLeft} tasks={takeover.tasks} result={takeover.result} /> : null}
      {/* noVNC fills this box; its canvas is scaled to fit. View only takes no keyboard or mouse input. */}
      <div ref={screen} aria-label="Server browser screen" style={expanded ? { ...SCREEN_STYLE, width: "min(100%, calc((90vh - 300px) * 1.6))", justifySelf: "center" } : { ...SCREEN_STYLE, width: "100%" }} />
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
        <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {state === "error" && !over ? <Button type="button" variant="secondary" onClick={retry}>Try again</Button> : null}
          {control && !takeover.result ? <Button type="button" variant="secondary" disabled={takeover.busy} onClick={takeover.stop}>Stop</Button> : null}
          {control && !takeover.result ? <Button type="button" disabled={takeover.busy} onClick={takeover.done}>{takeover.busy ? "Checking the login…" : doneLabel(takeover.tasks)}</Button> : null}
        </div>
      </div>
    </div>
  );
  // Escape and a click outside shrink the large view first; a second Escape closes the drawer.
  if (expanded) return <Modal open={open} title={title} width={1400} onClose={() => setExpanded(false)}>{body}</Modal>;
  return <Sheet open={open} title={title} onClose={onClose}>{body}</Sheet>;
}
