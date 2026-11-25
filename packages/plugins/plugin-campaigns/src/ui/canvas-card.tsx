/**
 * The Campaigns card of a planning-canvas embed node (PAR-14423): `{ plugin, type: "card-campaign", assetId: <campaign id> }`.
 * The shared EntityCanvasCard draws it; the cards of one board share one batcher so they go out as one `resolve` call.
 */
import type { PluginCanvasNodeProps } from "@paperclipai/plugin-sdk/ui";
import { EntityCanvasCard, createCardBatcher, type CardBatcher, type CardsResolve } from "@partnersinbiz/pib-plugin-ui";
import { useCampaignsAction } from "./actions.js";

const CARD = "card-campaign";
const boards = new Map<string, { batcher: CardBatcher; resolve: CardsResolve }>();

/** One batcher per open board; a reload of the page builds a new one. */
function batcherFor(boardId: string, resolve: CardsResolve): CardBatcher {
  let entry = boards.get(boardId);
  if (!entry) {
    const created = { resolve, batcher: null as unknown as CardBatcher };
    created.batcher = createCardBatcher((params) => created.resolve(params));
    boards.set(boardId, (entry = created));
  }
  entry.resolve = resolve;
  return entry.batcher;
}

export function CampaignCanvasCard(props: PluginCanvasNodeProps) {
  const resolve = useCampaignsAction("canvas.cards.resolve") as CardsResolve;
  const batcher = batcherFor(props.boardId ?? props.context?.companyId ?? "board", resolve);
  if (!props.assetId) return null;
  return <EntityCanvasCard batcher={batcher} type={CARD} id={props.assetId} kindLabel="campaign" />;
}
