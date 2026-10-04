/**
 * The extras (AI search, Google Analytics, page groups): each is off until a person turns it on. One list serves the
 * sprint's Integrations tab (this sprint), the SEO home (what new sprints start with) and the New sprint dialog (the
 * choices). Every row says in plain words what turning it on adds before anyone presses the button.
 */
import { useState } from "react";
import { Button, Pill, breakAnywhere, formatShortDate, tokens } from "@partnersinbiz/pib-plugin-ui";
import { small } from "./parts.js";
import type { SprintBundle, SwitchState } from "./types.js";

/** Whether a person switched an extra on for the sprint on this page (everything is off until then). */
export function extraOn(bundle: Pick<SprintBundle, "extras">, key: SwitchState["key"]): boolean {
  return Boolean(bundle.extras?.some((e) => e.key === key && e.enabled));
}

type Subject = "sprint" | "company";

const subjectWords: Record<Subject, { on: string; off: string }> = {
  sprint: { on: "Turn on for this sprint", off: "Turn off for this sprint" },
  company: { on: "Start new sprints with it on", off: "Start new sprints with it off" },
};

/** What a person reads before confirming: what it adds, what it needs, and what turning it off does. */
function ExtraDetails({ state }: { state: SwitchState }) {
  return (
    <details style={{ fontSize: 12.5, color: tokens.muted }}>
      <summary style={{ cursor: "pointer", minHeight: 24 }}>What exactly this does</summary>
      <div style={{ display: "grid", gap: 6, marginTop: 4, lineHeight: 1.5 }}>
        <span>{state.detail}</span>
        {state.needs ? <span><strong>Needs first:</strong> {state.needs}</span> : null}
        <span><strong>Turning it off:</strong> {state.off}</span>
      </div>
    </details>
  );
}

export function ExtrasList({ states, subject, serviceAccountReady, busy, onSet }: {
  states: SwitchState[];
  subject: Subject;
  /** Google Analytics cannot be turned on without the company's Google service account key. */
  serviceAccountReady: boolean;
  busy: string | null;
  onSet: (key: SwitchState["key"], enabled: boolean) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<SwitchState["key"] | null>(null);
  const words = subjectWords[subject];
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {states.map((state) => {
        const blocked = !state.enabled && state.key === "ga4" && !serviceAccountReady;
        const working = busy === state.key;
        return (
          <div key={state.key} style={{ display: "grid", gap: 6, minWidth: 0, paddingTop: 10, borderTop: `1px solid ${tokens.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 14 }}>{state.label}</strong>
              <Pill tone={state.enabled ? "ok" : "neutral"} dot>{state.enabled ? "On" : "Off"}</Pill>
            </div>
            <span style={{ fontSize: 13, ...breakAnywhere }}>{state.adds}</span>
            <ExtraDetails state={state} />
            {state.changedAt ? (
              <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>
                Turned {state.enabled ? "on" : "off"} {formatShortDate(state.changedAt)}{state.changedBy ? ` by ${state.changedBy}` : ""}.
              </span>
            ) : null}
            {blocked ? <span style={{ fontSize: 12.5, color: tokens.muted }}>It needs the Google service account key first (see Setup).</span> : null}
            {confirming === state.key ? (
              <div style={{ display: "grid", gap: 8, padding: 10, borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.secondary }}>
                <span style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {state.enabled ? state.off : state.adds}
                  {!state.enabled && state.needs ? ` ${state.needs}` : ""}
                </span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button
                    type="button"
                    style={small}
                    disabled={working}
                    onClick={() => void onSet(state.key, !state.enabled).finally(() => setConfirming(null))}
                  >
                    {working ? "Saving…" : state.enabled ? "Turn it off" : "Turn it on"}
                  </Button>
                  <Button type="button" variant="secondary" style={small} disabled={working} onClick={() => setConfirming(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div>
                <Button type="button" variant="secondary" style={small} disabled={blocked || busy !== null} onClick={() => setConfirming(state.key)}>
                  {state.enabled ? words.off : words.on}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The choices on the New sprint dialog: everything off unless the company default or the person says otherwise. */
export function ExtrasChoices({ states, chosen, onChange, serviceAccountReady }: {
  states: SwitchState[];
  chosen: Record<SwitchState["key"], boolean>;
  onChange: (key: SwitchState["key"], value: boolean) => void;
  serviceAccountReady: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {states.map((state) => {
        const blocked = state.key === "ga4" && !serviceAccountReady;
        return (
          <label key={state.key} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "start", fontSize: 13, opacity: blocked ? 0.6 : 1 }}>
            <input
              type="checkbox"
              checked={Boolean(chosen[state.key]) && !blocked}
              disabled={blocked}
              onChange={(e) => onChange(state.key, e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <strong>{state.label}</strong>
              <span style={{ color: tokens.muted, ...breakAnywhere }}>{state.adds}{blocked ? " Needs the Google service account key first (see Setup)." : ""}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
