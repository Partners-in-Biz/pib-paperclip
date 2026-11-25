// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/context/ThemeContext";
import { PLANNING_CANVAS_LIMITS, type PlanningCanvasTableData } from "@paperclipai/shared";

vi.mock("@/lib/router", () => ({ Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a> }));
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";
import { MarkdownNode } from "@/components/planning-canvas/nodes/MarkdownNode";
import { TableNode } from "@/components/planning-canvas/nodes/TableNode";
import * as edit from "@/components/planning-canvas/nodes/table-edit";
import { typedMetaOf } from "@/components/planning-canvas/nodes/typed-meta";
import { diffTableOps } from "@/components/planning-canvas/store/table-ops";

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>
        <CanvasRefContext.Provider value={{ current: {} } as never}>{node}</CanvasRefContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}
const md = (markdown: string) => wrap(<MarkdownNode nodeKey="m" title="" data={{ markdown }} />);

const table: PlanningCanvasTableData = {
  columns: [{ id: "c1", name: "Item", type: "text" }, { id: "c2", name: "Qty", type: "number" }],
  rows: [{ id: "r1", cells: { c1: "<b>x</b>", c2: 3 } }],
};

describe("untrusted markdown", () => {
  it("renders no element carrying an event handler for <img onerror>", () => {
    const html = md("<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>");
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });
  it("drops javascript: hrefs", () => {
    const html = md("[x](javascript:alert(1)) [y](JaVaScRiPt:alert(2))");
    expect(html.toLowerCase()).not.toContain("javascript:");
  });
  it("keeps mermaid click directives as inert source until Mermaid renders them", () => {
    const html = md('```mermaid\nflowchart TD\nA-->B\nclick A callback\nclick A href "javascript:alert(1)"\n```');
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
    expect(html).not.toMatch(/<a [^>]*href="javascript:/i);
  });
});

describe("table node", () => {
  it("renders cell text as input values, not HTML", () => {
    const html = wrap(<TableNode nodeKey="t" title="" data={table} />);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("Convert rows to issues");
  });
  it("edits cells, rows and columns, and the store sends them as table ops", () => {
    let data = edit.setCell(table, "r1", "c2", "7");
    expect(data.rows[0]!.cells.c2).toBe(7);
    data = edit.addRow(data);
    data = edit.addColumn(data);
    data = edit.removeColumn(data, "c1");
    const ops = diffTableOps("t", table, data)!;
    expect(ops.map((op) => op.op)).toEqual(expect.arrayContaining(["table.setCell", "table.addRow", "table.addColumn", "table.removeColumn"]));
    expect(ops.every((op) => op.op.startsWith("table."))).toBe(true);
  });
  it("refuses to pass the row and column caps", () => {
    const full: PlanningCanvasTableData = {
      columns: Array.from({ length: PLANNING_CANVAS_LIMITS.tableColumnsMax }, (_, i) => ({ id: `c${i}`, name: "", type: "text" as const })),
      rows: Array.from({ length: PLANNING_CANVAS_LIMITS.tableRowsMax }, (_, i) => ({ id: `r${i}`, cells: {} })),
    };
    expect(edit.addRow(full)).toBe(full);
    expect(edit.addColumn(full)).toBe(full);
    expect(edit.canAddRow(full)).toBe(false);
  });
  it("parses typed cells and caps their length", () => {
    expect(edit.parseCell("number", "4.5")).toBe(4.5);
    expect(edit.parseCell("number", "abc")).toBe("abc");
    expect(edit.parseCell("text", "")).toBeNull();
    expect((edit.parseCell("text", "x".repeat(20_000)) as string).length).toBe(edit.CELL_MAX_LENGTH);
  });
  it("reads typed meta from store items", () => {
    expect(typedMetaOf({ itemType: "node", fields: { kind: "table", data: table } })?.kind).toBe("table");
    expect(typedMetaOf({ itemType: "node", fields: { kind: "markdown", data: { markdown: "a" } } })?.kind).toBe("markdown");
    expect(typedMetaOf({ itemType: "node", fields: { kind: "note" } })).toBeNull();
  });
});
