/**
 * Cockpit → Push: web push notification registration and test spike.
 */
import { useMemo, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, PageMessage, tokens } from "@partnersinbiz/pib-plugin-ui";
import { Card, Muted } from "./components.js";
import {
  describePushEnvironment,
  registerPushServiceWorker,
  subscriptionToPayload,
  urlBase64ToUint8Array,
} from "./push-register.js";

export function PushSpikePanel() {
  const publicKeyAction = usePluginAction("cockpit.pushSpike.publicKey");
  const subscribeAction = usePluginAction("cockpit.pushSpike.subscribe");
  const sendAction = usePluginAction("cockpit.pushSpike.send");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Compute environment once on mount
  const envDescription = useMemo(() => {
    if (typeof window === "undefined") return null;
    const hasPushManager =
      typeof navigator !== "undefined" &&
      typeof navigator.serviceWorker !== "undefined" &&
      typeof navigator.permissions !== "undefined";
    const hasServiceWorker =
      typeof navigator !== "undefined" &&
      typeof navigator.serviceWorker !== "undefined";
    const hasNotification = typeof Notification !== "undefined";
    const permission =
      typeof Notification !== "undefined" ? Notification.permission : undefined;

    return describePushEnvironment({
      self: typeof window !== "undefined" ? window.self : undefined,
      top: typeof window !== "undefined" ? window.top : undefined,
      hasPushManager,
      hasServiceWorker,
      hasNotification,
      permission,
    });
  }, []);

  const handleTurnOn = async () => {
    setError(null);
    setResult(null);
    setBusy(true);

    try {
      const publicKeyRes = await publicKeyAction({});
      if (
        !publicKeyRes ||
        typeof publicKeyRes !== "object" ||
        !("publicKey" in publicKeyRes) ||
        typeof (publicKeyRes as Record<string, unknown>).publicKey !== "string"
      ) {
        setError("No public key returned from action");
        setBusy(false);
        return;
      }

      const publicKey = (publicKeyRes as Record<string, unknown>).publicKey as string;

      if (typeof navigator === "undefined" || !navigator.serviceWorker) {
        setError("ServiceWorker API not available");
        setBusy(false);
        return;
      }

      await registerPushServiceWorker(navigator.serviceWorker);
      await navigator.serviceWorker.ready;

      if (typeof Notification === "undefined") {
        setError("Notification API not available");
        setBusy(false);
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError(`Notification permission: ${permission}`);
        setBusy(false);
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      if (!registration.pushManager) {
        setError("PushManager not available");
        setBusy(false);
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as any,
      });

      const payload = subscriptionToPayload(subscription, navigator.userAgent.slice(0, 60));
      await subscribeAction(payload);
      setResult("✓ Push notifications enabled");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleSendSpike = async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      await sendAction({});
      setResult("✓ Test push sent");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Push spike" subtitle="Test web push notifications">
      {envDescription && (
        <div style={{ padding: "10px 12px", borderRadius: 8, background: tokens.secondary, border: `1px solid ${tokens.border}`, marginTop: 8 }}>
          <div style={{ fontSize: 12, color: tokens.muted, fontWeight: 600 }}>
            Environment ({envDescription.frame}):
          </div>
          <ul style={{ margin: "6px 0 0 0", paddingLeft: 16, fontSize: 12, color: tokens.fg, lineHeight: 1.6 }}>
            {envDescription.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {(error || result) && (
        <div style={{ marginTop: 12 }}>
          <PageMessage message={error ?? result ?? undefined} tone={error ? "bad" : "ok"} />
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <Button type="button" onClick={handleTurnOn} disabled={busy}>
          {busy ? "Loading…" : "Turn on (spike)"}
        </Button>
        <Button type="button" variant="secondary" onClick={handleSendSpike} disabled={busy}>
          {busy ? "Loading…" : "Send spike push"}
        </Button>
      </div>
    </Card>
  );
}
