/**
 * The one place the CRM pages get their actions (access stage A, spec PAR-12578 section 4.6; PAR-12680).
 * A guarded action answers a refusal as a 200 `{ ok: false, refused: true, code, message }`. `useCrmAction` (the UI
 * kit's `withRefusal`) throws it again as an `AccessRefused` error with the worker's message, so every caller's
 * existing `catch` shows the real reason and a refusal never reads as success. `useAccessMe` is the page gate's
 * loader: it must see the refusal answer as it is.
 * No other page file imports `usePluginAction` (tests/access.spec.ts checks it).
 */
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { withRefusal } from "@partnersinbiz/pib-plugin-ui";

export const useCrmAction = withRefusal(usePluginAction);

/** The guard's `access.me` action, for `useAccess`. */
export const useAccessMe = () => usePluginAction("access.me");

/** `canvas.cards.resolve` for the board cards: the card batcher reads every refusal shape itself (it draws "No access"), so it gets the answer as it is. */
export const useCardsResolve = () => usePluginAction("canvas.cards.resolve");
