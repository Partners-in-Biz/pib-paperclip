/**
 * Cockpit → Browser → "Watch live" (PAR-14514 design 4, stage S3): a drawer with the server browser's screen,
 * read-only. The ticket comes from `browser.live.ticket`, the socket is the plugin's websocket route, and the
 * screen is drawn by noVNC with `viewOnly`. noVNC is imported on open, so it is its own chunk (esbuild `splitting`)
 * and never loads with the other Cockpit pages.
 *
 * The host closes every socket after 5 minutes; the drawer then asks for a fresh ticket and connects again.
 * Errors are shown. The ticket is never logged and is dropped from state as soon as the socket is opened.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Pill, Sheet, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { PLUGIN_KEY } from "../constants.js";
import { useCockpitAction } from "./actions.js";

export type LiveState = "connecting" | "live" | "reconnecting" | "error";

/** Fails in a row, with no screen shown in between, before the drawer stops and says so. */
export const MAX_FAILED_CONNECTS = 3;
const RECONNECT_DELAY_MS = 1000;
/** A connection that lasts at least this long counts as good; a quicker drop counts as a failed attempt. */
export const STABLE_CONNECT_MS = 5000;

/** The route's address, relative to this page (`wss:` on https). The ticket is single use and lasts 30 seconds. */
export function liveSocketUrl(origin: { protocol: string; host: string }, companyId: string, ticket: string): string {
  const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${origin.host}/api/plugins/${encodeURIComponent(PLUGIN_KEY)}/api/browser/live?companyId=${encodeURIComponent(companyId)}&ticket=${encodeURIComponent(ticket)}`;
}

const LABELS: Record<LiveState, string> = { connecting: "Connecting…", live: "Live, view only", reconnecting: "Reconnecting…", error: "Not connected" };

function useWatchLive(companyId: string, open: boolean) {
  const getTicket = useCockpitAction("browser.live.ticket");
  const screen = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<LiveState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ticketAction = useRef(getTicket);
  ticketAction.current = getTicket;

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let rfb: { disconnect(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failed = 0;

    const fail = (message: string) => {
      if (stopped) return;
      stopped = true;
      setError(message);
      setState("error");
    };
    const retry = (reason: string) => {
      failed += 1;
      if (failed >= MAX_FAILED_CONNECTS) return fail(reason);
      setState("reconnecting");
      timer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
    };
    const connect = async () => {
      if (stopped || !screen.current) return;
      try {
        const [{ default: RFB }, ticket] = await Promise.all([import("@novnc/novnc"), ticketAction.current({ mode: "view" }) as Promise<{ ticket: string }>]);
        if (stopped || !screen.current) return;
        const connection = new RFB(screen.current, liveSocketUrl(window.location, companyId, ticket.ticket), {});
        connection.viewOnly = true;
        connection.scaleViewport = true;
        connection.background = "transparent";
        rfb = connection;
        let shown = false;
        let connectedAt = 0;
        connection.addEventListener("connect", () => {
          shown = true;
          connectedAt = Date.now();
          setError(null);
          setState("live");
        });
        connection.addEventListener("disconnect", () => {
          rfb = null;
          if (stopped) return;
          // After a screen was shown, the 5-minute end or a drop is expected: connect again with a fresh ticket.
          // A connect that drops again within STABLE_CONNECT_MS counts as a failed attempt, so a server that accepts and drops at once cannot loop forever.
          if (shown && Date.now() - connectedAt >= STABLE_CONNECT_MS) {
            failed = 0;
            setState("reconnecting");
            timer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
          } else retry("The live screen could not be reached.");
        });
        connection.addEventListener("securityfailure", () => fail("The live screen refused the connection."));
        connection.addEventListener("credentialsrequired", () => fail("The live screen asked for a password. It should not."));
      } catch (err) {
        // A refused ticket (setting off, not an owner or admin) will not get better by asking again.
        fail(errorText(err));
      }
    };

    setState("connecting");
    setError(null);
    void connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      rfb?.disconnect();
    };
  }, [open, companyId, attempt]);

  return { screen, state, error, retry: useCallback(() => setAttempt((n) => n + 1), []) };
}

export function BrowserLiveDrawer({ open, companyId, onClose }: { open: boolean; companyId: string; onClose: () => void }) {
  const { screen, state, error, retry } = useWatchLive(companyId, open);
  return (
    <Sheet open={open} title="Watch live" onClose={onClose}>
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          <Pill tone={state === "live" ? "ok" : state === "error" ? "bad" : "warn"} dot>{LABELS[state]}</Pill>
          <span style={{ fontSize: 12.5, color: tokens.muted, overflowWrap: "anywhere", minWidth: 0 }}>You can see the server browser. Typing and clicking do nothing.</span>
        </div>
        {error ? (
          <div role="alert" style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${tokens.tones.bad.border}`, background: tokens.tones.bad.soft, color: tokens.tones.bad.fg, fontSize: 13, overflowWrap: "anywhere", minWidth: 0 }}>{error}</div>
        ) : null}
        {/* noVNC fills this box; its canvas is scaled to fit and takes no keyboard or mouse input (viewOnly). */}
        <div ref={screen} aria-label="Server browser screen" style={{ width: "100%", aspectRatio: "16 / 10", minWidth: 0, overflow: "hidden", borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.secondary }} />
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
          {state === "error" ? <Button type="button" onClick={retry}>Try again</Button> : null}
        </div>
      </div>
    </Sheet>
  );
}
