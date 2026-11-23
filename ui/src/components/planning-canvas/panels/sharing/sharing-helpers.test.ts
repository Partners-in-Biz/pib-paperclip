import { describe, expect, it } from "vitest";
import type { PlanningCanvasListItem } from "@/api/planningCanvases";
import {
  boardPermissions,
  groupBoards,
  sharingSummary,
  sharingUnchanged,
  sharingWidens,
} from "@/components/planning-canvas/panels/sharing/sharing-helpers";

function board(over: Partial<PlanningCanvasListItem> = {}): PlanningCanvasListItem {
  return {
    id: "b1", companyId: "c1", userId: "me", title: "B", description: "", data: { nodes: [], connectors: [] },
    createdAt: "", updatedAt: "", scope: "personal", projectId: null, memberAccess: "view", archivedAt: null, access: "admin",
    ...over,
  } as PlanningCanvasListItem;
}

describe("sharing helpers", () => {
  it("treats leaving personal and raising access as widening, lowering as narrowing", () => {
    expect(sharingWidens(board(), { scope: "company", projectId: null, memberAccess: "edit" })).toBe(true);
    const shared = board({ scope: "company", memberAccess: "edit" });
    expect(sharingWidens(shared, { scope: "company", projectId: null, memberAccess: "view" })).toBe(false);
    expect(sharingWidens(shared, { scope: "personal", projectId: null, memberAccess: "edit" })).toBe(false);
    expect(sharingWidens(shared, { scope: "project", projectId: "p", memberAccess: "edit" })).toBe(true);
    expect(sharingUnchanged(shared, { scope: "company", projectId: null, memberAccess: "edit" })).toBe(true);
  });

  it("gives only the owner widen, and owner or admin narrow, archive and restore", () => {
    expect(boardPermissions(board(), "me")).toMatchObject({ canWiden: true, canNarrow: true, canArchive: true });
    expect(boardPermissions(board({ access: "admin" }), "other")).toMatchObject({ canWiden: false, canNarrow: true, canArchive: true });
    expect(boardPermissions(board({ access: "edit" }), "other")).toMatchObject({ canWiden: false, canNarrow: false, canArchive: false });
    expect(boardPermissions(board({ userId: null, access: "admin" }), "other").canWiden).toBe(true);
  });

  it("states the access level the owner is about to grant", () => {
    expect(sharingSummary({ scope: "company", projectId: null, memberAccess: "edit" }, null)).toBe("Everyone in the company will be able to edit this board.");
  });

  it("groups boards into Mine, Company, Project and Archived", () => {
    const groups = groupBoards(
      [board({ id: "1" }), board({ id: "2", userId: "x", scope: "company" }), board({ id: "3", userId: "x", scope: "project" }), board({ id: "4", archivedAt: "t" })],
      "me",
    );
    expect(groups.map((g) => `${g.id}:${g.boards.map((b) => b.id)}`)).toEqual(["mine:1", "company:2", "project:3", "archived:4"]);
  });
});
