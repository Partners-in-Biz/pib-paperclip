/**
 * Cockpit → Browser: which pib-browser logins work, "Watch live" (the server browser's screen, read-only) and, per
 * login, "Take over browser" (PAR-14514 S4). Read from `browser.status` (the status file `pib-browser probe --all`
 * writes) and `browser.live.status` (the daemon's lease). A take-over that ended without Done shows on its row as
 * "Login finished, not confirmed" with a Done button: nothing is woken until someone presses it.
 * Shows no secret and no host key.
 */
import { useCallback, useEffect, useState } from "react";
import { useCockpitAction } from "./actions.js";
import { Button, EmptyState, KeyRound, Pill, TriangleAlert, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { BrowserView } from "../browser-status.js";
import { BrowserLiveDrawer, takeoverPhase, type TakeoverPhase } from "./browser-live-drawer.js";
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

/** One login's take-over controls on its row. */
function TakeoverControls({ phase, live, busy, onTakeOver, onDone }: { phase: TakeoverPhase; live: BrowserView["live"]; busy: boolean; onTakeOver?: () => void; onDone?: () => void }) {
  if (phase.kind === "logged_in" || phase.kind === "ended") {
    return (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
        <Pill tone="warn" dot>Login finished, not confirmed</Pill>
        <Button type="button" disabled={busy} onClick={onDone}>{busy ? "Checking…" : "Done"}</Button>
        <span style={{ ...wrap, fontSize: 12.5, color: tokens.muted }}>Nothing is woken until you press Done.</span>
      </span>
    );
  }
  if (phase.kind === "live") return <Pill tone="warn" dot>Taken over now</Pill>;
  // Done and Stop work at every setting; starting one needs `takeover`, and no other take-over may be live.
  if (live !== "takeover" || phase.kind === "other") return null;
  return <Button type="button" variant="secondary" onClick={onTakeOver}>Take over browser</Button>;
}

export function BrowserBody({ view, identity, hrefFor, onWatchLive, lease = null, onTakeOver, onDone, doneBusy = null, notice = null }: {
  view: BrowserView;
  identity?: string | null;
  hrefFor?: (identity: string) => string;
  onWatchLive?: () => void;
  /** The daemon's `/status` `lease` (null: none, or not readable). */
  lease?: unknown;
  onTakeOver?: (identity: string) => void;
  onDone?: (identity: string) => void;
  /** The identity whose Done is running. */
  doneBusy?: string | null;
  notice?: { ok: boolean; message: string } | null;
}) {
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
                  <TakeoverControls phase={takeoverPhase(lease, i.identity)} live={view.live} busy={doneBusy === i.identity} onTakeOver={() => onTakeOver?.(i.identity)} onDone={() => onDone?.(i.identity)} />
                </li>
              );
            })}
          </ul>
        ) : (
          <Muted>The status file lists no logins.</Muted>
        )}
        {notice ? <div role={notice.ok ? "status" : "alert"} style={{ ...wrap, marginTop: 10, padding: "8px 10px", borderRadius: 8, border: `1px solid ${tokens.tones[notice.ok ? "ok" : "bad"].border}`, background: tokens.tones[notice.ok ? "ok" : "bad"].soft, color: tokens.tones[notice.ok ? "ok" : "bad"].fg, fontSize: 13 }}>{notice.message}</div> : null}
      </Card>
      {identity && !selected ? (
        <EmptyState icon={TriangleAlert} tone="warn" title="Unknown login" description="That login is not in the status file. Pick one from the list." />
      ) : null}
      {selected && !ok(selected, view) ? (
        <Card title={`Log in again: ${selected.identity}`} subtitle="This login has expired.">
          <Muted>{view.live === "off" ? "Watch live is turned off in the Cockpit settings." : view.live === "takeover" ? "Press Take over browser on its row, log in in the window, then press Done. The tasks waiting for this login are woken." : "Use Watch live to see the server browser. Take over is not turned on in the Cockpit settings."}</Muted>
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
  const readLive = useCockpitAction("browser.live.status");
  const sendDone = useCockpitAction("browser.takeover.done");
  const [watching, setWatching] = useState(false);
  const [takingOver, setTakingOver] = useState<string | null>(null);
  const [lease, setLease] = useState<unknown>(null);
  const [doneBusy, setDoneBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    try {
      setView((await load({})) as BrowserView);
    } catch (err) {
      setError(errorText(err));
    }
  }, [load]);
  // The lease, for the rows. Refused for anyone who may not watch (no controls then); unreachable reads as none.
  const reloadLease = useCallback(async () => {
    try {
      setLease(((await readLive({})) as { status?: { lease?: unknown } | null })?.status?.lease ?? null);
    } catch {
      setLease(null);
    }
  }, [readLive]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  useEffect(() => {
    if (!view || view.state === "unavailable") return;
    void reloadLease();
    const t = setInterval(() => void reloadLease(), 15_000);
    return () => clearInterval(t);
  }, [view, reloadLease]);
  const done = useCallback(async (who: string) => {
    setDoneBusy(who);
    setNotice(null);
    try {
      const r = (await sendDone({ identity: who })) as { ok: boolean; message: string };
      setNotice({ ok: r.ok === true, message: String(r.message ?? "") });
    } catch (err) {
      setNotice({ ok: false, message: errorText(err) });
    } finally {
      setDoneBusy(null);
      void reloadLease();
      void reload();
    }
  }, [sendDone, reloadLease, reload]);
  if (error && !view) return <EmptyState tone="bad" icon={TriangleAlert} title="The browser logins could not load" description={error} action={<Button type="button" variant="secondary" onClick={() => void reload()}>Try again</Button>} />;
  if (!view) return <Muted>Loading the browser logins…</Muted>;
  return (
    <>
      <BrowserBody view={view} identity={identity} onWatchLive={() => setWatching(true)} lease={lease} onTakeOver={setTakingOver} onDone={(who) => void done(who)} doneBusy={doneBusy} notice={notice} />
      {view.live !== "off" ? <BrowserLiveDrawer open={watching} companyId={companyId} onClose={() => setWatching(false)} /> : null}
      {takingOver ? (
        <BrowserLiveDrawer open companyId={companyId} identity={takingOver} mode="control" defaultExpanded onClose={() => { setTakingOver(null); void reloadLease(); void reload(); }} />
      ) : null}
    </>
  );
}
