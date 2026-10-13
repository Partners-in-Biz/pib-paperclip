import { useCallback, useReducer, useEffect, useState } from "react";
import {
  useHostLocation,
  usePluginAction,
  type PluginPageProps,
  type PluginActionFn,
} from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  Input,
  Page,
  PageFrame,
  Form,
  Field,
} from "@partnersinbiz/pib-plugin-ui";
import { parseDialerParams, formatDuration, isValidDtmf, softphoneReducer, initialSoftphoneState } from "./dialer.js";

/**
 * Dialer page: dial outbound calls with optional contact context.
 */
export function DialerPage({ context }: PluginPageProps) {
  const location = useHostLocation();
  const [toNumber, setToNumber] = useState("");
  const [contactId, setContactId] = useState<string | null>(null);

  useEffect(() => {
    const params = parseDialerParams(location.search);
    if (params.to) setToNumber(params.to);
    if (params.contactId) setContactId(params.contactId);
  }, [location.search]);

  const handleDial = useCallback(
    (number: string) => {
      if (!number.trim()) return;
      // This would call an action or emit an event to the softphone overlay.
      // For now, just log it until the backend voice-token action exists.
      console.log("Dial:", number, "contactId:", contactId);
    },
    [contactId]
  );

  return (
    <PageFrame>
      <Page title="Dialer" description="Initiate voice calls with contacts">
        <div className="max-w-md mx-auto mt-8 p-6 bg-card rounded-lg border border-border">
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              handleDial(toNumber);
            }}
          >
            <Field label="Phone number">
              <Input
                type="tel"
                value={toNumber}
                onChange={(e) => setToNumber(e.currentTarget.value)}
                placeholder="+1234567890"
              />
            </Field>
            {contactId && (
              <Field label="Contact ID">
                <Input type="text" value={contactId} disabled />
              </Field>
            )}
            <div className="flex gap-2 mt-6">
              <Button type="submit">
                Call
              </Button>
            </div>
          </Form>
        </div>
      </Page>
    </PageFrame>
  );
}

/**
 * Softphone overlay: persistent call control panel.
 * Owns the Twilio Device and survives navigation.
 */
export function SoftphoneOverlay({ context }: PluginPageProps) {
  const [softphoneState, dispatch] = useReducer(softphoneReducer, initialSoftphoneState);
  const [isTokenLoading, setIsTokenLoading] = useState(false);
  const [tokenReady, setTokenReady] = useState(false);
  const [dtmfInput, setDtmfInput] = useState("");

  // Attempt to get voice token from the plugin action.
  const voiceTokenAction: PluginActionFn | undefined = usePluginAction("voice-token");

  useEffect(() => {
    if (!voiceTokenAction) {
      setTokenReady(false);
      return;
    }

    const fetchToken = async () => {
      setIsTokenLoading(true);
      try {
        const result = await voiceTokenAction({});
        // Check if result has token property (type guard for response object)
        if (result && typeof result === "object" && "token" in result) {
          setTokenReady(true);
          // Token would be used to initialize Twilio Device here.
        }
      } catch (err) {
        console.error("Failed to get voice token:", err);
        dispatch({ type: "error", message: "Voice not available" });
      } finally {
        setIsTokenLoading(false);
      }
    };

    fetchToken();
  }, [voiceTokenAction]);

  // Timer tick for call duration
  useEffect(() => {
    if (softphoneState.status !== "connected") return;
    const interval = setInterval(() => {
      dispatch({ type: "tick" });
    }, 1000);
    return () => clearInterval(interval);
  }, [softphoneState.status]);

  const handleDtmf = useCallback(
    (digit: string) => {
      if (!isValidDtmf(digit)) return;
      setDtmfInput((prev) => prev + digit);
      // Send digit to Twilio Device (when available)
    },
    []
  );

  const handleHangup = useCallback(() => {
    dispatch({ type: "hangup" });
  }, []);

  const handleMute = useCallback(() => {
    dispatch({ type: softphoneState.isMuted ? "unmute" : "mute" });
  }, [softphoneState.isMuted]);

  // Only show softphone if voice is ready or in call
  if (!tokenReady && softphoneState.status === "idle") {
    return null;
  }

  return (
    <div
      className="fixed bottom-4 right-4 w-80 bg-card border border-border rounded-lg shadow-lg p-4"
      role="region"
      aria-label="Softphone"
      style={
        typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? {}
          : { transition: "all 200ms ease-out" }
      }
    >
      {/* Call status display */}
      <div className="mb-4">
        <div className="text-sm font-medium text-muted-foreground mb-1">
          {softphoneState.status === "idle" ? "Ready" : softphoneState.status.toUpperCase()}
        </div>
        {softphoneState.status === "connected" && (
          <div className="text-2xl font-mono font-bold">
            {formatDuration(softphoneState.durationSeconds)}
          </div>
        )}
        {softphoneState.currentNumber && softphoneState.status !== "idle" && (
          <div className="text-sm text-foreground mt-2">{softphoneState.currentNumber}</div>
        )}
        {softphoneState.error && (
          <div className="text-sm text-destructive mt-2">{softphoneState.error}</div>
        )}
      </div>

      {/* DTMF pad */}
      {softphoneState.status === "connected" && (
        <div className="mb-4">
          <div className="grid grid-cols-3 gap-1">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((digit) => (
              <Button
                key={digit}
                onClick={() => handleDtmf(digit)}
                className="text-center text-sm"
              >
                {digit}
              </Button>
            ))}
          </div>
          {dtmfInput && <div className="text-sm text-muted-foreground mt-2">{dtmfInput}</div>}
        </div>
      )}

      {/* Recording indicator */}
      {softphoneState.isRecording && (
        <div className="flex items-center gap-2 mb-4 text-destructive">
          <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" aria-hidden="true" />
          <span className="text-xs font-medium">Recording</span>
        </div>
      )}

      {/* Call controls */}
      <div className="flex gap-2">
        {softphoneState.status === "connected" && (
          <Button
            onClick={handleMute}
            className="flex-1"
          >
            {softphoneState.isMuted ? "Unmute" : "Mute"}
          </Button>
        )}
        {(softphoneState.status === "connected" ||
          softphoneState.status === "dialing" ||
          softphoneState.status === "ringing") && (
          <Button
            onClick={handleHangup}
            className={softphoneState.status === "connected" ? "flex-1" : ""}
          >
            Hangup
          </Button>
        )}
        {!tokenReady && !isTokenLoading && softphoneState.status === "idle" && (
          <div className="text-xs text-muted-foreground">Voice not available</div>
        )}
        {isTokenLoading && <div className="text-xs text-muted-foreground">Loading...</div>}
      </div>
    </div>
  );
}
