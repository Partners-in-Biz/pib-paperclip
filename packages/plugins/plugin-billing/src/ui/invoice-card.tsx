import type { PluginCanvasNodeProps } from "@paperclipai/plugin-sdk/ui";
import { useBillingAction } from "./actions.js";
import { EntityCanvasCard, useCardBatcher } from "@partnersinbiz/pib-plugin-ui";
import { INVOICE_CARD } from "../canvas-cards-key.js";

/** One invoice on a board: the shared entity card; the batcher groups every invoice card of the board into one call. */
export function BillingInvoiceCard({ assetId }: PluginCanvasNodeProps) {
  const resolve = useBillingAction("canvas.cards.resolve") as (params?: Record<string, unknown>) => Promise<unknown>;
  const batcher = useCardBatcher(resolve);
  if (!assetId) return null;
  return <EntityCanvasCard batcher={batcher} type={INVOICE_CARD} id={assetId} kindLabel="Invoice" />;
}
