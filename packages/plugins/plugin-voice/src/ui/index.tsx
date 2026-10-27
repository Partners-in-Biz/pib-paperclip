import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useHostContext, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
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
import { buildInstructions } from "./live-instructions.js";
import { LiveSession, type LiveSessionInfo, type LiveState, type TranscriptEntry } from "./live-session.js";
import type { ApiClient } from "./live-tools.js";
import { failureMessage, showSaveNotice } from "./save-notice.js";
import { hasSpeech, saveLiveTranscript, type CallRecord, type ReportApi, type SaveTarget } from "./transcript-report.js";
import { blobToBase64, formatElapsed, startRecording, voiceSupported, type ActiveRecording } from "./recorder.js";

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

/** Puts the call on the task it was opened from and on every task it posted to or created. */
async function saveCall(call: CallRecord, touched: SaveTarget[], pageIssueRef: string | null): Promise<void> {
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
  const transcribe = usePluginAction("transcribe");
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

const STATE_LABEL: Record<LiveState, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  ended: "Call ended",
  error: "Disconnected",
};

/** Must run synchronously inside the tap, or iOS keeps the audio silent. */
function createAudioContext(): AudioContext {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Ctor();
  void context.resume();
  return context;
}

function LivePanel({
  companyId,
  userId,
  audioContext,
  onClose,
}: {
  companyId: string;
  userId: string | null;
  audioContext: AudioContext;
  onClose: () => void;
}) {
  const startLive = usePluginAction("live-session");
  const [state, setState] = useState<LiveState>("connecting");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState({ mic: 0, voice: 0 });
  const session = useRef<LiveSession | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pageIssueRef = issueRefFromPath(window.location.pathname);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = (await startLive({})) as LiveSessionInfo;
        let companyName: string | null = null;
        try {
          companyName = (await paperclipApi.get<{ name?: string }>(`/companies/${companyId}`)).name ?? null;
        } catch {
          // The name only flavours the prompt.
        }
        if (cancelled) return;
        const live = new LiveSession({
          info,
          instructions: buildInstructions({ personName: null, companyName, pageIssueRef, now: new Date() }),
          api: paperclipApi,
          companyId,
          userId,
          pageIssueRef,
          audioContext,
          onState: setState,
          onTranscript: setEntries,
          onLevel: (mic, voice) => setLevels({ mic, voice }),
          onError: setError,
          onEnd: (call, touched) =>
            void saveCall(call, touched, pageIssueRef).catch((err) => {
              showSaveNotice(`The call transcript was not saved (${errorText(err)}).`, null);
            }),
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
      // stop() closes it once a session exists; close it here too if it never started.
      if (audioContext.state !== "closed") void audioContext.close().catch(() => undefined);
    };
    // Start once per panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [entries]);

  const hangUp = () => {
    session.current?.stop();
    onClose();
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

  const orbScale = 1 + Math.min(0.35, (state === "speaking" ? levels.voice : levels.mic) * 0.6);
  const live = state !== "ended" && state !== "error";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Live voice"
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px" }}>
        <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
          {pageIssueRef ? `Talking about ${pageIssueRef}` : "Live voice"}
        </span>
        <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>Grok voice</span>
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
            animation: state === "thinking" || state === "connecting" ? "pib-voice-pulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
        <div style={{ marginTop: 18, fontSize: 15, fontWeight: 500 }} aria-live="polite">
          {muted && live ? "Muted" : STATE_LABEL[state]}
        </div>
        {error ? (
          <div role="alert" style={{ marginTop: 8, fontSize: 13, color: "var(--destructive)", padding: "0 24px", textAlign: "center" }}>
            {error}
          </div>
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

export function VoiceOverlay() {
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
  const openLive = useCallback(() => {
    if (liveAudioRef.current) return;
    liveAudioRef.current = createAudioContext();
    setLiveAudio(liveAudioRef.current);
  }, []);
  const closeLive = useCallback(() => {
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
        <LivePanel companyId={companyId} userId={host.userId ?? null} audioContext={liveAudio} onClose={closeLive} />
      ) : null}
      {toast ? <Toast message={toast} /> : null}
    </>
  );
}
