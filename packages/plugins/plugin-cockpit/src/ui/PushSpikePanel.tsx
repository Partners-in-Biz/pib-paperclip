import { useMemo, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, PageMessage, tokens } from "@partnersinbiz/pib-plugin-ui";
import { Card } from "./components.js";
import {
  describePushEnvironment,
  registerPushServiceWorker,
  subscriptionToPayload,
  urlBase64ToUint8Array,
  waitForActivated,
} from "./push-register.js";

export function PushSpikePanel() {
  const publicKeyAction = usePluginAction("cockpit.pushSpike.publicKey");
  const subscribeAction = usePluginAction("cockpit.pushSpike.subscribe");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const envDescription = useMemo(() => {
    if (typeof window === "undefined") return null;
    const hasPushManager = typeof window.PushManager !== "undefined";
    const hasServiceWorker = typeof navigator?.serviceWorker !== "undefined";
    const hasNotification = typeof Notification !== "undefined";
    const permission = typeof Notification !== "undefined" ? Notification.permission : undefined;
    return describePushEnvironment({ self: window.self, top: window.top, hasPushManager, hasServiceWorker, hasNotification, permission });
  }, []);

  const setErr = (msg: string) => { setError(msg); setBusy(false); };

  const handleTurnOn = async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const publicKeyRes = await publicKeyAction({});
      if (!publicKeyRes || typeof publicKeyRes !== "object" || !("publicKey" in publicKeyRes)) {
        setErr("No public key");
        return;
      }
      const publicKey = (publicKeyRes as Record<string, unknown>).publicKey as string;
      if (!navigator?.serviceWorker) {
        setErr("ServiceWorker not available");
        return;
      }
      const registration = await registerPushServiceWorker(navigator.serviceWorker);
      await waitForActivated(registration);
      if (typeof Notification === "undefined") {
        setErr("Notification not available");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setErr(`Permission: ${permission}`);
        return;
      }
      if (!("pushManager" in registration)) {
        setErr("PushManager not available");
        return;
      }
      const subscription = await (registration as any).pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      const payload = subscriptionToPayload(subscription, navigator.userAgent.slice(0, 60));
      await subscribeAction(payload);
      setResult("✓ Enabled");
      setBusy(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card title="Push spike" subtitle="Test web push notifications">
      {envDescription && (
        <div style={{ padding: "10px 12px", borderRadius: 8, background: tokens.secondary, border: `1px solid ${tokens.border}`, marginTop: 8 }}>
          <div style={{ fontSize: 12, color: tokens.muted, fontWeight: 600 }}>Environment ({envDescription.frame}):</div>
          <ul style={{ margin: "6px 0 0 0", paddingLeft: 16, fontSize: 12, color: tokens.fg, lineHeight: 1.6 }}>
            {envDescription.lines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      )}
      {(error || result) && <div style={{ marginTop: 12 }}><PageMessage message={(error ?? result) as string} tone={error ? "bad" : "ok"} /></div>}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <Button type="button" onClick={handleTurnOn} disabled={busy}>{busy ? "Loading…" : "Turn on"}</Button>
      </div>
    </Card>
  );
}
