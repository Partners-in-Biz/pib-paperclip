/**
 * One card batcher per open board (PAR-14389 C.1): every email card of the board shares it, so a board of emails asks the
 * Mailbox once per batch, not once per card. A new board (or a page reload) starts a new one, so answers last as long as the
 * board stays open. No React here, so it is testable without the host.
 */
import type { CardBatcher, CardsResolve } from "@partnersinbiz/pib-plugin-ui";

let board: { key: string; batcher: CardBatcher; resolve: { current: CardsResolve } } | null = null;

/** The batcher of the board `key` (company and board id); `create` is `createCardBatcher`. The newest `resolve` is the one used. */
export function boardBatcher(key: string, resolve: CardsResolve, create: (resolve: CardsResolve) => CardBatcher): CardBatcher {
  if (board && board.key === key) {
    board.resolve.current = resolve;
    return board.batcher;
  }
  const latest = { current: resolve };
  board = { key, resolve: latest, batcher: create((params) => latest.current(params)) };
  return board.batcher;
}
