import { tokens } from "@partnersinbiz/pib-plugin-ui";

/**
 * Reasons why a device may not receive push notifications.
 */
export type PushBlockReason = "ios_not_home_screen" | "permission_denied" | "unsupported_browser" | "key_changed";

/**
 * Human-readable explanations for why a device may not receive push notifications.
 */
export const PUSH_BLOCK_REASONS: Record<PushBlockReason, { title: string; body: string }> = {
  ios_not_home_screen: {
    title: "iPhone/iPad: app not on Home Screen",
    body: "On iPhone or iPad, notifications only work when the Paperclip app is added to your Home Screen and opened from there.",
  },
  permission_denied: {
    title: "Permission refused",
    body: "Allow notifications for this site in your browser or phone settings, then turn on notifications again.",
  },
  unsupported_browser: {
    title: "Unsupported browser",
    body: "Use Safari (iPhone, from Home Screen), Chrome, Edge or Firefox.",
  },
  key_changed: {
    title: "Notification key changed",
    body: "The notification key changed, so turn notifications on again on this device.",
  },
};

/**
 * Derive the block reason from the device environment and state.
 * Returns null if notifications should work.
 * Priority order: unsupported_browser, ios_not_home_screen, key_changed, permission_denied.
 */
export function blockReasonFor(env: {
  standalone: boolean;
  isIos: boolean;
  hasPush: boolean;
  permission: string;
  keyChanged?: boolean;
}): PushBlockReason | null {
  // Check for unsupported browser (no push support)
  if (!env.hasPush) {
    return "unsupported_browser";
  }

  // Check for iOS not on home screen
  if (env.isIos && !env.standalone) {
    return "ios_not_home_screen";
  }

  // Check for key changed
  if (env.keyChanged) {
    return "key_changed";
  }

  // Check for permission denied
  if (env.permission === "denied") {
    return "permission_denied";
  }

  // No block reason; notifications should work
  return null;
}

/**
 * PushHelp component that explains why notifications may not be working,
 * displays the quiet hours policy, and lists system limits.
 */
export function PushHelp({ reason }: { reason?: PushBlockReason | null }) {
  const reasons = Object.entries(PUSH_BLOCK_REASONS).map(([key, value]) => ({
    key: key as PushBlockReason,
    ...value,
  }));

  return (
    <div style={{ display: "grid", gap: 24, marginTop: 24 }}>
      {/* Why a device may not receive section */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: tokens.fg, marginBottom: 12 }}>
          Why a device may not receive
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {reasons.map((r) => (
            <div
              key={r.key}
              style={{
                padding: 12,
                borderRadius: 6,
                border: `1px solid ${tokens.border}`,
                background: r.key === reason ? tokens.secondary : "transparent",
              }}
              aria-current={r.key === reason ? "true" : undefined}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: tokens.fg, marginBottom: 4 }}>
                {r.title}
              </div>
              <div style={{ fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" }}>
                {r.body}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Limits section */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: tokens.fg, marginBottom: 12 }}>
          Limits
        </div>
        <div style={{ fontSize: 12, color: tokens.muted, overflowWrap: "anywhere", lineHeight: 1.5 }}>
          If Paperclip itself is down, nothing is sent from here. A separate dead-man email still tells
          you.
        </div>
      </div>

      {/* Quiet hours section */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: tokens.fg, marginBottom: 12 }}>
          Quiet hours
        </div>
        <div style={{ fontSize: 12, color: tokens.muted, overflowWrap: "anywhere", lineHeight: 1.5 }}>
          22:00–06:00. Urgent still comes through; the rest arrives at 06:00.
        </div>
      </div>
    </div>
  );
}
