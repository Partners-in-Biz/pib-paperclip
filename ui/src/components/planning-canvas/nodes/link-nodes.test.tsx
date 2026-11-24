// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", async () => {
  const { Link } = await import("react-router-dom");
  return { Link };
});
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";
import { CanvasRefsContext, type CanvasRefMap } from "@/components/planning-canvas/nodes/canvas-refs";
import type { NodeLinkMeta } from "@/components/planning-canvas/nodes/link-meta";
import { NodesLayer } from "@/components/planning-canvas/nodes/NodeView";

function node(id: string, y: number) {
  return { id, kind: "note", x: 0, y, width: 260, height: 140, zIndex: 1, color: "slate", title: "", content: "" };
}

function render(metas: Array<[string, NodeLinkMeta]>, refs: CanvasRefMap) {
  const c = {
    sortedNodes: metas.map(([id], i) => node(id, i * 200)),
    selectedNodeIds: [],
    editingNodeId: null,
    connectFromId: null,
    notesById: new Map(),
    opStore: { linkMeta: new Map(metas) },
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <CanvasRefContext.Provider value={{ current: c } as never}>
        <CanvasRefsContext.Provider value={refs}>
          <NodesLayer
            nodes={c.sortedNodes as never}
            selectedNodeIds={c.selectedNodeIds}
            editingNodeId={c.editingNodeId}
            connectFromId={c.connectFromId}
            notesById={c.notesById}
            linkMeta={c.opStore.linkMeta}
            typedMeta={undefined as never}
            lowDetail={false}
          />
        </CanvasRefsContext.Provider>
      </CanvasRefContext.Provider>
    </MemoryRouter>,
  );
}

const issueMeta = (refId: string, links: string[] = []): NodeLinkMeta => ({ refKind: "issue", refId, links });

describe("NodesLayer link nodes", () => {
  it("shows an issue card with its identifier, title and status", () => {
    const html = render(
      [["n1", issueMeta("i1")]],
      new Map([["i1", { id: "i1", identifier: "PAR-7", title: "Ship the canvas", status: "in_review" } as never]]),
    );
    expect(html).toContain("PAR-7");
    expect(html).toContain("Ship the canvas");
    expect(html).toContain("var(--status-task-in_review)");
  });

  it("shows No access for a hidden ref and Not loaded for an id past the refs cap", () => {
    const html = render(
      [["n1", issueMeta("i1")], ["n2", { refKind: "agent", refId: "a1", links: [] }]],
      new Map([["i1", { id: "i1", hidden: true }], ["a1", { id: "a1", notLoaded: true }]]),
    );
    expect(html).toContain("No access");
    expect(html).toContain("Not loaded");
    expect(html).not.toContain("Loading…");
  });

  it("shows Loading while a ref is unknown", () => {
    expect(render([["n1", issueMeta("i1")]], new Map())).toContain("Loading…");
  });

  it("shows one chip for every issue a node is linked to", () => {
    const refs: CanvasRefMap = new Map([
      ["l1", { id: "l1", identifier: "PAR-1", title: "One", status: "todo" } as never],
      ["l2", { id: "l2", identifier: "PAR-2", title: "Two", status: "done" } as never],
      ["l3", { id: "l3", hidden: true }],
    ]);
    const html = render([["n1", { refKind: null, refId: null, links: ["l1", "l2", "l3"] }]], refs);
    expect(html).toContain("PAR-1");
    expect(html).toContain("PAR-2");
    expect(html).toContain("No access");
    expect(html.match(/rounded-full border border-border/g)).toHaveLength(3);
  });
});
