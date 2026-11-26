import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePluginData, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { useVoiceAction } from "./actions.js";
import { base64ToArrayBuffer, Player } from "./audio.js";

/** What the worker's `agent-voice` data answers (src/actions.ts `agentVoiceData`). */
interface AgentVoiceData {
  profile: { grokVoice?: string; geminiVoice?: string; geminiStyle?: string };
  company: { grokVoice: string; geminiVoice: string };
  geminiConfigured: boolean;
  voices: { grok: string[]; gemini: string[] };
}

type Provider = "grok" | "gemini";

interface SpeakAnswer {
  audio?: string;
  sampleRate?: number;
  error?: string;
}

const STYLE_MAX = 120;

const SPEAK_ERRORS: Record<string, string> = {
  not_configured: "That voice engine is not set up yet.",
  auth_failed: "The voice engine refused the key. Check it in Voice settings.",
  rate_limited: "The voice engine is busy. Try again in a moment.",
  timeout: "The voice engine took too long. Try again.",
  daily_limit: "The daily spoken-text limit is used up. Try again tomorrow.",
  provider_error: "The voice engine had a problem. Try again.",
};

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
}

function createAudioContext(): AudioContext {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Ctor();
  void context.resume();
  return context;
}

const page: CSSProperties = { display: "flex", flexDirection: "column", gap: 20, padding: 16, maxWidth: 560, minWidth: 0, boxSizing: "border-box" };
const section: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 };
const label: CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--foreground)" };
const hint: CSSProperties = { fontSize: 12, color: "var(--muted-foreground)", overflowWrap: "anywhere" };
const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 };
const field: CSSProperties = {
  minHeight: 36,
  minWidth: 0,
  flex: "1 1 12rem",
  maxWidth: "100%",
  padding: "0 8px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--background)",
  color: "var(--foreground)",
  fontSize: 13,
  boxSizing: "border-box",
};
const button: CSSProperties = {
  minHeight: 36,
  padding: "0 14px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--foreground)",
  fontSize: 13,
  cursor: "pointer",
  flexShrink: 0,
};

/**
 * The Voice tab on the agent page: the Grok voice this agent speaks with, and (once a Gemini key is set) its
 * Gemini voice and style line. Nothing here is core: the choice lives in plugin state on the agent, and Play
 * sample runs the same `speak` call a direct-mode reply does, so what you hear is what the agent will sound like.
 */
export function AgentVoiceTabBody({ context }: PluginDetailTabProps) {
  const agentId = context.entityId;
  const companyId = context.companyId ?? null;
  const { data, loading, error, refresh } = usePluginData<AgentVoiceData>("agent-voice", { companyId, agentId });
  const save = useVoiceAction("set-agent-voice-profile");
  const speak = useVoiceAction("speak");
  const [name, setName] = useState("");
  const [grok, setGrok] = useState("");
  const [gemini, setGemini] = useState("");
  const [style, setStyle] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<Provider | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  // The saved profile fills the form on load and again after every save.
  const profileKey = data ? JSON.stringify(data.profile) : "";
  useEffect(() => {
    if (!data) return;
    setGrok(data.profile.grokVoice ?? "");
    setGemini(data.profile.geminiVoice ?? "");
    setStyle(data.profile.geminiStyle ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the saved profile, not the data object
  }, [profileKey]);

  // The agent's name for the sample line and heading; the sample falls back to "your agent" if it cannot load.
  useEffect(() => {
    let alive = true;
    fetch(`/api/agents/${encodeURIComponent(agentId)}`, { credentials: "include", headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { name?: unknown } | null) => {
        if (alive && body && typeof body.name === "string") setName(body.name.trim());
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [agentId]);

  useEffect(
    () => () => {
      void audioRef.current?.close().catch(() => undefined);
    },
    [],
  );

  if (loading && !data) return <div style={page}><p style={hint}>Loading voice…</p></div>;
  if (!data) {
    return (
      <div style={page}>
        <p role="alert" style={{ ...hint, color: "var(--destructive)" }}>{error?.message ?? "Voice settings could not be loaded."}</p>
      </div>
    );
  }

  const saved = data.profile;
  const dirty =
    grok !== (saved.grokVoice ?? "") ||
    (data.geminiConfigured && (gemini !== (saved.geminiVoice ?? "") || style.trim() !== (saved.geminiStyle ?? "")));

  async function onSave() {
    setBusy(true);
    setNotice(null);
    try {
      // Gemini fields are sent only when Gemini is set up, so a saved Gemini choice is never wiped by this tab.
      const params: Record<string, unknown> = { agentId, grokVoice: grok || null };
      if (data?.geminiConfigured) {
        params.geminiVoice = gemini || null;
        params.geminiStyle = style.trim() || null;
      }
      await save(params);
      refresh();
      setNotice({ kind: "ok", text: "Saved. It applies from the next spoken reply." });
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function onPlay(provider: Provider) {
    setPlaying(provider);
    setNotice(null);
    try {
      const answer = (await speak({ agentId, provider, text: `Hi, I'm ${name || "your agent"}.` })) as SpeakAnswer | undefined;
      if (!answer || answer.error || !answer.audio) {
        setNotice({ kind: "error", text: SPEAK_ERRORS[answer?.error ?? ""] ?? "The sample could not be played." });
        return;
      }
      audioRef.current ??= createAudioContext();
      new Player(audioRef.current).enqueue(base64ToArrayBuffer(answer.audio));
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setPlaying(null);
    }
  }

  const playTitle = dirty ? "Save first: the sample plays the saved voice." : undefined;

  return (
    <div style={page}>
      <div style={section}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" }}>{name ? `${name}'s voice` : "Voice"}</h2>
        <p style={hint}>The voice this agent speaks with when you talk to it. A voice left on "Company default" uses the Voice settings.</p>
      </div>

      <div style={section}>
        <label htmlFor="agent-voice-grok" style={label}>Grok voice</label>
        <div style={row}>
          <select id="agent-voice-grok" value={grok} disabled={busy} onChange={(e) => setGrok(e.target.value)} style={field}>
            <option value="">Company default ({data.company.grokVoice})</option>
            {data.voices.grok.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <button type="button" style={button} disabled={busy || playing !== null || dirty} title={playTitle} onClick={() => void onPlay("grok")}>
            {playing === "grok" ? "Playing…" : "Play sample"}
          </button>
        </div>
      </div>

      {data.geminiConfigured ? (
        <div style={section}>
          <label htmlFor="agent-voice-gemini" style={label}>Gemini voice</label>
          <div style={row}>
            <select id="agent-voice-gemini" value={gemini} disabled={busy} onChange={(e) => setGemini(e.target.value)} style={field}>
              <option value="">Company default ({data.company.geminiVoice})</option>
              {data.voices.gemini.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            <button type="button" style={button} disabled={busy || playing !== null || dirty} title={playTitle} onClick={() => void onPlay("gemini")}>
              {playing === "gemini" ? "Playing…" : "Play sample"}
            </button>
          </div>
          <label htmlFor="agent-voice-style" style={label}>Style</label>
          <input
            id="agent-voice-style"
            type="text"
            value={style}
            maxLength={STYLE_MAX}
            disabled={busy}
            placeholder="e.g. calm and warm"
            onChange={(e) => setStyle(e.target.value)}
            style={{ ...field, flex: "none", width: "100%" }}
          />
          <p style={hint}>One short line on how the agent should sound. Up to {STYLE_MAX} characters.</p>
        </div>
      ) : (
        <p style={hint}>Gemini voices appear here once a Gemini key is set in Voice settings</p>
      )}

      <div style={row}>
        <button type="button" style={{ ...button, background: "var(--primary)", color: "var(--primary-foreground)", borderColor: "transparent" }} disabled={busy || !dirty} onClick={() => void onSave()}>
          {busy ? "Saving…" : "Save"}
        </button>
        {notice ? (
          <span role={notice.kind === "error" ? "alert" : "status"} style={{ ...hint, color: notice.kind === "error" ? "var(--destructive)" : "var(--muted-foreground)" }}>
            {notice.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
