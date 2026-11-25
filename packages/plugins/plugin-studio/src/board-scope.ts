/**
 * Studio media on Planning Canvas boards (PAR-14280; plan PAR-14257 B.2 D, C "Interfaces", G.1, G.2).
 *
 * A board asks with `boardScope { projectId | null }`. A project board maps to that project's client; a project with
 * no client, a company board and a personal board map to own work only. A file is signed for a board only when its
 * client is exactly the board's. That is stricter than `assertReachable`, which passes any file when the project has
 * no client. The id comes from the browser and can only narrow: without it the person path is unchanged, and a person
 * can already open any file he may see on Studio's own page. The same rule holds whoever wrote the node (a person or an
 * agent), because it runs when the card is drawn, not when it is placed.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sameClient, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { StudioConfig } from "./config.js";
import { StudioError } from "./errors.js";
import { clientOfProject } from "./scope.js";

export interface BoardScope {
  projectId: string | null;
}

/** What a board stands for: its client (null = own work), and one settings handle for the call. */
export interface BoardTarget {
  client: ClientScope;
  config: StudioConfig;
}

/** Studio's settings switch for board cards is off: every card is a placeholder. */
export const BOARD_CARDS_OFF = "board_cards_off";
/** The file's client is not the board's. */
export const WRONG_BOARD = "wrong_board";

/** `undefined`: no board in the call. Present but malformed is an error, never quietly "no board". */
export function boardScopeInput(params: Record<string, unknown>): BoardScope | undefined {
  if (!("boardScope" in params) || params.boardScope === undefined) return undefined;
  const raw = params.boardScope;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StudioError("boardScope must be { projectId } (null for a company or personal board).", "bad_board_scope");
  const projectId = (raw as Record<string, unknown>).projectId;
  if (projectId === null || projectId === undefined) return { projectId: null };
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 200) throw new StudioError("boardScope.projectId must be a project id or null.", "bad_board_scope");
  return { projectId: projectId.trim() };
}

/** Refuses the whole call when the switch is off (a failed settings read counts as off). */
export async function assertBoardCardsOn(config: StudioConfig): Promise<void> {
  if (!(await config.boardCardsOn())) throw new StudioError("Studio media on boards is switched off in Studio's settings.", BOARD_CARDS_OFF);
}

/** The board's client: the project's CRM client, or own work for a project without one and for every other board. */
export async function boardTarget(ctx: PluginContext, companyId: string, board: BoardScope, config = new StudioConfig(ctx, companyId)): Promise<BoardTarget & { clientName: string | null }> {
  await assertBoardCardsOn(config);
  const owner = await clientOfProject(ctx, companyId, board.projectId);
  return { client: owner ? { kind: owner.kind, id: owner.id } : null, clientName: owner?.name ?? null, config };
}

export function onBoard(asset: ClientScope, board: BoardTarget): boolean {
  return sameClient(asset, board.client);
}

/** A file that is gone from the board's point of view: no row, or archived on Studio's page. */
export const REMOVED_STATUSES: ReadonlySet<string> = new Set(["archived"]);
