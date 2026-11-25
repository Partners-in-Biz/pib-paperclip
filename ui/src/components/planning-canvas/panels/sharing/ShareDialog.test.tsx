// @vitest-environment node
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanningCanvasListItem } from "@/api/planningCanvases";
import { Dialog } from "@/components/ui/dialog";
import { ShareDialogBody } from "@/components/planning-canvas/panels/sharing/ShareDialog";

const base = {
  id: "b1", companyId: "c1", userId: "me", title: "Roadmap", description: "", data: { nodes: [], connectors: [] },
  createdAt: "", updatedAt: "", scope: "personal", projectId: null, memberAccess: "view", archivedAt: null, access: "admin",
} as unknown as PlanningCanvasListItem;

function render(board: PlanningCanvasListItem, userId: string) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Dialog open><ShareDialogBody open onOpenChange={() => {}} companyId="c1" board={board} userId={userId} projects={[]} agents={[]} onToast={() => {}} /></Dialog>
    </QueryClientProvider>,
  );
}

describe("ShareDialog", () => {
  it("shows Archive to an admin who is not the owner, and no widening", () => {
    const html = render({ ...base, scope: "company", memberAccess: "edit" } as PlanningCanvasListItem, "admin-user");
    expect(html).toContain("Archive");
    expect(html).toContain("Everyone with access will see all text on this board.");
  });

  it("hides archive from a caller below admin", () => {
    const html = render({ ...base, access: "edit" } as PlanningCanvasListItem, "other");
    expect(html).not.toContain(">Archive<");
  });

  it("offers Restore on an archived board", () => {
    expect(render({ ...base, archivedAt: "2026-11-23" } as PlanningCanvasListItem, "me")).toContain("Restore");
  });
});
