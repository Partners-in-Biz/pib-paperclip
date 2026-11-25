/**
 * For the browser bundle, which can't load namespace.ts (node:crypto): Studio's plugin key and its board card's slot
 * id. tests/board-sign.spec.ts pins STUDIO_PLUGIN_KEY to namespace.ts's PLUGIN_ID.
 */
export const STUDIO_PLUGIN_KEY = "partnersinbiz.studio";
/** The `canvasNode` slot id: an embed node `{ plugin: PLUGIN_ID, type: STUDIO_MEDIA_CARD, assetId }` (PAR-14280). */
export const STUDIO_MEDIA_CARD = "studio-media";
/** The generate card (PAR-14281): `{ plugin: PLUGIN_ID, type: STUDIO_GENERATE_CARD, props: { prompt, model, kind, inputKeys } }`. */
export const STUDIO_GENERATE_CARD = "studio-generate";
