import { useCallback, useMemo, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, PageMessage, tokens } from "@partnersinbiz/pib-plugin-ui";
import { Card } from "./components.js";
import { DeviceList } from "./DeviceList.js";
import {
  registerPushServiceWorker,
  subscriptionToPayload,
  urlBase64ToUint8Array,
  waitForActivated,
  PUSH_SW_URL,
} from "./push-register.js";
import type { DeviceInfo } from "../push/actions.js";

interface DeviceResponse {
  devices: DeviceInfo[];
}

interface SubscribeResponse {
  id: string;
  deviceLabel: string | null;
  state: string;
  createdAt: string;
}

interface TestResponse {
  results: Array<{
    label: string | null;
    outcome: "sent" | "skipped_muted" | "error";
    status?: string;
  }>;
}

export function NotificationsPage() {
  const devicesAction = usePluginAction("cockpit.push.devices");
  const publicKeyAction = usePluginAction("cockpit.push.publicKey");
  const subscribeAction = usePluginAction("cockpit.push.subscribe");
  const muteAction = usePluginAction("cockpit.push.mute");
  const unsubscribeAction = usePluginAction("cockpit.push.unsubscribe");
  const testAction = usePluginAction("cockpit.push.test");

  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const loadDevices = useCallback(async () => {
    try {
      setError(null);
      const res = (await devicesAction({})) as DeviceResponse;
      setDevices(res.devices || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [devicesAction]);

  // Load devices on mount
  useMemo(() => {
    loadDevices();
  }, [loadDevices]);

  const setErr = (msg: string) => {
    setError(msg);
    setBusy(false);
  };

  const handleTurnOn = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      // Request Notification permission FIRST, before any async operations
      if (typeof Notification === "undefined") {
        setErr("Notifications not supported in this browser");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setErr(`Permission denied: ${permission}`);
        return;
      }

      // Then register service worker
      if (!navigator?.serviceWorker) {
        setErr("Service Workers not available");
        return;
      }
      const registration = await registerPushServiceWorker(navigator.serviceWorker, PUSH_SW_URL);
      await waitForActivated(registration);

      // Subscribe to push
      if (!("pushManager" in registration)) {
        setErr("PushManager not available");
        return;
      }

      // Get public key from server
      const pubKeyRes = await publicKeyAction({});
      if (!pubKeyRes || typeof pubKeyRes !== "object" || !("publicKey" in pubKeyRes)) {
        setErr("Failed to get public key");
        return;
      }
      const publicKey = (pubKeyRes as { publicKey?: string }).publicKey;
      if (!publicKey) {
        setErr("No public key in response");
        return;
      }

      // Subscribe with push manager
      const subscription = await (registration as any).pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      // Get label from user agent
      const label = navigator.userAgent.slice(0, 60);
      const payload = subscriptionToPayload(subscription, label);

      // Register subscription with server (don't log keys)
      await subscribeAction(payload);

      // Reload devices
      await loadDevices();
      setMessage("✓ Notifications enabled on this device");
      setBusy(false);
    } catch (err) {
      setErr(err instanceof Error ? err.message : String(err));
    }
  };

  const handleMute = async (id: string, muted: boolean) => {
    setError(null);
    setLoading((prev) => ({ ...prev, [id]: true }));
    try {
      await muteAction({ id, muted });
      await loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handleRemove = async (id: string) => {
    setError(null);
    setLoading((prev) => ({ ...prev, [id]: true }));
    try {
      await unsubscribeAction({ id });
      await loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handleSendTest = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const res = (await testAction({})) as TestResponse;
      const results = res.results || [];
      if (results.length === 0) {
        setErr("No devices to test");
        return;
      }
      const outcomes = results.map((r) => `${r.label || "Device"}: ${r.outcome}${r.status ? ` (${r.status})` : ""}`).join(", ");
      setMessage(`✓ Test sent: ${outcomes}`);
      setBusy(false);
    } catch (err) {
      setErr(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card title="Notifications" subtitle="Manage push notifications on your devices">
        {(error || message) && (
          <div style={{ marginBottom: 12 }}>
            <PageMessage message={(error ?? message) as string} tone={error ? "bad" : "ok"} />
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <Button type="button" onClick={handleTurnOn} disabled={busy}>
            {busy ? "Loading…" : "Turn on notifications on this device"}
          </Button>
          {devices.length > 0 && (
            <Button type="button" variant="secondary" onClick={handleSendTest} disabled={busy}>
              {busy ? "Sending…" : "Send test"}
            </Button>
          )}
        </div>

        <DeviceList devices={devices} onMute={handleMute} onRemove={handleRemove} busy={busy} loading={loading} />
      </Card>
    </div>
  );
}
