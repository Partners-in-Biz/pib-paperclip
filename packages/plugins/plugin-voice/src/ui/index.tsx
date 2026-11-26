import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { AccessGate, useAccess } from "@partnersinbiz/pib-plugin-ui";
import { useAccessMe, useVoiceAction } from "./actions.js";
import {
  describeComposer,
  ensureMount,
  ensureTaskDialogMount,
  findComposers,
  findTaskDialogs,
  insertIntoEditable,
  issueRefFromPath,
  taskDialogEditable,
  trackFieldFocus,
} from "./composers.js";
import { keepFieldVisible } from "./keyboard.js";
import { buildInstructions } from "./live-instructions.js";
import { startWakeLock, type WakeGuard } from "./wake-lock.js";
import { agentForCall, agentRefFromPath, type AgentRow } from "./agent-chat.js";
import { DirectSession, type DirectState } from "./direct-session.js";
import { LiveSession, type LiveSessionInfo, type LiveState, type TranscriptEntry } from "./live-session.js";
import type { ApiClient } from "./agent-chat.js";
import { failureMessage, showSaveNotice } from "./save-notice.js";
import { hasSpeech, saveLiveTranscript, type CallRecord, type ReportApi, type SaveTarget } from "./transcript-report.js";
import { blobToBase64, formatElapsed, startRecording, voiceSupported, type ActiveRecording } from "./recorder.js";

interface AgentVoiceData {
  voices: { grok: string[] };
  company: { grokVoice: string };
  profile: { grokVoice?: string };
}

interface VoiceStatus {
  configured: boolean;
  liveEnabled: boolean;
  voiceNoteAutoSend: boolean;
}

/** Same-origin calls to Paperclip's API with the person's own session. */
export const paperclipApi: ReportApi = {
  async get<T>(path: string): Promise<T> {
    const res = await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Paperclip answered ${res.status} for ${path.split("?")[0]}`);
    return (await res.json()) as T;
  },
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`/api${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(typeof detail?.error === "string" ? detail.error : `Paperclip answered ${res.status}`);
    }
    return (await res.json()) as T;
  },
  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`/api${path}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(typeof detail?.error === "string" ? detail.error : `Paperclip answered ${res.status}`);
    }
    return (await res.json()) as T;
  },
};

/**
 * Autosaves and the final save write the same document key, and the host wants the latest revision id each
 * time, so they run one after another: a save started during a slow autosave would otherwise read a stale id.
 */
let saveQueue: Promise<unknown> = Promise.resolve();

function enqueueSave<T>(work: () => Promise<T>): Promise<T> {
  const run = saveQueue.then(work, work);
  saveQueue = run.catch(() => undefined);
  return run;
}

/** The mid-call write: the document on the task the call was opened from, never a comment. No task, no write. */
function autosaveCall(call: CallRecord, pageIssueRef: string | null): Promise<void> {
  if (!pageIssueRef || !hasSpeech(call.entries)) return Promise.resolve();
  return enqueueSave(async () => {
    const issue = await paperclipApi.get<{ id: string; identifier?: string | null }>(`/issues/${encodeURIComponent(pageIssueRef)}`);
    const result = await saveLiveTranscript(
      paperclipApi,
      call,
      [{ issueId: issue.id, ref: issue.identifier ?? pageIssueRef }],
      { comment: false, changeSummary: "Autosaved during a live voice chat" },
    );
    // Left for the final save, which shows the failure and offers Retry.
    if (result.failed.length > 0) throw new Error(result.failed[0]!.error);
  });
}

/** Puts the call on the task it was opened from and on every task it posted to or created. */
function saveCall(call: CallRecord, touched: SaveTarget[], pageIssueRef: string | null): Promise<void> {
  return enqueueSave(() => saveCallNow(call, touched, pageIssueRef));
}

async function saveCallNow(call: CallRecord, touched: SaveTarget[], pageIssueRef: string | null): Promise<void> {
  if (!hasSpeech(call.entries)) return;
  const targets = [...touched];
  if (pageIssueRef) {
    try {
      const issue = await paperclipApi.get<{ id: string; identifier?: string | null }>(`/issues/${encodeURIComponent(pageIssueRef)}`);
      targets.unshift({ issueId: issue.id, ref: issue.identifier ?? pageIssueRef });
    } catch {
      // The task on screen is optional; the tasks the call touched still get the transcript.
    }
  }
  if (targets.length === 0) return;
  const result = await saveLiveTranscript(paperclipApi, call, targets);
  if (result.failed.length === 0 && result.skipped === 0) return;
  const failedRefs = new Set(result.failed.map((f) => f.ref));
  const retryTargets = targets.filter((t) => failedRefs.has(t.ref));
  showSaveNotice(
    failureMessage(result),
    retryTargets.length > 0 ? async () => void (await saveCall(call, retryTargets, null)) : null,
  );
}

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "Something went wrong.";
}

// ---------------------------------------------------------------------------
// Icons (inline so the bundle needs no icon package)
// ---------------------------------------------------------------------------

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 19v3" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M4 10v4" />
      <path d="M8 6v12" />
      <path d="M12 3v18" />
      <path d="M16 7v10" />
      <path d="M20 10v4" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden style={{ animation: "pib-voice-spin 0.9s linear infinite" }}>
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

const KEYFRAMES = `
@keyframes pib-voice-spin { to { transform: rotate(360deg); } }
@keyframes pib-voice-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
`;

function useKeyframes() {
  useEffect(() => {
    if (document.getElementById("pib-voice-keyframes")) return;
    const style = document.createElement("style");
    style.id = "pib-voice-keyframes";
    style.textContent = KEYFRAMES;
    document.head.appendChild(style);
  }, []);
}

const iconButton: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 30,
  height: 30,
  borderRadius: 999,
  border: "none",
  background: "transparent",
  color: "var(--muted-foreground)",
  cursor: "pointer",
  padding: 0,
  flexShrink: 0,
};

// ---------------------------------------------------------------------------
// Composer buttons
// ---------------------------------------------------------------------------

type NoteState = "idle" | "recording" | "transcribing";

/** "composer": a chat box (mic + live). "task-dialog": the New task dialog (mic only, never sends). */
type MountKind = "composer" | "task-dialog";

/** Matches the dialog's own toolbar chips (Upload, Auto mode). */
const chipButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 32,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--muted-foreground)",
  fontSize: 12,
  cursor: "pointer",
  flexShrink: 0,
};

function ComposerButtons({
  root,
  kind,
  status,
  onLive,
  onToast,
}: {
  root: HTMLElement;
  kind: MountKind;
  status: VoiceStatus;
  onLive: (root: HTMLElement) => void;
  onToast: (message: string) => void;
}) {
  const transcribe = useVoiceAction("transcribe");
  const [state, setState] = useState<NoteState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recording = useRef<ActiveRecording | null>(null);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => {
      if (recording.current) setElapsed(Date.now() - recording.current.startedAt);
    }, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => () => recording.current?.cancel(), []);

  const finish = useCallback(async () => {
    const active = recording.current;
    recording.current = null;
    if (!active) return;
    setState("transcribing");
    try {
      const result = await active.stop();
      if (result.durationMs < 600) {
        onToast("That was too short to hear anything.");
        return;
      }
      const audio = await blobToBase64(result.blob);
      const out = (await transcribe({ audio, mimeType: result.mimeType })) as { text?: string; autoSend?: boolean };
      const text = (out.text ?? "").trim();
      if (!text) {
        onToast("No speech was heard in that note.");
        return;
      }
      if (kind === "task-dialog") {
        const field = taskDialogEditable(root);
        if (!field || !insertIntoEditable(field, text)) onToast("Could not place the text in the task.");
        return;
      }
      const target = describeComposer(root);
      if (!target.editable || !insertIntoEditable(target.editable, text)) {
        onToast("Could not place the text in the chat box.");
        return;
      }
      if (out.autoSend && target.sendButton && !target.sendButton.disabled) {
        // Let the host's state catch up with the inserted text before sending.
        window.setTimeout(() => describeComposer(root).sendButton?.click(), 150);
      }
    } catch (err) {
      onToast(errorText(err));
    } finally {
      setState("idle");
      setElapsed(0);
    }
  }, [kind, onToast, root, transcribe]);

  const toggle = useCallback(async () => {
    if (state === "transcribing") return;
    if (state === "recording") {
      await finish();
      return;
    }
    try {
      recording.current = await startRecording(() => void finish());
      setElapsed(0);
      setState("recording");
    } catch {
      onToast("Microphone access was blocked. Allow the mic for this site and try again.");
    }
  }, [finish, onToast, state]);

  const cancel = useCallback(() => {
    recording.current?.cancel();
    recording.current = null;
    setState("idle");
    setElapsed(0);
  }, []);

  return (
    <>
      {state === "recording" ? (
        <>
          <button type="button" onClick={cancel} aria-label="Discard voice note" title="Discard" style={{ ...iconButton, width: 26, fontSize: 16 }}>
            ×
          </button>
          <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--destructive)", minWidth: 32, textAlign: "right" }}>
            {formatElapsed(elapsed)}
          </span>
        </>
      ) : null}
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={state === "transcribing"}
        aria-label={state === "recording" ? "Stop and transcribe" : "Record a voice note"}
        title={state === "recording" ? "Stop and transcribe" : "Voice note"}
        data-pib-voice="mic"
        style={{
          ...(kind === "task-dialog" ? chipButton : iconButton),
          color: state === "recording" ? "var(--destructive)" : iconButton.color,
          animation: state === "recording" ? "pib-voice-pulse 1.2s ease-in-out infinite" : undefined,
        }}
      >
        {state === "transcribing" ? <Spinner /> : <MicIcon />}
        {kind === "task-dialog" ? <span>{state === "recording" ? "Stop" : state === "transcribing" ? "Writing…" : "Voice"}</span> : null}
      </button>
      {kind === "composer" && status.liveEnabled && state === "idle" ? (
        <button
          type="button"
          onClick={() => onLive(root)}
          aria-label="Talk live with your agents"
          title="Live voice"
          data-pib-voice="live"
          style={{ ...iconButton, background: "var(--foreground)", color: "var(--background)" }}
        >
          <WaveIcon />
        </button>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Live panel
// ---------------------------------------------------------------------------

type PanelState = LiveState | DirectState;
type ModeChoice = "direct-gemini" | "direct-grok" | "classic";

const STATE_LABEL: Record<PanelState, string> = {
  connecting: "Connecting…",
  starting: "Starting…",
  listening: "Listening",
  hearing: "Hearing you",
  sending: "Sending…",
  working: "Working…",
  thinking: "Thinking…",
  speaking: "Speaking",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  ended: "Call ended",
  error: "Disconnected",
};

const PULSING = new Set<PanelState>(["thinking", "connecting", "reconnecting", "starting", "sending", "working"]);

interface VoiceModeAnswer {
  mode?: unknown;
  provider?: unknown;
  geminiConfigured?: unknown;
}

/** The saved mode as the select shows it; nothing readable means Direct – Grok. */
function choiceFrom(answer: VoiceModeAnswer | null): ModeChoice {
  if (answer?.mode === "classic") return "classic";
  return answer?.mode === "direct" && answer.provider === "gemini" ? "direct-gemini" : "direct-grok";
}

const INTERRUPT_KEY = "pib-voice:interrupt-by-talking";

function readInterrupt(): boolean {
  try {
    return localStorage.getItem(INTERRUPT_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Must run synchronously inside the tap, or iOS keeps the audio silent. */
function createAudioContext(): AudioContext {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Ctor();
  void context.resume();
  return context;
}

/** Picks the Grok voice one agent speaks with. It applies to the next call; "Company default" clears it. */
function AgentVoicePicker({ companyId, agent }: { companyId: string; agent: { id: string; name: string } }) {
  const { data, refresh } = usePluginData<AgentVoiceData>("agent-voice", { companyId, agentId: agent.id });
  const save = useVoiceAction("set-agent-voice");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted-foreground)", minWidth: 0, maxWidth: "100%" }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.name} voice</span>
      <select
        aria-label={`Voice for ${agent.name}, used on the next call`}
        value={data.profile.grokVoice ?? ""}
        disabled={busy}
        onChange={async (event) => {
          setBusy(true);
          setErr(null);
          try {
            await save({ agentId: agent.id, voice: event.target.value || null });
            refresh();
          } catch (e) {
            setErr(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
        style={{ minHeight: 36, minWidth: 0, maxWidth: "100%", padding: "0 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--background)", color: "var(--foreground)", fontSize: 13 }}
      >
        <option value="">Company default ({data.company.grokVoice})</option>
        {data.voices.grok.map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
      {err ? <span role="alert" style={{ color: "var(--destructive)" }}>{err}</span> : null}
    </label>
  );
}

/** Exported for the offline render harness (visual QA); the overlay is the only real mount. */
export function LivePanel({
  companyId,
  userId,
  audioContext,
  wakeLock,
  wakeNotice,
  onClose,
  onSwitch,
}: {
  companyId: string;
  userId: string | null;
  audioContext: AudioContext;
  wakeLock: WakeGuard | null;
  wakeNotice: string | null;
  onClose: () => void;
  /** Runs inside the select's change: a fresh audio context (and screen lock) for the next session. */
  onSwitch: () => void;
}) {
  const startLive = useVoiceAction("live-session");
  const getMode = useVoiceAction("get-my-voice-mode");
  const saveMode = useVoiceAction("set-my-voice-mode");
  const speak = useVoiceAction("speak");
  const transcribe = useVoiceAction("transcribe");
  const [callAgent, setCallAgent] = useState<{ id: string; name: string } | null>(null);
  const [choice, setChoice] = useState<ModeChoice | null>(null);
  const [geminiReady, setGeminiReady] = useState(false);
  const [state, setState] = useState<PanelState>("connecting");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState({ mic: 0, voice: 0 });
  const [interrupt, setInterrupt] = useState(readInterrupt);
  const interruptRef = useRef(interrupt);
  interruptRef.current = interrupt;
  const agentIdRef = useRef<string | null>(null);
  const session = useRef<LiveSession | DirectSession | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pageIssueRef = issueRefFromPath(window.location.pathname);

  // Who the call is with (it decides the voice) and how this person talks. Either lookup may fail: company voice, Direct – Grok.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [agent, mode] = await Promise.all([
        paperclipApi
          .get<AgentRow[]>(`/companies/${companyId}/agents`)
          .then((agents) => agentForCall(agents, agentRefFromPath(window.location.pathname)))
          .catch(() => null),
        (getMode({}) as Promise<VoiceModeAnswer>).catch(() => null),
      ]);
      if (cancelled) return;
      if (agent) {
        agentIdRef.current = agent.id;
        setCallAgent({ id: agent.id, name: agent.name });
      }
      setGeminiReady(mode?.geminiConfigured === true);
      setChoice(choiceFrom(mode));
    })();
    return () => {
      cancelled = true;
    };
    // Once per panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One session per mode; a mode change stops this one (its transcript is saved) and starts the next.
  useEffect(() => {
    if (!choice) return;
    let cancelled = false;
    setEntries([]);
    setError(null);
    setNotice(null);
    setMuted(false);
    setState(choice === "classic" ? "connecting" : "starting");
    const agentRef = agentRefFromPath(window.location.pathname);
    const shared = {
      api: paperclipApi,
      companyId,
      pageIssueRef,
      agentRef,
      audioContext,
      wakeLock: wakeLock ?? undefined,
      onState: (next: PanelState) => {
        setState(next);
        // The banner belongs to the outage; a recovered call clears it.
        if (next !== "disconnected" && next !== "error") setError(null);
      },
      onTranscript: setEntries,
      onLevel: (mic: number, voice: number) => setLevels({ mic, voice }),
      onError: setError,
      onAutosave: (call: CallRecord) => autosaveCall(call, pageIssueRef),
      onEnd: (call: CallRecord, touched: SaveTarget[]) =>
        void saveCall(call, touched, pageIssueRef).catch((err) => {
          showSaveNotice(`The call transcript was not saved (${errorText(err)}).`, null);
        }),
    };
    void (async () => {
      try {
        if (choice !== "classic") {
          const direct = new DirectSession({
            ...shared,
            provider: choice === "direct-gemini" ? "gemini" : "grok",
            speak: (params) => speak(params),
            transcribe: (params) => transcribe(params),
            interruptByTalking: () => interruptRef.current,
            onNotice: setNotice,
          });
          session.current = direct;
          await direct.start();
          return;
        }
        const agentId = agentIdRef.current;
        const info = (await startLive({ agentId })) as LiveSessionInfo;
        let companyName: string | null = null;
        try {
          companyName = (await paperclipApi.get<{ name?: string }>(`/companies/${companyId}`)).name ?? null;
        } catch {
          // The name only flavours the prompt.
        }
        if (cancelled) return;
        const live = new LiveSession({
          ...shared,
          info,
          instructions: buildInstructions({ personName: null, companyName, pageIssueRef, now: new Date() }),
          userId,
          refreshInfo: () => startLive({ agentId }) as Promise<LiveSessionInfo>,
        });
        session.current = live;
        await live.start();
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err));
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      session.current?.stop();
      session.current = null;
      wakeLock?.release();
      // stop() closes it once a session exists; close it here too if it never started.
      if (audioContext.state !== "closed") void audioContext.close().catch(() => undefined);
    };
    // A new session only when the mode (and with it the audio context) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, audioContext]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [entries]);

  const hangUp = () => {
    session.current?.stop();
    onClose();
  };

  const chooseMode = (next: ModeChoice) => {
    if (next === choice || (next === "direct-gemini" && !geminiReady)) return;
    onSwitch();
    setChoice(next);
    const saved = next === "classic" ? { mode: "classic" } : { mode: "direct", provider: next === "direct-gemini" ? "gemini" : "grok" };
    void saveMode(saved).catch((err: unknown) => setNotice(`Mode not saved: ${errorText(err)}`));
  };

  const toggleInterrupt = (on: boolean) => {
    setInterrupt(on);
    try {
      localStorage.setItem(INTERRUPT_KEY, on ? "on" : "off");
    } catch {
      // Storage blocked: the choice lasts this call only.
    }
  };

  // Escape hangs up; focus goes back to where it was when the panel closes.
  const hangUpRef = useRef(hangUp);
  hangUpRef.current = hangUp;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        hangUpRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const direct = choice !== null && choice !== "classic";
  const orbScale = 1 + Math.min(0.35, (state === "speaking" ? levels.voice : levels.mic) * 0.6);
  const live = state !== "ended" && state !== "error";
  const agentName = callAgent?.name ?? "The agent";
  const label = muted && live ? "Muted" : state === "working" ? `${agentName} is working…` : STATE_LABEL[state];
  // Tap barge-in: anywhere on the panel except its controls.
  const onPanelTap = (event: { target: EventTarget | null }) => {
    if (!direct || state !== "speaking") return;
    if (event.target instanceof Element && event.target.closest("button, select, input, label, a")) return;
    const current = session.current;
    if (current instanceof DirectSession) current.interrupt();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Live voice"
      onPointerDown={onPanelTap}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        background: "var(--background)",
        color: "var(--foreground)",
        display: "flex",
        flexDirection: "column",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "12px 16px" }}>
        <div style={{ minWidth: 0, flex: "1 1 180px" }}>
          <div
            data-pib-voice="talking-with"
            title={callAgent ? `Talking with ${callAgent.name}` : undefined}
            style={{ fontSize: 15, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {callAgent ? `Talking with ${callAgent.name}` : "Live voice"}
          </div>
          {pageIssueRef ? <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>About {pageIssueRef}</div> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, minWidth: 0, maxWidth: "100%" }}>
          <select
            aria-label="Voice mode"
            data-pib-voice="mode"
            value={choice ?? ""}
            disabled={!choice}
            onChange={(event) => chooseMode(event.target.value as ModeChoice)}
            style={{ minHeight: 36, minWidth: 0, maxWidth: "100%", padding: "0 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--background)", color: "var(--foreground)", fontSize: 13 }}
          >
            {choice === null ? <option value="">Loading…</option> : null}
            <option value="direct-gemini" disabled={!geminiReady}>
              {geminiReady ? "Direct – Gemini" : "Direct – Gemini (needs a Gemini key)"}
            </option>
            <option value="direct-grok">Direct – Grok</option>
            <option value="classic">Grok live (classic)</option>
          </select>
          {callAgent && choice !== "direct-gemini" ? <AgentVoicePicker companyId={companyId} agent={callAgent} /> : null}
        </div>
      </div>

      <div style={{ flex: "0 0 auto", display: "grid", placeItems: "center", padding: "24px 0 8px" }}>
        <div
          aria-hidden
          style={{
            width: 132,
            height: 132,
            borderRadius: "50%",
            background: state === "speaking" ? "var(--foreground)" : "var(--accent)",
            border: "1px solid var(--border)",
            transform: `scale(${orbScale})`,
            transition: "transform 90ms linear, background 200ms ease",
            animation: PULSING.has(state) ? "pib-voice-pulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
        <div style={{ marginTop: 18, fontSize: 15, fontWeight: 500, padding: "0 24px", textAlign: "center", overflowWrap: "anywhere" }} aria-live="polite">
          {label}
        </div>
        {direct && state === "speaking" ? (
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--muted-foreground)" }}>Tap anywhere to stop</div>
        ) : null}
        {notice && live ? (
          <div role="status" style={{ marginTop: 8, fontSize: 12, color: "var(--muted-foreground)", padding: "0 24px", textAlign: "center" }}>
            {notice}
          </div>
        ) : null}
        {wakeNotice && live ? (
          <div role="status" style={{ marginTop: 8, fontSize: 12, color: "var(--muted-foreground)", padding: "0 24px", textAlign: "center" }}>
            {wakeNotice}
          </div>
        ) : null}
        {error ? (
          <div role="alert" style={{ marginTop: 8, fontSize: 13, color: "var(--destructive)", padding: "0 24px", textAlign: "center" }}>
            {error}
          </div>
        ) : null}
        {direct && live ? (
          <label style={{ marginTop: 10, display: "inline-flex", alignItems: "center", gap: 8, minHeight: 36, fontSize: 13, color: "var(--muted-foreground)" }}>
            <input type="checkbox" checked={interrupt} onChange={(event) => toggleInterrupt(event.target.checked)} />
            Interrupt by talking
          </label>
        ) : null}
        {state === "disconnected" ? (
          <button
            type="button"
            onClick={() => {
              const current = session.current;
              if (current instanceof LiveSession) current.retry();
            }}
            style={{ marginTop: 12, padding: "10px 20px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--accent)", color: "var(--foreground)", fontSize: 14, fontWeight: 500 }}
          >
            Retry
          </button>
        ) : null}
      </div>

      <div ref={scroller} style={{ flex: "1 1 auto", overflowY: "auto", padding: "8px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {entries.map((entry) =>
          entry.who === "note" ? (
            <div key={entry.id} style={{ alignSelf: "center", fontSize: 12, color: "var(--muted-foreground)" }}>
              {entry.text}
            </div>
          ) : (
            <div
              key={entry.id}
              style={{
                alignSelf: entry.who === "you" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                fontSize: 14,
                lineHeight: 1.45,
                padding: "8px 12px",
                borderRadius: 14,
                background: entry.who === "you" ? "var(--accent)" : "transparent",
                border: entry.who === "you" ? "none" : "1px solid var(--border)",
                opacity: entry.final ? 1 : 0.7,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {entry.text}
            </div>
          ),
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 24, padding: "16px 16px 24px" }}>
        {live ? (
          <button
            type="button"
            onClick={() => {
              const next = !muted;
              session.current?.setMuted(next);
              setMuted(next);
            }}
            aria-label={muted ? "Unmute" : "Mute"}
            style={{ ...iconButton, width: 60, height: 60, border: "1px solid var(--border)", color: muted ? "var(--destructive)" : "var(--foreground)" }}
          >
            <MicIcon />
          </button>
        ) : null}
        <button
          type="button"
          onClick={hangUp}
          aria-label={live ? "End call" : "Close"}
          style={{ ...iconButton, width: 60, height: 60, background: live ? "var(--destructive)" : "var(--accent)", color: live ? "var(--background)" : "var(--foreground)", fontSize: 22 }}
        >
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Overlay: one mount for the whole app shell
// ---------------------------------------------------------------------------

function Toast({ message }: { message: string }) {
  return createPortal(
    <div
      role="status"
      style={{
        position: "fixed",
        left: "50%",
        bottom: "calc(24px + env(safe-area-inset-bottom))",
        transform: "translateX(-50%)",
        zIndex: 2147483001,
        maxWidth: "min(92vw, 420px)",
        padding: "10px 14px",
        borderRadius: 10,
        background: "var(--foreground)",
        color: "var(--background)",
        fontSize: 13,
        boxShadow: "0 6px 24px rgb(0 0 0 / 0.2)",
      }}
    >
      {message}
    </div>,
    document.body,
  );
}

/**
 * The app-shell mount. It asks `access.me` first (access stage A, spec 4.6): closed or still loading, there is no mic
 * and no waveform in any chat box (the guard still refuses every call behind it).
 */
export function VoiceOverlay() {
  const host = useHostContext();
  const access = useAccess(useAccessMe(), host.companyId);
  // Phone keyboard: scroll the focused field above it (works on every page, configured or not, open or closed).
  useEffect(() => keepFieldVisible(document), []);
  return (
    <AccessGate state={access} kind="widget">
      <VoiceButtons />
    </AccessGate>
  );
}

function VoiceButtons() {
  useKeyframes();
  const host = useHostContext();
  const companyId = host.companyId;
  const { data } = usePluginData<VoiceStatus>("status", companyId ? { companyId } : {});
  const [roots, setRoots] = useState<Array<{ root: HTMLElement; kind: MountKind }>>([]);
  const [liveAudio, setLiveAudio] = useState<AudioContext | null>(null);
  const keys = useRef(new WeakMap<HTMLElement, string>());
  const nextKey = useRef(0);
  const [toast, setToast] = useState<string | null>(null);
  const supported = voiceSupported();
  const enabled = supported && !!companyId && !!data?.configured;

  // Follow the page: composers and the New task dialog come and go as the person navigates.
  useEffect(() => {
    if (!enabled) {
      setRoots([]);
      return;
    }
    let frame = 0;
    const scan = () => {
      frame = 0;
      const found = [
        ...findComposers(document).map((root) => ({ root, kind: "composer" as const })),
        ...findTaskDialogs(document).map((root) => ({ root, kind: "task-dialog" as const })),
      ];
      for (const { root, kind } of found) (kind === "composer" ? ensureMount : ensureTaskDialogMount)(root);
      setRoots((prev) =>
        prev.length === found.length && prev.every((r, i) => r.root === found[i]!.root && r.kind === found[i]!.kind) ? prev : found,
      );
    };
    const observer = new MutationObserver(() => {
      if (!frame) frame = window.requestAnimationFrame(scan);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const untrack = trackFieldFocus(document);
    scan();
    return () => {
      observer.disconnect();
      untrack();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = useCallback((message: string) => setToast(message), []);
  const liveAudioRef = useRef<AudioContext | null>(null);
  // Created right here in the tap handler (not in a state updater, which React runs later).
  const wakeRef = useRef<WakeGuard | null>(null);
  const [wakeNotice, setWakeNotice] = useState<string | null>(null);
  // The screen lock starts in the same tap, before any await: iOS refuses it outside a gesture.
  const openLive = useCallback(() => {
    if (liveAudioRef.current) return;
    liveAudioRef.current = createAudioContext();
    wakeRef.current = startWakeLock({ audioContext: liveAudioRef.current, onNotice: setWakeNotice });
    setLiveAudio(liveAudioRef.current);
  }, []);
  // A mode change in the panel: a new context in the same gesture, and a screen lock tied to it.
  const switchLive = useCallback(() => {
    wakeRef.current?.release();
    liveAudioRef.current = createAudioContext();
    wakeRef.current = startWakeLock({ audioContext: liveAudioRef.current, onNotice: setWakeNotice });
    setLiveAudio(liveAudioRef.current);
  }, []);
  const closeLive = useCallback(() => {
    wakeRef.current?.release();
    wakeRef.current = null;
    setWakeNotice(null);
    liveAudioRef.current = null;
    setLiveAudio(null);
  }, []);
  const keyFor = (root: HTMLElement) => {
    let key = keys.current.get(root);
    if (!key) {
      nextKey.current += 1;
      key = `pib-voice-${nextKey.current}`;
      keys.current.set(root, key);
    }
    return key;
  };

  if (!enabled || !data || !companyId) return null;

  return (
    <>
      {roots.map(({ root, kind }) => {
        const key = keyFor(root);
        return createPortal(
          <ComposerButtons root={root} kind={kind} status={data} onLive={openLive} onToast={showToast} />,
          kind === "composer" ? ensureMount(root) : ensureTaskDialogMount(root),
          key,
        );
      })}
      {liveAudio ? (
        <LivePanel companyId={companyId} userId={host.userId ?? null} audioContext={liveAudio} wakeLock={wakeRef.current} wakeNotice={wakeNotice} onClose={closeLive} onSwitch={switchLive} />
      ) : null}
      {toast ? <Toast message={toast} /> : null}
    </>
  );
}
