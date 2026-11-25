/**
 * Cockpit → Browser: which pib-browser logins work, and "Watch live" (the server browser's screen, read-only).
 * Read from `browser.status` (the status file `pib-browser probe --all` writes). Shows no secret and no host key.
 */
import { useCallback, useEffect, useState } from "react";
import { useCockpitAction } from "./actions.js";
import { Button, EmptyState, KeyRound, Pill, TriangleAlert, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { BrowserView } from "../browser-status.js";
import { BrowserLiveDrawer } from "./browser-live-drawer.js";
import { Card, Muted } from "./components.js";

const wrap = { overflowWrap: "anywhere", minWidth: 0 } as const;

const ok = (i: { ok: boolean }, view: BrowserView) => i.ok && !view.stale;

function when(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "–";
}

function WatchLiveCard({ view, onWatchLive }: { view: BrowserView; onWatchLive?: () => void }) {
  // Only when the setting is not off and the caller may watch: the worker sends `off` for anyone else.
  if (view.state === "unavailable" || view.live === "off") return null;
  return (
    <Card title="Watch live" icon={KeyRound} subtitle="See the server browser's screen now, read-only. Typing and clicking change nothing.">
      <div>
        <Button type="button" onClick={onWatchLive}>Watch live</Button>
      </div>
    </Card>
  );
}

export function BrowserBody({ view, identity, hrefFor, onWatchLive }: { view: BrowserView; identity?: string | null; hrefFor?: (identity: string) => string; onWatchLive?: () => void }) {
  if (view.state === "unavailable") return <EmptyState icon={KeyRound} title="No browser here" description="Only the owner company has the server browser." />;
  if (view.state !== "read") {
    return (
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        <WatchLiveCard view={view} onWatchLive={onWatchLive} />
        <EmptyState icon={KeyRound} title="Logins not verified" description={view.state === "invalid" ? "The browser status file could not be read. Run the browser status check again." : "There is no browser status file yet. Run the browser status check (pib-browser probe --all)."} />
      </div>
    );
  }
  const selected = identity ? view.identities.find((i) => i.identity === identity) ?? null : null;
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <WatchLiveCard view={view} onWatchLive={onWatchLive} />
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
      {selected && !ok(selected, view) ? (
        <Card title={`Log in again: ${selected.identity}`} subtitle="This login has expired.">
          <Muted>{view.live === "off" ? "Watch live is turned off in the Cockpit settings." : "Use Watch live to see the server browser."}</Muted>
        </Card>
      ) : null}
    </div>
  );
}

/** The Browser tab. */
export function BrowserPanel({ companyId, refreshKey = 0, identity = null }: { companyId: string; refreshKey?: number; identity?: string | null }) {
  const load = useCockpitAction("browser.status");
  const [view, setView] = useState<BrowserView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
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
  return (
    <>
      <BrowserBody view={view} identity={identity} onWatchLive={() => setWatching(true)} />
      {view.live !== "off" ? <BrowserLiveDrawer open={watching} companyId={companyId} onClose={() => setWatching(false)} /> : null}
    </>
  );
}
