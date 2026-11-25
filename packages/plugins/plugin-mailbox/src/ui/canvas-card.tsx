/**
 * The email card on a planning canvas (PAR-14389 C.2): the `card-mail` `canvasNode` slot for an embed node
 * `{ plugin: "partnersinbiz.mailbox", type: "card-mail", assetId: <message id> }`. The worker answers what it may
 * show (`canvas.cards.resolve`); the card never reads the node's props. All the cards of one board share one
 * batcher (`board-batcher.ts`).
 */
import type { PluginCanvasNodeProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { createCardBatcher, EntityCanvasCard, type CardBatcher } from "@partnersinbiz/pib-plugin-ui";
import { MAIL_CARD } from "../constants.js";
import { boardBatcher } from "./board-batcher.js";

/** A node with no usable message id: "No access", without asking (an id the shared schema refuses would refuse the whole batch). */
const NO_RECORD: CardBatcher = { load: async () => ({ state: "hidden" }), retry: async () => ({ state: "hidden" }) };
const usableId = (id: string | null | undefined): id is string => typeof id === "string" && id.length > 0 && id.length <= 200;

export function MailCanvasCard(props: PluginCanvasNodeProps) {
  const resolve = usePluginAction("canvas.cards.resolve");
  const id = usableId(props.assetId) ? props.assetId : null;
  const batcher = id ? boardBatcher(`${props.context?.companyId ?? ""}\u0000${props.boardId}`, resolve, createCardBatcher) : NO_RECORD;
  return <EntityCanvasCard batcher={batcher} type={MAIL_CARD} id={id ?? "-"} kindLabel="Email" />;
}
