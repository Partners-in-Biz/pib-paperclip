/**
 * The CRM's cards on a planning canvas (PAR-14416; plan PAR-14389 C.1): `card-company` and `card-contact`, both the
 * shared `EntityCanvasCard`. All CRM cards of one board share one batcher, so a board opens with one
 * `canvas.cards.resolve` call for the CRM (30 ms window, 100 ids). The answers are kept while a CRM card of that board
 * is mounted; when the last one goes (the board closes) the batcher is dropped, so opening the board again asks again.
 * Access is the worker's answer per record: a refusal of any shape draws "No access", like a record the person cannot
 * see. The node stores ids only; nothing from the node is drawn but through the card.
 */
import { useEffect, useMemo, useRef } from "react";
import type { PluginCanvasNodeProps } from "@paperclipai/plugin-sdk/ui";
import { createCardBatcher, EntityCanvasCard, type CardBatcher, type CardsResolve } from "@partnersinbiz/pib-plugin-ui";
import { CARD_COMPANY, CARD_CONTACT } from "../card-types.js";
import { useCardsResolve } from "./actions.js";
import { boardBatcher, holdBoard } from "./card-boards.js";

/** No record id on the node: nothing vouches for it, so it draws as closed without a call. */
const NO_ID: CardBatcher = createCardBatcher(async ({ items }) => ({ cards: items.map((item) => ({ ...item, hidden: true })) }));

function useBoardBatcher(key: string): CardBatcher {
  const resolve = useCardsResolve() as CardsResolve;
  const latest = useRef(resolve);
  latest.current = resolve;
  const entry = useMemo(() => boardBatcher(key, (params) => latest.current(params)), [key]);
  useEffect(() => holdBoard(key, entry), [key, entry]);
  return entry.batcher;
}

function CrmCard({ props, type, kindLabel }: { props: PluginCanvasNodeProps; type: string; kindLabel: string }) {
  const batcher = useBoardBatcher(`${props.context?.companyId ?? ""}\u0000${props.boardId}`);
  const id = props.assetId?.trim() ?? "";
  return <EntityCanvasCard batcher={id ? batcher : NO_ID} type={type} id={id || "none"} kindLabel={kindLabel} />;
}

export function CrmCompanyCard(props: PluginCanvasNodeProps) {
  return <CrmCard props={props} type={CARD_COMPANY} kindLabel="Company" />;
}

export function CrmContactCard(props: PluginCanvasNodeProps) {
  return <CrmCard props={props} type={CARD_CONTACT} kindLabel="Contact" />;
}
