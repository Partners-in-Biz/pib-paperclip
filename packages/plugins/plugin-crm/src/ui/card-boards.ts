/**
 * One card batcher per board for the CRM's canvas cards (PAR-14416): every CRM card of a board asks through it, so
 * the board opens with one `canvas.cards.resolve` call for the CRM. It lives while a CRM card of that board is
 * mounted; when the last one unmounts it is dropped, so opening the board again asks again. No React here (tests).
 */
import { createCardBatcher, type CardBatcher, type CardsResolve } from "@partnersinbiz/pib-plugin-ui";

export interface BoardEntry {
  batcher: CardBatcher;
  resolve: { current: CardsResolve };
  cards: number;
}

const boards = new Map<string, BoardEntry>();

/** The board's batcher, made on first use (exported for tests). */
export function boardBatcher(key: string, resolve: CardsResolve): BoardEntry {
  const known = boards.get(key);
  if (known) {
    known.resolve.current = resolve;
    return known;
  }
  const ref = { current: resolve };
  const entry: BoardEntry = { batcher: createCardBatcher((params) => ref.current(params)), resolve: ref, cards: 0 };
  boards.set(key, entry);
  return entry;
}

/** A card of the board mounted; the returned function is its unmount. */
export function holdBoard(key: string, entry: BoardEntry): () => void {
  if (!boards.has(key)) boards.set(key, entry);
  const held = boards.get(key)!;
  held.cards += 1;
  return () => {
    held.cards -= 1;
    if (held.cards <= 0 && boards.get(key) === held) boards.delete(key);
  };
}
