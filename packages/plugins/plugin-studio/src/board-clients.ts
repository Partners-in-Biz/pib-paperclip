/**
 * A Planning Canvas board's CRM client (PAR-14847; plan PAR-14835 Approach 1 and 3, Q3, Q7).
 *
 * - The link lives in Studio's append-only `board_client_links`: a set is one row with the client, a clear one row with
 *   the client columns NULL, and the board's link is its latest row (`latestBoardLink`). Each change is one INSERT, so
 *   the link and its log can't disagree.
 * - The project's CRM client always wins (Q3): a board on such a project can't be linked, and a stored link stays
 *   dormant (shown, never used) while the project has a client.
 * - Only a company owner or admin who isn't restricted may set or clear a link (Q7): Studio can't see who may edit a
 *   board, and a relink moves every later charge on that board to another client.
 * - `expected` is the link the panel showed. A different current link refuses with `link_changed`, nothing written, so
 *   a stale panel can't silently overwrite someone else's change.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam, listCrmClients, MEMBER_RESTRICTED, resolveCrmClient, sameClient, type ActingRestriction, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { assertBoardCardsOn, boardScopeInput, latestBoardLink, resolveBoard, type BoardScope, type BoardSource, type NamedRef, type StoredLink } from "./board-scope.js";
import { StudioConfig } from "./config.js";
import { table } from "./db.js";
import { StudioError } from "./errors.js";
import { assertUnrestricted, boardClientUnavailable, projectClientStrict, scopeInput } from "./scope.js";

export const OWNER_OR_ADMIN_ONLY = "owner_or_admin_only";
export const PROJECT_CLIENT = "project_client";
export const LINK_CHANGED = "link_changed";

export interface BoardPerson {
  role: string;
  userId: string;
  restriction: ActingRestriction;
}

export interface ClientRefOut {
  kind: "company" | "contact";
  ref: string;
  name: string;
}

export interface BoardClientView {
  effective: ClientRefOut | null;
  source: BoardSource;
  dormant: NamedRef | null;
  missing: NamedRef | null;
  canSet: boolean;
  withheld: boolean;
  /** Every CRM client, for the picker: only when `canSet`. */
  clients?: ClientRefOut[];
}

const isOwnerOrAdminRole = (role: string) => role === "owner" || role === "admin";

const out = (client: { kind: "company" | "contact"; id: string; name: string }): ClientRefOut => ({ kind: client.kind, ref: formatClientParam(client), name: client.name });

/**
 * What the board's Studio panel shows (`board-client`): the effective client and where it came from, a dormant or a
 * missing link, and whether this person may change it. A restricted member learns only that client work is there.
 */
export async function boardClientView(ctx: PluginContext, companyId: string, board: BoardScope, me: BoardPerson): Promise<BoardClientView> {
  await assertBoardCardsOn(new StudioConfig(ctx, companyId));
  const r = await resolveBoard(ctx, companyId, board);
  if ((r.client || r.dormant || r.missing) && me.restriction !== "unrestricted") {
    try {
      assertUnrestricted(me.restriction);
    } catch (error) {
      if (error instanceof StudioError && error.code === MEMBER_RESTRICTED) return { effective: null, source: r.source, dormant: null, missing: null, canSet: false, withheld: true };
      throw error;
    }
  }
  const canSet = isOwnerOrAdminRole(me.role) && me.restriction === "unrestricted";
  const view: BoardClientView = { effective: r.crm ? out(r.crm) : null, source: r.source, dormant: r.dormant, missing: r.missing, canSet, withheld: false };
  if (!canSet) return view;
  const clients = await listCrmClients(ctx, ctx.db.namespace, companyId).catch(() => {
    throw boardClientUnavailable();
  });
  return { ...view, clients: clients.map(out) };
}

function clientParam(params: Record<string, unknown>, key: string): ClientScope {
  return scopeInput({ client: params[key] ?? null }) ?? null;
}

function linkScope(link: StoredLink | null): ClientScope {
  return link ? { kind: link.kind, id: link.id } : null;
}

/**
 * `board-client-set { boardScope: { projectId, boardId }, client, expected }`: links the board to a client, or clears
 * the link (`client` null). Refusals write nothing. A clear with no link is `{ changed: false }`, nothing written.
 */
export async function setBoardClient(ctx: PluginContext, companyId: string, params: Record<string, unknown>, me: BoardPerson): Promise<{ changed: boolean; link: ClientRefOut | null }> {
  assertUnrestricted(me.restriction);
  if (!isOwnerOrAdminRole(me.role)) throw new StudioError("Only a company owner or admin can link a board to a client. Ask one of them to link this board.", OWNER_OR_ADMIN_ONLY);
  const board = boardScopeInput(params);
  if (!board?.boardId) throw new StudioError("boardScope.boardId is required to link a board.", "bad_board_scope");
  if (!("expected" in params)) throw new StudioError("expected is required: the link the panel showed (null for none).", "bad_request");
  const target = clientParam(params, "client");
  const expected = clientParam(params, "expected");
  await assertBoardCardsOn(new StudioConfig(ctx, companyId));

  const owner = await projectClientStrict(ctx, companyId, board.projectId);
  if (owner) throw new StudioError(`This board's project belongs to ${owner.name}, so the board uses ${owner.name}'s Studio files. To pick another client, unlink the project in the CRM first.`, PROJECT_CLIENT);

  let current: StoredLink | null;
  try {
    current = await latestBoardLink(ctx, companyId, board.boardId);
  } catch {
    throw boardClientUnavailable();
  }
  if (!sameClient(expected, linkScope(current))) {
    throw new StudioError(`Someone changed this board's client since the panel loaded: it is now ${current ? current.name || formatClientParam(current) : "own work"}. Nothing was changed; check the panel and pick again.`, LINK_CHANGED);
  }

  if (!target) {
    if (!current) return { changed: false, link: null };
    await insertLink(ctx, companyId, board.boardId, null, me.userId);
    return { changed: true, link: null };
  }
  let client;
  try {
    client = await resolveCrmClient(ctx, ctx.db.namespace, companyId, target);
  } catch {
    throw boardClientUnavailable();
  }
  if (!client) throw new StudioError(`Unknown client ${formatClientParam(target)}: it was deleted in the CRM, or hasn't synced to Studio yet.`, "unknown_client");
  await insertLink(ctx, companyId, board.boardId, client, me.userId);
  return { changed: true, link: out(client) };
}

/** One row per change: the client (or NULLs for a clear), the person, and the time (the column default). */
async function insertLink(ctx: PluginContext, companyId: string, boardId: string, client: { kind: string; id: string; name: string } | null, userId: string): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "board_client_links")} (company_id, board_id, client_kind, client_ref, client_name, user_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [companyId, boardId, client?.kind ?? null, client?.id ?? null, client?.name ?? null, userId],
  );
}
