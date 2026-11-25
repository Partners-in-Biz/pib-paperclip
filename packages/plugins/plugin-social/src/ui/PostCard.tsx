/**
 * The Social post card on a Planning Canvas board (PAR-14389 B3a): the `canvasNode` slot `card-post`. The node's
 * `assetId` is the post id. One batcher per open board groups the board's asks into one `canvas.cards.resolve`.
 */
import type { PluginCanvasNodeProps } from "@paperclipai/plugin-sdk/ui";
import { useSocialAction } from "./actions.js";
import { EntityCanvasCard, createCardBatcher, type CardBatcher, type CardsResolve } from "@partnersinbiz/pib-plugin-ui";
import { POST_CARD_SLOT } from "../slots.js";

const RESOLVE_KEY = "canvas.cards.resolve";
const batchers = new Map<string, { batcher: CardBatcher; resolve: { current: CardsResolve } }>();

function batcherFor(boardId: string, resolve: CardsResolve): CardBatcher {
  let entry = batchers.get(boardId);
  if (!entry) {
    const latest = { current: resolve };
    entry = { batcher: createCardBatcher((params) => latest.current(params)), resolve: latest };
    batchers.set(boardId, entry);
  }
  entry.resolve.current = resolve;
  return entry.batcher;
}

export function SocialPostCard({ boardId, assetId }: PluginCanvasNodeProps) {
  const resolve = useSocialAction(RESOLVE_KEY) as unknown as CardsResolve;
  return <EntityCanvasCard batcher={batcherFor(boardId, resolve)} type={POST_CARD_SLOT} id={assetId ?? ""} kindLabel="Post" />;
}
