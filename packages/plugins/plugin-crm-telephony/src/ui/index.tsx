import { useCallback, useEffect, useRef, useState } from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  Input,
  Page,
  PageFrame,
  Form,
  Field,
  Pill,
  errorText,
} from "@partnersinbiz/pib-plugin-ui";
import { Call, Device } from "@twilio/voice-sdk";
import {
  parseDialerParams,
  normalizeDialInput,
  isDialable,
  formatCallDuration,
  friendlyDialError,
  isExpectedIncoming,
  phaseLabel,
  CALL_POLL_MS,
  INCOMING_WAIT_MS,
  type DialerPhase,
} from "./dialer.js";

interface TokenResult { token: string; identity: string; expiresAt: string }
interface DialResult { callSid: string; to: string; callerId: string; region: "ZA" | "US"; contactId: string | null; recording: boolean }
interface CallView {
  callSid: string; status: string; answeredAt: string | null; endedAt: string | null; durationSec: number | null; contactId: string | null;
}

const PHASE_TONE: Record<DialerPhase, "neutral" | "info" | "good" | "warn" | "bad"> = {
  idle: "neutral", preparing: "info", dialing: "info", ringing: "info", in_call: "good", ended: "neutral", error: "bad",
};

/**
 * Dialer page: places a real call through Twilio Voice.
 * Reads ?to= and ?contactId= from the URL. The worker asks Twilio to ring this
 * browser (a registered Device) and, once answered, to dial the contact from the
 * company's number; the page accepts that incoming leg and shows the call.
 */
export function DialerPage(_props: PluginPageProps) {
  const location = useHostLocation();
  const nav = useHostNavigation();
  const getToken = usePluginAction("voice-token");
  const dial = usePluginAction("voice-dial");
  const lookup = usePluginAction("voice-call");

  const [toNumber, setToNumber] = useState("");
  const [contactId, setContactId] = useState<string | undefined>();
  const [phase, setPhase] = useState<DialerPhase>("idle");
  const [rowStatus, setRowStatus] = useState<string | null>(null);
  const [callSid, setCallSid] = useState<string | null>(null);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<{ text: string; setup: boolean } | null>(null);

  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const expectedSidRef = useRef<string | null>(null);
  const answeredAtRef = useRef<number | null>(null);
  const phaseRef = useRef<DialerPhase>("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const incomingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPhaseBoth = (next: DialerPhase) => { phaseRef.current = next; setPhase(next); };

  useEffect(() => {
    const params = parseDialerParams(location.search);
    if (params.to) setToNumber(params.to);
    if (params.contactId) setContactId(params.contactId);
  }, [location.search]);

  const clearTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (incomingTimerRef.current) { clearTimeout(incomingTimerRef.current); incomingTimerRef.current = null; }
  }, []);

  // Tear the Device down with the page.
  useEffect(() => () => {
    clearTimers();
    try { callRef.current?.disconnect(); } catch { /* already gone */ }
    try { deviceRef.current?.destroy(); } catch { /* already gone */ }
    deviceRef.current = null;
  }, [clearTimers]);

  const fail = useCallback((raw: unknown) => {
    clearTimers();
    expectedSidRef.current = null;
    setError(friendlyDialError(errorText(raw)));
    setPhaseBoth("error");
  }, [clearTimers]);

  const applyView = useCallback((view: CallView | null) => {
    if (!view) return;
    setRowStatus(view.status);
    if (view.answeredAt && !answeredAtRef.current) {
      answeredAtRef.current = new Date(view.answeredAt).getTime();
      if (phaseRef.current === "ringing") setPhaseBoth("in_call");
    }
    if (view.endedAt && phaseRef.current !== "ended" && phaseRef.current !== "error") {
      finish();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pollOnce = useCallback(async () => {
    const sid = expectedSidRef.current ?? callSid;
    if (!sid) return;
    try {
      const view = (await lookup({ callSid: sid })) as CallView | null;
      applyView(view);
    } catch {
      // a missed poll is not an error; the SDK events still drive the call
    }
  }, [lookup, applyView, callSid]);

  const finish = useCallback(() => {
    if (phaseRef.current === "ended" || phaseRef.current === "error") return;
    clearTimers();
    expectedSidRef.current = null;
    callRef.current = null;
    setPhaseBoth("ended");
    // Twilio's final status callback can land a moment after the leg drops.
    setTimeout(() => { void pollOnce(); }, 1500);
    setTimeout(() => { void pollOnce(); }, 5000);
  }, [clearTimers, pollOnce]);

  const onIncoming = useCallback((call: Call) => {
    if (!isExpectedIncoming(call.parameters, expectedSidRef.current)) {
      call.reject();
      return;
    }
    if (incomingTimerRef.current) { clearTimeout(incomingTimerRef.current); incomingTimerRef.current = null; }
    callRef.current = call;
    call.on("disconnect", () => finish());
    call.on("cancel", () => finish());
    call.on("error", (err: unknown) => fail(err));
    call.accept();
  }, [finish, fail]);

  const ensureDevice = useCallback(async (): Promise<Device> => {
    const existing = deviceRef.current;
    if (existing && existing.state === Device.State.Registered) return existing;
    if (existing) { try { existing.destroy(); } catch { /* ignore */ } }

    const tok = (await getToken()) as TokenResult;
    const device = new Device(tok.token, {
      logLevel: "error",
      codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      closeProtection: true,
    });
    device.on("incoming", onIncoming);
    device.on("error", (err: unknown) => {
      if (phaseRef.current !== "idle" && phaseRef.current !== "ended") fail(err);
    });
    device.on("tokenWillExpire", async () => {
      try {
        const fresh = (await getToken()) as TokenResult;
        device.updateToken(fresh.token);
      } catch {
        // the next call fetches a new token anyway
      }
    });
    deviceRef.current = device;
    await device.register();
    return device;
  }, [getToken, onIncoming, fail]);

  const startCall = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const dialTo = normalizeDialInput(toNumber);
    if (!isDialable(dialTo)) return;
    if (phaseRef.current !== "idle" && phaseRef.current !== "ended" && phaseRef.current !== "error") return;

    setError(null);
    setRowStatus(null);
    setCallSid(null);
    setCallerId(null);
    setElapsed(0);
    answeredAtRef.current = null;
    setPhaseBoth("preparing");

    try {
      await ensureDevice();
      setPhaseBoth("dialing");
      const result = (await dial({ to: dialTo, contactId, origin: window.location.origin })) as DialResult;
      expectedSidRef.current = result.callSid;
      setCallSid(result.callSid);
      setCallerId(result.callerId);
      setRecording(result.recording);
      setRowStatus("initiated");
      setPhaseBoth("ringing");

      pollRef.current = setInterval(() => { void pollOnce(); }, CALL_POLL_MS);
      incomingTimerRef.current = setTimeout(() => {
        if (phaseRef.current === "ringing" && !callRef.current) {
          fail(new Error("Twilio accepted the call but did not reach this browser. Check that the page can use the microphone and that your user id is the Device identity, then try again."));
        }
      }, INCOMING_WAIT_MS);
    } catch (err) {
      fail(err);
    }
  };

  // Talk-time ticker once the contact answered.
  useEffect(() => {
    if (phase !== "in_call") return;
    const start = answeredAtRef.current ?? Date.now();
    if (!answeredAtRef.current) answeredAtRef.current = start;
    setElapsed(Math.floor((Date.now() - start) / 1000));
    tickRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => { if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; } };
  }, [phase]);

  const hangUp = () => {
    expectedSidRef.current = null;
    const call = callRef.current;
    if (call) {
      try { call.disconnect(); } catch { /* already gone */ }
    }
    // No incoming leg yet (Twilio still ringing the browser): the row ends when Twilio gives up.
    finish();
  };

  const busy = phase === "preparing" || phase === "dialing" || phase === "ringing" || phase === "in_call";
  const canCall = !busy && isDialable(normalizeDialInput(toNumber));
  const settingsLink = nav.linkProps("/telephony-settings");

  return (
    <PageFrame>
      <Page title="Dialer" description="Call a contact from the browser through the company's Twilio number">
        <div className="max-w-md mx-auto mt-8 p-6 bg-card rounded-lg border border-border" style={{ display: "grid", gap: 16 }}>
          <Form onSubmit={startCall}>
            <Field label="Phone number">
              <Input
                type="tel"
                value={toNumber}
                onChange={(e) => setToNumber(e.currentTarget.value)}
                placeholder="+27 82 123 4567"
                disabled={busy}
                aria-label="Phone number"
              />
            </Field>
            {contactId && (
              <Field label="Contact">
                <Input type="text" value={contactId} disabled aria-label="Contact id" />
              </Field>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
              {!busy && (
                <Button type="submit" disabled={!canCall}>{phase === "ended" || phase === "error" ? "Call again" : "Call"}</Button>
              )}
              {busy && (
                <Button type="button" onClick={hangUp} style={{ background: "#dc2626", color: "#fff", border: "1px solid transparent" }}>
                  Hang up
                </Button>
              )}
              <Pill tone={PHASE_TONE[phase]} dot={busy}>{phaseLabel(phase, rowStatus)}</Pill>
            </div>
          </Form>

          {(busy || phase === "ended") && (
            <div role="status" style={{ display: "grid", gap: 6, fontSize: 13, padding: "10px 12px", borderRadius: 10, background: "rgba(127,127,127,0.08)" }}>
              <div style={{ fontSize: 28, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {phase === "in_call" || (phase === "ended" && answeredAtRef.current) ? formatCallDuration(elapsed) : "—"}
              </div>
              {callerId && <div style={{ color: "#888" }}>From {callerId}{recording ? " · recording" : ""}</div>}
              {callSid && <div style={{ color: "#888", fontSize: 11, overflowWrap: "anywhere" }}>Call {callSid}</div>}
              {phase === "ended" && (
                <div style={{ color: "#888" }}>
                  {contactId || rowStatus ? "Logged on the contact's CRM timeline once Twilio confirms the call." : "No CRM contact owns this number, so nothing was logged."}
                </div>
              )}
            </div>
          )}

          {error && (
            <div role="alert" style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #dc2626", background: "rgba(220, 38, 38, 0.08)", color: "#b91c1c", fontSize: 13, overflowWrap: "anywhere" }}>
              {error.text}
              {error.setup && (
                <div style={{ marginTop: 6 }}>
                  <a {...settingsLink} style={{ color: "inherit", textDecoration: "underline" }}>Open Telephony settings</a>
                </div>
              )}
            </div>
          )}

          <p style={{ margin: 0, fontSize: 12, color: "#888" }}>
            Twilio rings this browser first, then dials the number from the company's caller ID. Allow the microphone when the browser asks.
          </p>
        </div>
      </Page>
    </PageFrame>
  );
}

export { TelephonySettingsPage } from "./settings-page.js";
