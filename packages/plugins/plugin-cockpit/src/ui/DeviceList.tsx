import type { ReactNode } from "react";
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
  if (devices.length === 0) {
    return (
      <EmptyState
        title="No devices"
        description="Turn on notifications on this device to get started."
      />
    );
  }

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
                <div style={{ fontSize: 14, fontWeight: 600, color: tokens.fg, marginBottom: 4 }}>
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
              <div style={{ padding: "8px 0", fontSize: 12, color: tone("bad").fg, marginBottom: 8 }}>
                {device.lastError ? `Error: ${device.lastError}` : "Device needs to be re-registered."}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => onMute(device.id, !isMuted)}
                disabled={deviceBusy || busy}
              >
                {isMuted ? "Unmute" : "Mute"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => onRemove(device.id)}
                disabled={deviceBusy || busy}
              >
                Remove
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
