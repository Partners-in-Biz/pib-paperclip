/**
 * Studio media on Planning Canvas boards (PAR-14280; plan PAR-14257 B.2 D, C "Interfaces", G.1, G.2).
 *
 * A board asks with `boardScope { projectId | null, boardId? }`. A project board maps to that project's client; a
 * project with no client, a company board and a personal board map to the board's own client link (PAR-14835, set on
 * the library panel) and otherwise to own work. A file is signed for a board only when its client is exactly the
 * board's. That is stricter than `assertReachable`, which passes any file when the project has no client. The ids come
 * from the browser and can only narrow: without them the person path is unchanged, and a person can already open any
 * file he may see on Studio's own page. The same rule holds whoever wrote the node (a person or an agent), because it
 * runs when the card is drawn, not when it is placed.
 *
 * Every read on this path fails closed (PAR-14835 Approach 2): a CRM or link read that throws refuses with
 * `board_client_unavailable`, never "own work", so a failure can't move a charge to another wallet.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam, resolveCrmClient, sameClient, type ClientScope, type CrmClient } from "@partnersinbiz/pib-plugin-kit";
import { StudioConfig } from "./config.js";
import { table } from "./db.js";
import { StudioError } from "./errors.js";
import { boardClientUnavailable, projectClientStrict } from "./scope.js";

export interface BoardScope {
  projectId: string | null;
  /** The Planning Canvas board's id, when the caller sends it: its client link is read only then. */
  boardId?: string | null;
}

/** What a board stands for: its client (null = own work), and one settings handle for the call. */
export interface BoardTarget {
  client: ClientScope;
  config: StudioConfig;
}

/** A client named by its param string (`company:<id>`) and a name. */
export interface NamedRef {
  ref: string;
  name: string;
}

/** How the board's client was found: `project` (the project's CRM client), `board` (the board's link), null (own work). */
export type BoardSource = "project" | "board" | null;

export interface BoardResolution {
  client: ClientScope;
  clientName: string | null;
  crm: CrmClient | null;
  source: BoardSource;
  /** The board's stored link while the project's client wins (Q3): shown, never used. */
  dormant: NamedRef | null;
  /** The board's link names a client the CRM no longer has: every board action but `board-client` refuses. */
  missing: NamedRef | null;
}

/** Studio's settings switch for board cards is off: every card is a placeholder. */
export const BOARD_CARDS_OFF = "board_cards_off";
/** The file's client is not the board's. */
export const WRONG_BOARD = "wrong_board";
/** The board's link names a client that was deleted in the CRM (or hasn't synced). */
export const LINKED_CLIENT_MISSING = "linked_client_missing";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBoardId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** `undefined`: no board in the call. Present but malformed is an error, never quietly "no board". */
export function boardScopeInput(params: Record<string, unknown>): BoardScope | undefined {
  if (!("boardScope" in params) || params.boardScope === undefined) return undefined;
  const raw = params.boardScope;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StudioError("boardScope must be { projectId, boardId } (projectId null for a company or personal board).", "bad_board_scope");
  const { projectId, boardId } = raw as Record<string, unknown>;
  let project: string | null = null;
  if (projectId !== null && projectId !== undefined) {
    if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 200) throw new StudioError("boardScope.projectId must be a project id or null.", "bad_board_scope");
    project = projectId.trim();
  }
  if (boardId === null || boardId === undefined) return { projectId: project };
  if (!isBoardId(boardId)) throw new StudioError("boardScope.boardId must be the board's id.", "bad_board_scope");
  return { projectId: project, boardId: boardId.toLowerCase() };
}

/** Refuses the whole call when the switch is off (a failed settings read counts as off). */
export async function assertBoardCardsOn(config: StudioConfig): Promise<void> {
  if (!(await config.boardCardsOn())) throw new StudioError("Studio media on boards is switched off in Studio's settings.", BOARD_CARDS_OFF);
}

export interface StoredLink {
  kind: "company" | "contact";
  id: string;
  name: string;
}

/** The board's link: its latest row, null when there is none or the latest row is a clear. A failed read throws. */
export async function latestBoardLink(ctx: PluginContext, companyId: string, boardId: string): Promise<StoredLink | null> {
  const rows = await ctx.db.query<{ client_kind: string | null; client_ref: string | null; client_name: string | null }>(
    `SELECT client_kind, client_ref, client_name FROM ${table(ctx, "board_client_links")} WHERE company_id = $1 AND board_id = $2 ORDER BY at DESC, id DESC LIMIT 1`,
    [companyId, boardId],
  );
  const row = rows[0];
  if (!row || !row.client_ref || (row.client_kind !== "company" && row.client_kind !== "contact")) return null;
  return { kind: row.client_kind, id: row.client_ref, name: row.client_name ?? "" };
}

/** The live CRM record of a link: null when it is gone, `board_client_unavailable` when the read throws. */
async function linkedClient(ctx: PluginContext, companyId: string, link: StoredLink): Promise<CrmClient | null> {
  try {
    return await resolveCrmClient(ctx, ctx.db.namespace, companyId, { kind: link.kind, id: link.id });
  } catch {
    throw boardClientUnavailable();
  }
}

const OWN: BoardResolution = { client: null, clientName: null, crm: null, source: null, dormant: null, missing: null };

/**
 * The board's client, in order (plan PAR-14835 Behaviour table): the project's CRM client -> else the board's latest
 * link -> else own work. No settings check: `boardTarget` adds it.
 */
export async function resolveBoard(ctx: PluginContext, companyId: string, board: BoardScope): Promise<BoardResolution> {
  const owner = await projectClientStrict(ctx, companyId, board.projectId);
  if (owner) {
    // The project's client wins; the stored link is only shown, so a failed read of it changes nothing.
    let dormant: NamedRef | null = null;
    if (board.boardId) {
      const link = await latestBoardLink(ctx, companyId, board.boardId).catch(() => null);
      if (link) dormant = { ref: formatClientParam(link), name: (await resolveCrmClient(ctx, ctx.db.namespace, companyId, link).catch(() => null))?.name ?? link.name };
    }
    return { client: { kind: owner.kind, id: owner.id }, clientName: owner.name, crm: owner, source: "project", dormant, missing: null };
  }
  if (!board.boardId) return OWN;
  let link: StoredLink | null;
  try {
    link = await latestBoardLink(ctx, companyId, board.boardId);
  } catch {
    throw boardClientUnavailable();
  }
  if (!link) return OWN;
  const crm = await linkedClient(ctx, companyId, link);
  if (!crm) return { ...OWN, missing: { ref: formatClientParam(link), name: link.name } };
  return { client: { kind: crm.kind, id: crm.id }, clientName: crm.name, crm, source: "board", dormant: null, missing: null };
}

/** The board's client for a board action: switch on, read fail-closed, and a link to a deleted client refused. */
export async function boardTarget(ctx: PluginContext, companyId: string, board: BoardScope, config = new StudioConfig(ctx, companyId)): Promise<BoardTarget & BoardResolution> {
  await assertBoardCardsOn(config);
  const resolved = await resolveBoard(ctx, companyId, board);
  if (resolved.missing) {
    throw new StudioError(`This board is linked to ${resolved.missing.name || "a client"}, who is no longer in the CRM. A company owner or admin can pick another client or clear the link on the board's Studio panel.`, LINKED_CLIENT_MISSING);
  }
  return { ...resolved, config };
}

export function onBoard(asset: ClientScope, board: BoardTarget): boolean {
  return sameClient(asset, board.client);
}

/** A file that is gone from the board's point of view: no row, or archived on Studio's page. */
export const REMOVED_STATUSES: ReadonlySet<string> = new Set(["archived"]);
