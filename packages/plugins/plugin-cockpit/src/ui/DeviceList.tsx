import { useState, type ReactNode } from "react";
import { Button, EmptyState, Pill, tokens, tone, formatDate } from "@partnersinbiz/pib-plugin-ui";
import { Card } from "./components.js";
import type { DeviceInfo } from "../push/actions.js";

export interface DeviceListProps {
  devices: DeviceInfo[];
  onMute: (id: string, muted: boolean) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  busy?: boolean;
  loading?: Record<string, boolean>;
}

const STATE_LABEL: Record<DeviceInfo["state"], string> = {
  ok: "On",
  muted: "Muted",
  needs_resubscribe: "Needs resubscribe",
};

const STATE_TONE: Record<DeviceInfo["state"], "ok" | "warn" | "bad"> = {
  ok: "ok",
  muted: "warn",
  needs_resubscribe: "bad",
};

export function DeviceList({ devices, onMute, onRemove, busy = false, loading = {} }: DeviceListProps) {
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  if (devices.length === 0) {
    return (
      <EmptyState
        title="No devices"
        description="Turn on notifications on this device to get started."
      />
    );
  }

  const confirmingDevice = confirmRemoveId ? devices.find((d) => d.id === confirmRemoveId) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {devices.map((device) => {
        const isMuted = device.state === "muted";
        const needsResubscribe = device.state === "needs_resubscribe";
        const deviceBusy = loading[device.id] ?? false;
        const stateColor = STATE_TONE[device.state];

        return (
          <div
            key={device.id}
            style={{
              padding: "12px",
              borderRadius: 8,
              border: `1px solid ${tokens.border}`,
              background: needsResubscribe ? tone("bad").soft : "transparent",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: tokens.fg, marginBottom: 4, overflowWrap: "anywhere" }}>
                  {device.label || "Unnamed device"}
                </div>
                <div style={{ fontSize: 12, color: tokens.muted, display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span>Added {formatDate(device.createdAt)}</span>
                  {device.lastOkAt && <span>Last push {formatDate(device.lastOkAt)}</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <Pill tone={stateColor}>{STATE_LABEL[device.state]}</Pill>
              </div>
            </div>

            {needsResubscribe && (
              <div style={{ padding: "8px 0", fontSize: 12, color: tone("bad").fg, marginBottom: 8, overflowWrap: "anywhere" }}>
                {device.lastError
                  ? `Error: ${device.lastError.length > 200 ? device.lastError.slice(0, 200) + "…" : device.lastError}`
                  : "Device needs to be re-registered."}
              </div>
            )}

            {confirmRemoveId === device.id && confirmingDevice ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "8px 0" }}>
                <div style={{ flex: 1, fontSize: 13, color: tokens.fg }}>
                  Remove {confirmingDevice.label || "Unnamed device"}?
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  style={{ minHeight: 44 }}
                  onClick={() => setConfirmRemoveId(null)}
                  disabled={deviceBusy || busy}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  style={{ minHeight: 44 }}
                  onClick={async () => {
                    await onRemove(device.id);
                    setConfirmRemoveId(null);
                  }}
                  disabled={deviceBusy || busy}
                >
                  Confirm Remove
                </Button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button
                  type="button"
                  variant="secondary"
                  style={{ minHeight: 44 }}
                  aria-label={`${isMuted ? "Unmute" : "Mute"} ${device.label || "Unnamed device"}`}
                  onClick={() => onMute(device.id, !isMuted)}
                  disabled={deviceBusy || busy}
                >
                  {isMuted ? "Unmute" : "Mute"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  style={{ minHeight: 44 }}
                  aria-label={`Remove ${device.label || "Unnamed device"}`}
                  onClick={() => setConfirmRemoveId(device.id)}
                  disabled={deviceBusy || busy}
                >
                  Remove
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
