/**
 * Cockpit → Browser: which pib-browser logins work, and for the selected one how to log in again by hand.
 * Read from `browser.status` (the status file `pib-browser probe --all` writes). Shows no secret and no host key.
 */
import { useCallback, useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, KeyRound, Pill, TriangleAlert, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { BrowserView } from "../browser-status.js";
import { Card, Muted } from "./components.js";

const wrap = { overflowWrap: "anywhere", minWidth: 0 } as const;
const code = { display: "block", margin: 0, padding: "8px 10px", borderRadius: 8, background: tokens.secondary, border: `1px solid ${tokens.border}`, fontFamily: "ui-monospace, monospace", fontSize: 12.5, color: tokens.fg, whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: 0 } as const;

/** The flag the daemon looks for (root-owned file named after the identity, `handoff.cjs`). */
export function handoffCommand(identity: string): string {
  return `sudo touch /run/pib-browser/handoff/${identity}`;
}
/** Forwards the server's remote-desktop port; `<server>` and the port are the Sysadmin's to confirm. */
export function tunnelCommand(): string {
  return "ssh -L 5900:localhost:5900 <server>";
}

function when(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "–";
}

export function BrowserBody({ view, identity, hrefFor }: { view: BrowserView; identity?: string | null; hrefFor?: (identity: string) => string }) {
  if (view.state === "unavailable") return <EmptyState icon={KeyRound} title="No browser here" description="Only the owner company has the server browser." />;
  if (view.state !== "read") {
    return <EmptyState icon={KeyRound} title="Logins not verified" description={view.state === "invalid" ? "The browser status file could not be read. Run the browser status check again." : "There is no browser status file yet. Run the browser status check (pib-browser probe --all)."} />;
  }
  const selected = identity ? view.identities.find((i) => i.identity === identity) ?? null : null;
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <Card title="Browser logins" icon={KeyRound} subtitle={`Last checked ${when(view.checkedAt)}${view.stale ? ". More than 36 hours ago, so none is vouched for." : "."}`}>
        {view.identities.length ? (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8, minWidth: 0 }}>
            {view.identities.map((i) => {
              const ok = i.ok && !view.stale;
              return (
                <li key={i.identity} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                  <Pill tone={ok ? "ok" : "bad"} dot>{ok ? "Working" : "Expired"}</Pill>
                  <a href={hrefFor ? hrefFor(i.identity) : `?tab=browser&identity=${encodeURIComponent(i.identity)}`} style={{ ...wrap, flex: "1 1 160px", fontSize: 14, fontWeight: i.identity === identity ? 700 : 600, color: tokens.fg }}>{i.identity}</a>
                  {!ok && i.reason ? <span style={{ ...wrap, fontSize: 12.5, color: tokens.muted }}>{i.reason}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <Muted>The status file lists no logins.</Muted>
        )}
      </Card>
      {identity && !selected ? (
        <EmptyState icon={TriangleAlert} tone="warn" title="Unknown login" description="That login is not in the status file. Pick one from the list." />
      ) : null}
      {selected ? (
        <Card title={`Log in again: ${selected.identity}`} subtitle="Hand-off mode lets a person use the browser for this login.">
          <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: tokens.muted }}>1. On the server, as root, put this login in hand-off mode</span>
            <code style={code}>{handoffCommand(selected.identity)}</code>
            <span style={{ fontSize: 12, color: tokens.muted }}>2. From your computer, open the tunnel, then log in in the window</span>
            <code style={code}>{tunnelCommand()}</code>
            <span style={{ fontSize: 12, color: tokens.muted }}>3. Remove the file, then run the browser status check again</span>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/** The Browser tab. */
export function BrowserPanel({ refreshKey = 0, identity = null }: { refreshKey?: number; identity?: string | null }) {
  const load = usePluginAction("browser.status");
  const [view, setView] = useState<BrowserView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    try {
      setView((await load({})) as BrowserView);
    } catch (err) {
      setError(errorText(err));
    }
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  if (error && !view) return <EmptyState tone="bad" icon={TriangleAlert} title="The browser logins could not load" description={error} action={<Button type="button" variant="secondary" onClick={() => void reload()}>Try again</Button>} />;
  if (!view) return <Muted>Loading the browser logins…</Muted>;
  return <BrowserBody view={view} identity={identity} />;
}
