import type { PlanningCanvasMemberAccess, PlanningCanvasScope } from "@paperclipai/shared";
import type { PlanningCanvasListItem } from "@/api/planningCanvases";

/** Pure sharing rules of the board UI (plan PAR-13925 Q15-Q17, D). The server decides; this only hides what would be refused. */

export const MEMBER_ACCESS_RANK: Record<PlanningCanvasMemberAccess, number> = { view: 0, comment: 1, edit: 2 };

export const MEMBER_ACCESS_LABEL: Record<PlanningCanvasMemberAccess, string> = {
  edit: "Can edit",
  comment: "Can comment",
  view: "Can view",
};

export const SCOPE_LABEL: Record<PlanningCanvasScope, string> = {
  personal: "Only me",
  company: "Everyone in the company",
  project: "People in one project",
};

export interface SharingTarget {
  scope: PlanningCanvasScope;
  projectId: string | null;
  memberAccess: PlanningCanvasMemberAccess;
}

export function currentSharing(board: PlanningCanvasListItem): SharingTarget {
  return { scope: board.scope ?? "personal", projectId: board.projectId ?? null, memberAccess: board.memberAccess ?? "view" };
}

export interface BoardPermissions {
  owner: boolean;
  /** Widen: the owner's alone (an ownerless board is the company admins'). */
  canWiden: boolean;
  /** Narrow, archive and restore: owner or admin. */
  canNarrow: boolean;
  canArchive: boolean;
}

export function boardPermissions(board: PlanningCanvasListItem, userId: string | null): BoardPermissions {
  const owner = userId !== null && board.userId === userId;
  const admin = board.access === "admin";
  const canWiden = owner || (board.userId === null && admin);
  const canNarrow = owner || admin;
  return { owner, canWiden, canNarrow, canArchive: canNarrow };
}

/** Mirrors `planningCanvasSharingWidens` on the server. */
export function sharingWidens(board: PlanningCanvasListItem, next: SharingTarget): boolean {
  const before = currentSharing(board);
  if (next.scope === "personal") return false;
  if (before.scope === "personal" || next.scope !== before.scope) return true;
  if (next.scope === "project" && before.projectId !== null && next.projectId !== before.projectId) return true;
  return MEMBER_ACCESS_RANK[next.memberAccess] > MEMBER_ACCESS_RANK[before.memberAccess];
}

export function sharingUnchanged(board: PlanningCanvasListItem, next: SharingTarget): boolean {
  const before = currentSharing(board);
  if (next.scope === "personal") return before.scope === "personal";
  return before.scope === next.scope && before.projectId === next.projectId && before.memberAccess === next.memberAccess;
}

/** The target is valid to send: a project board names its project, a shared one names its level. */
export function sharingSendable(next: SharingTarget): boolean {
  return next.scope !== "project" || next.projectId !== null;
}

/** One line shown before the owner confirms (Q15). */
export function sharingSummary(next: SharingTarget, projectName: string | null): string {
  if (next.scope === "personal") return "Only you will see this board.";
  const level = MEMBER_ACCESS_LABEL[next.memberAccess].toLowerCase().replace("can ", "");
  const who = next.scope === "company" ? "Everyone in the company" : `Everyone who can see ${projectName ?? "the project"}`;
  return `${who} will be able to ${level} this board.`;
}

export const SHARE_TEXT_NOTE = "Everyone with access will see all text on this board.";

export type BoardSectionId = "mine" | "company" | "project" | "archived";
export const BOARD_SECTIONS: Array<{ id: BoardSectionId; label: string }> = [
  { id: "mine", label: "Mine" },
  { id: "company", label: "Company" },
  { id: "project", label: "Project" },
  { id: "archived", label: "Archived" },
];

/** Sorted by scope: personal boards are Mine, shared ones sit under Company or Project (whoever owns them); archived boards have their own section. */
export function sectionOf(board: PlanningCanvasListItem): BoardSectionId {
  if (board.archivedAt) return "archived";
  if (board.scope === "company") return "company";
  if (board.scope === "project") return "project";
  return "mine";
}

export function groupBoards(boards: PlanningCanvasListItem[]) {
  const groups: Record<BoardSectionId, PlanningCanvasListItem[]> = { mine: [], company: [], project: [], archived: [] };
  for (const board of boards) groups[sectionOf(board)].push(board);
  return BOARD_SECTIONS.map((section) => ({ ...section, boards: groups[section.id] })).filter((section) => section.boards.length > 0);
}
