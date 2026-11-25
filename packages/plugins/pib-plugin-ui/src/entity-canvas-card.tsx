/**
 * The shared entity card (plan PAR-14389 C.1): kind badge, title, subtitle, status chip, up to four meta rows
 * and "Open". Every value is drawn as text (React escapes it; nothing is set as HTML). A closed record draws
 * "No access" whatever the reason; a failed load draws "Couldn't load" with a retry.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { breakAnywhere, font, oneColumn, usePibBaseStyles } from "./base.js";
import { Pill } from "./display.js";
import { createCardBatcher, isCardHref, type CardBatcher, type CardsResolve, type EntityCardState } from "./entity-card-batcher.js";
import { tokens } from "./tokens.js";

export const ENTITY_CARD_TEXT = { noAccess: "No access", loadFailed: "Couldn't load", retry: "Retry", open: "Open", loading: "Loading" } as const;

/** One batcher per plugin per open board. Pass a stable `resolve` (`usePluginAction("canvas.cards.resolve")` is). */
export function useCardBatcher(resolve: CardsResolve): CardBatcher {
  const latest = useRef(resolve);
  latest.current = resolve;
  return useMemo(() => createCardBatcher((params) => latest.current(params)), []);
}

/** The state of one card: null while loading. */
export function useEntityCard(batcher: CardBatcher, type: string, id: string): { state: EntityCardState | null; retry: () => void } {
  const [state, setState] = useState<EntityCardState | null>(null);
  const live = useRef(0);
  useEffect(() => {
    const mine = ++live.current;
    setState(null);
    void batcher.load(type, id).then((next) => live.current === mine && setState(next));
    return () => {
      live.current++;
    };
  }, [batcher, type, id]);
  const retry = useCallback(() => {
    const mine = ++live.current;
    setState(null);
    void batcher.retry(type, id).then((next) => live.current === mine && setState(next));
  }, [batcher, type, id]);
  return { state, retry };
}

const shell = {
  display: "grid",
  gridTemplateColumns: oneColumn,
  gap: 8,
  alignContent: "start",
  padding: 12,
  boxSizing: "border-box",
  width: "100%",
  minWidth: 0,
  borderRadius: 12,
  border: `1px solid ${tokens.border}`,
  background: tokens.card,
  color: tokens.fg,
  fontFamily: font,
} as const;

export function EntityCanvasCard({ batcher, type, id, kindLabel }: { batcher: CardBatcher; type: string; id: string; kindLabel?: string }) {
  usePibBaseStyles();
  const { state, retry } = useEntityCard(batcher, type, id);
  const kind = kindLabel ?? type.replace(/^card-/, "");
  const badge = <Pill size="sm" variant="outline">{kind}</Pill>;

  if (!state) {
    return <article className="pib-ui" aria-busy="true" aria-label={ENTITY_CARD_TEXT.loading} style={shell}>{badge}<span style={{ fontSize: 12, color: tokens.muted }}>{ENTITY_CARD_TEXT.loading}</span></article>;
  }
  if (state.state === "hidden") {
    return (
      <article className="pib-ui" data-card-state="hidden" style={shell}>
        {badge}
        <span role="status" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: tokens.muted }}><Lock size={14} aria-hidden="true" />{ENTITY_CARD_TEXT.noAccess}</span>
      </article>
    );
  }
  if (state.state === "error") {
    return (
      <article className="pib-ui" data-card-state="error" style={shell}>
        {badge}
        <span role="alert" style={{ fontSize: 13, color: tokens.muted }}>{ENTITY_CARD_TEXT.loadFailed}</span>
        <button type="button" onClick={retry} style={{ justifySelf: "start", minHeight: 28, padding: "0 10px", borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.secondaryFg, fontSize: 12, cursor: "pointer" }}>{ENTITY_CARD_TEXT.retry}</button>
      </article>
    );
  }

  const { card } = state;
  return (
    <article className="pib-ui" data-card-state="card" style={shell}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        {badge}
        {card.status ? <Pill size="sm" tone="neutral">{card.status}</Pill> : null}
      </div>
      <strong style={{ fontSize: 14, lineHeight: 1.3, ...breakAnywhere }}>{card.title}</strong>
      {card.subtitle ? <span style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.4, ...breakAnywhere }}>{card.subtitle}</span> : null}
      {card.meta?.length ? (
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr)", gap: "2px 10px", minWidth: 0, fontSize: 12 }}>
          {card.meta.map((m, i) => (
            <div key={i} style={{ display: "contents" }}>
              <dt style={{ color: tokens.muted, ...breakAnywhere }}>{m.label}</dt>
              <dd style={{ margin: 0, ...breakAnywhere }}>{m.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {isCardHref(card.href) ? <a href={card.href} style={{ justifySelf: "start", fontSize: 12.5, fontWeight: 600, color: tokens.primary }}>{ENTITY_CARD_TEXT.open}</a> : null}
    </article>
  );
}
