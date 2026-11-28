/**
 * Cockpit → Decide: what waits on the owner, one card at a time (PAR-15315, T3). Title, why, approval details,
 * the options as buttons (the recommended one marked) and one screenshot or video. A click decides; Space moves on
 * and Enter opens the task. No key ever decides. The state lives in `decide-session.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { Button, EmptyState, Inbox, PageMessage, Pill, Scale, TriangleAlert, breakAnywhere, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { DecideItem } from "../decide-model.js";
import { useCockpitAction } from "./actions.js";
import { Card, Muted, type LinkPropsFor } from "./components.js";
import { DecideSession, decisionCall, keyIntent, pickMedia, type DecideData, type DecideMedia, type DecideState } from "./decide-session.js";

const SAST_OFFSET_MS = 2 * 3_600_000;
const two = (n: number) => String(n).padStart(2, "0");

/** `14:02` in South African time (SAST is UTC+2 all year), or null for a bad date. */
export function clockSast(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return null;
  const d = new Date(t + SAST_OFFSET_MS);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

const wrap: CSSProperties = { ...breakAnywhere, minWidth: 0 };

function MediaBlock({ media }: { media: DecideMedia | null | undefined }) {
  if (!media) return null;
  const box: CSSProperties = { display: "block", width: "100%", maxHeight: 360, objectFit: "contain", borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.secondary };
  return media.kind === "video" ? (
    <video src={media.src} controls preload="metadata" aria-label={media.name ?? "Video on the task"} style={box} />
  ) : (
    <img src={media.src} alt={media.name ?? "Screenshot on the task"} loading="lazy" style={box} />
  );
}

/** The card and what is around it, without loading: also what the tests and the visual checks render. */
export function DecideBody({
  state,
  linkFor,
  onOption,
  onNext,
  onRefresh,
}: {
  state: Pick<DecideState, "data" | "items" | "pos" | "busy" | "flash" | "error" | "media" | "loading" | "loadError">;
  linkFor: LinkPropsFor;
  onOption?: (option: string) => void;
  onNext?: () => void;
  onRefresh?: () => void;
}) {
  const { data, items, pos } = state;
  if (state.loadError && !data) {
    return <EmptyState tone="bad" icon={TriangleAlert} title="The queue could not load" description={state.loadError} action={onRefresh ? <Button type="button" variant="secondary" onClick={onRefresh}>Try again</Button> : undefined} />;
  }
  if (!data) return <Muted>{state.loading ? "Loading what waits on you…" : "Nothing to show yet."}</Muted>;
  if (data.notOwner) return <EmptyState icon={Scale} title="This queue is the owner's" description="Only the Cockpit owner decides here. Everything you can answer is still on the Overview tab." />;
  const asOf = clockSast(data.cardsAsOf);
  const foot = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 12.5, color: tokens.muted, ...wrap }}>
      <span>{asOf ? `Cards as of ${asOf}` : "Cards not read yet"}{data.cardsRefreshing ? ", updating" : ""}</span>
      {onRefresh ? <Button type="button" variant="secondary" onClick={onRefresh} disabled={state.loading} style={{ minHeight: 32 }}>{state.loading ? "Loading…" : "Refresh"}</Button> : null}
    </div>
  );
  const partial = data.partial.length ? <PageMessage message={`Not fully read: ${data.partial.join(", ")}.`} tone="warn" /> : null;
  const item = items[pos];
  if (!item) {
    return (
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        {partial}
        <EmptyState icon={Inbox} title="Nothing waits on you." description="Every ask, approval and card is decided. New ones appear here." />
        {foot}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {partial}
      <DecideCard item={item} index={pos} total={items.length} state={state} linkFor={linkFor} onOption={onOption} onNext={onNext} />
      {foot}
    </div>
  );
}

function DecideCard({
  item,
  index,
  total,
  state,
  linkFor,
  onOption,
  onNext,
}: {
  item: DecideItem;
  index: number;
  total: number;
  state: Pick<DecideState, "busy" | "flash" | "error" | "media">;
  linkFor: LinkPropsFor;
  onOption?: (option: string) => void;
  onNext?: () => void;
}) {
  const media = item.ref.issueId ? state.media[item.ref.issueId] : null;
  const decidable = item.mode === "decide";
  const locked = state.busy || !!state.flash;
  return (
    <Card
      title={`${index + 1} of ${total}`}
      icon={Scale}
      tone={item.overdue ? "bad" : undefined}
      actions={(
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {item.overdue ? <Pill tone="bad" dot>Overdue</Pill> : null}
          {total > 1 && onNext ? <Button type="button" variant="secondary" onClick={onNext} disabled={locked} style={{ minHeight: 32 }}>Next (Space)</Button> : null}
        </div>
      )}
    >
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, lineHeight: 1.35, fontWeight: 650, color: tokens.fg, ...wrap }}>{item.title}</h2>
        {item.why ? <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: tokens.muted, ...wrap }}>{item.why}</p> : null}
        {item.details.length ? (
          <dl style={{ margin: 0, display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
            {item.details.map((d) => (
              <div key={d.label} style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <dt style={{ fontSize: 12, color: tokens.muted, ...wrap }}>{d.label}</dt>
                <dd style={{ margin: 0, fontSize: 14, color: tokens.fg, ...wrap }}>{d.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <MediaBlock media={media} />
        {decidable ? (
          <div role="group" aria-label="Your answer" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {item.options.map((option) => {
              const recommended = item.recommended === option;
              return (
                <Button
                  key={option}
                  type="button"
                  variant={recommended ? "primary" : "secondary"}
                  disabled={locked}
                  onClick={(e) => {
                    // Focus must not stay on the button: Space or Enter would press it again.
                    e.currentTarget.blur();
                    onOption?.(option);
                  }}
                  style={{ minHeight: 40, maxWidth: "100%", textAlign: "left", ...wrap }}
                >
                  {option}{recommended ? " (recommended)" : ""}
                </Button>
              );
            })}
          </div>
        ) : (
          <Muted>This one cannot be decided here. Open the task to answer it.</Muted>
        )}
        {state.flash ? <PageMessage message={state.flash} tone="ok" /> : null}
        {state.error ? <PageMessage message={state.error} tone="bad" /> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {item.href ? <a {...linkFor(item.href)} style={{ color: tokens.primary, fontWeight: 600, fontSize: 13.5 }}>Open task (Enter)</a> : <Muted>No task to open.</Muted>}
        </div>
      </div>
    </Card>
  );
}

async function fetchMedia(issueId: string): Promise<DecideMedia | null> {
  const res = await fetch(`/api/issues/${encodeURIComponent(issueId)}/attachments`, { credentials: "include", headers: { accept: "application/json" } });
  if (!res.ok) return null;
  return pickMedia(await res.json().catch(() => null));
}

/** The Decide tab. */
export function DecidePanel({
  refreshKey = 0,
  linkFor,
  navigate,
  onCount,
}: {
  refreshKey?: number;
  linkFor: LinkPropsFor;
  navigate: (href: string) => void;
  /** The number of cards left, for the tab. */
  onCount?: (count: number | null) => void;
}) {
  const queue = useCockpitAction("decide.queue");
  const ask = useCockpitAction("decide.ask");
  const approval = useCockpitAction("decide.approval");
  const card = useCockpitAction("decide.card");
  const calls = useRef({ queue, ask, approval, card });
  calls.current = { queue, ask, approval, card };

  const session = useMemo(
    () =>
      new DecideSession({
        load: async () => (await calls.current.queue({})) as DecideData,
        act: async (item, option) => {
          const { action, params } = decisionCall(item, option);
          const run = action === "decide.ask" ? calls.current.ask : action === "decide.approval" ? calls.current.approval : calls.current.card;
          const out = (await run(params)) as { result?: string } | null;
          return String(out?.result ?? "");
        },
        media: fetchMedia,
      }),
    [],
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  useEffect(() => {
    void session.refresh();
  }, [session, refreshKey]);
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => {
    onCount?.(state.data && !state.data.notOwner ? state.items.length : null);
  }, [state.data, state.items.length, onCount]);

  const current = state.items[state.pos];
  const href = current?.href ?? null;
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const intent = keyIntent(e);
      if (!intent) return;
      // A focused button or link must not also react to the key: no key decides.
      e.preventDefault();
      if (intent === "next") session.next();
      else if (href) navigate(href);
    };
    const up = (e: KeyboardEvent) => {
      // A button fires its click when Space is released: stop that too.
      if (keyIntent(e)) e.preventDefault();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [session, href, navigate]);

  const onOption = useCallback((option: string) => void session.decide(option), [session]);
  const onNext = useCallback(() => session.next(), [session]);
  const onRefresh = useCallback(() => void session.refresh(), [session]);
  return <DecideBody state={state} linkFor={linkFor} onOption={onOption} onNext={onNext} onRefresh={onRefresh} />;
}

