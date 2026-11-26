/**
 * The library panel's "Client" header (PAR-14848; plan PAR-14835 Approach 3 and 6, Q3, Q7): what `board-client` answers
 * and the words and decisions the panel builds from it. Kept free of React so tests can load it.
 */
import { STUDIO_MEDIA_CARD, STUDIO_PLUGIN_KEY } from "../plugin-key.js";
import type { BoardNode } from "./board-generate.js";

export interface ClientRef {
  kind: "company" | "contact";
  ref: string;
  name: string;
}

export interface NamedRef {
  ref: string;
  name: string;
}

/** The `board-client` reply. */
export interface BoardClientReply {
  effective: ClientRef | null;
  source: "project" | "board" | null;
  dormant: NamedRef | null;
  missing: NamedRef | null;
  canSet: boolean;
  withheld: boolean;
  clients?: ClientRef[];
}

export type ClientLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; reply: BoardClientReply };

/** The picker's value while the stored link names a client the CRM no longer has. */
export const MISSING_VALUE = "__missing__";
/** The picker's value for "Own work". */
export const OWN_VALUE = "";

/** `boardScope` for every board request: the project, plus the board's id when the host gives one (plan AC1). */
export function boardScopeOf(projectId: string | null, boardId: string | null | undefined): { projectId: string | null; boardId?: string } {
  return boardId ? { projectId, boardId } : { projectId };
}

export function clientReplyFrom(out: unknown): BoardClientReply {
  const r = (out ?? {}) as Partial<BoardClientReply>;
  return {
    effective: r.effective ?? null,
    source: r.source === "project" || r.source === "board" ? r.source : null,
    dormant: r.dormant ?? null,
    missing: r.missing ?? null,
    canSet: r.canSet === true,
    withheld: r.withheld === true,
    ...(Array.isArray(r.clients) ? { clients: r.clients } : {}),
  };
}

/** The link the panel is showing, as `board-client-set` wants it in `expected` (null for none). */
export function currentLink(reply: BoardClientReply): string | null {
  if (reply.source === "board" && reply.effective) return reply.effective.ref;
  if (reply.missing) return reply.missing.ref;
  return null;
}

/** The picker shows for a person who may set the link, on a board whose project has no client (Q3). */
export function showPicker(reply: BoardClientReply): boolean {
  return reply.canSet && !reply.withheld && reply.source !== "project";
}

export function pickerValue(reply: BoardClientReply): string {
  if (reply.missing) return MISSING_VALUE;
  return reply.source === "board" && reply.effective ? reply.effective.ref : OWN_VALUE;
}

/** The read-only line, for everyone who gets no picker. */
export function readOnlyLine(reply: BoardClientReply, projectName: string | null): string {
  if (reply.withheld) return "Client work";
  if (reply.source === "project" && reply.effective) return `${reply.effective.name} (from project ${projectName || "this board's project"})`;
  return reply.effective ? reply.effective.name : "Own work";
}

export const ASK_LINE = "Ask a company owner or admin to link this board.";

/** Notes under the line: a stored link the project overrides, a link whose client is gone, the ask line. */
export function clientNotes(reply: BoardClientReply): string[] {
  if (reply.withheld) return [];
  const notes: string[] = [];
  if (reply.missing) {
    const who = reply.missing.name || "a client";
    notes.push(
      reply.canSet && reply.source !== "project"
        ? `This board was linked to ${who}, who is no longer in the CRM. Pick another client, or choose Own work to clear the link.`
        : `This board was linked to ${who}, who is no longer in the CRM. Studio files for this board are off until a company owner or admin picks another client.`,
    );
  }
  if (reply.dormant) notes.push(`This board was also linked to ${reply.dormant.name}. That link isn't used while its project has a client.`);
  if (!reply.canSet && reply.source !== "project") notes.push(ASK_LINE);
  return notes;
}

/** The effective client for "From Drive": its param string, or "own". Null while nothing may be imported. */
export function driveClientOf(reply: BoardClientReply, canGenerate: boolean): string | null {
  if (!canGenerate || reply.withheld || reply.missing) return null;
  return reply.effective ? reply.effective.ref : "own";
}

/** Studio file cards that point at a file: relinking turns these into placeholders (plan Risks, "Existing cards"). */
export function studioCardCount(items: readonly BoardNode[]): number {
  let n = 0;
  for (const item of items) {
    const embed = item.data?.data;
    if (item.deletedAt || item.kind !== "embed") continue;
    if (embed?.plugin === STUDIO_PLUGIN_KEY && embed.type === STUDIO_MEDIA_CARD) n += 1;
  }
  return n;
}

export interface PendingChange {
  /** The new client's param string, or null for Own work. */
  client: string | null;
  label: string;
  cards: number;
}

export function confirmText(p: PendingChange): string {
  const cards = `${p.cards} Studio card${p.cards === 1 ? "" : "s"} on this board`;
  return `Switch this board to ${p.label}? ${cards} will show placeholders, because their files belong to the old client. Later generations are charged to ${p.client ? p.label : "your own work"}.`;
}

/** A failed `board-client-set`: the worker's own words. */
export function setErrorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The client wasn't changed.";
}
