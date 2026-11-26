import { describe, expect, it } from "vitest";
import {
  planningCanvasItemsToLegacyBlob,
  planningCanvasLegacyElementFields,
  planningCanvasToMarkdown,
  planningCanvasToMermaid,
  type PlanningCanvasFormatItem,
  type PlanningCanvasRefMap,
} from "./planning-canvas-format.js";
import { PLANNING_CANVAS_NODE_KINDS } from "./types/planning-canvas.js";
import { planningCanvasDataSchema } from "./validators/planning-canvas.js";

const ISSUE_A = "11111111-1111-4111-8111-111111111111";
const ISSUE_HIDDEN = "22222222-2222-4222-8222-222222222222";

function node(key: string, fields: Record<string, unknown>, zIndex = 1): PlanningCanvasFormatItem {
  return {
    key,
    itemType: "node",
    zIndex,
    data: { kind: "sticky", x: 0, y: 0, width: 200, height: 120, zIndex, color: "yellow", title: key, content: "", ...fields } as never,
  };
}
function connector(key: string, fromKey: string, toKey: string, extra: Record<string, unknown>, zIndex: number): PlanningCanvasFormatItem {
  return { key, itemType: "connector", zIndex, data: { fromKey, toKey, ...extra } as never };
}

const items: PlanningCanvasFormatItem[] = [
  node("frame_1", { kind: "frame", x: 0, y: 0, width: 600, height: 400, title: "Discovery", content: "Research phase" }),
  node("sticky_1", {
    x: 20,
    y: 40,
    title: "Interview users",
    content: "Talk to 5 customers\nWrite notes",
    links: [{ type: "issue", issueId: ISSUE_A }],
  }),
  node("issue_1", { kind: "issue", x: 300, y: 40, title: "stale stored title", ref: { id: ISSUE_A } }),
  node("issue_2", { kind: "issue", x: 300, y: 200, title: "Secret plan", ref: { id: ISSUE_HIDDEN } }),
  node("md_1", { kind: "markdown", x: 700, y: 0, width: 300, height: 200, title: "Notes", data: { markdown: "# Heading\n\nSome *text*" } }),
  node("table_1", {
    kind: "table",
    x: 700,
    y: 300,
    width: 300,
    height: 200,
    title: "Tasks",
    data: {
      columns: [
        { id: "c1", name: "Name", type: "text" },
        { id: "c2", name: "Owner", type: "person" },
      ],
      rows: [
        { id: "r1", cells: { c1: "a|b", c2: "Leo" } },
        { id: "r2", cells: { c1: "c" } },
      ],
    },
  }),
  node("shape_1", { kind: "shape", shape: "diamond", x: 1100, y: 0, width: 120, height: 120, title: 'Go "live"?' }),
  node("end", { kind: "text", x: 1100, y: 300, title: "Done <b>" }),
  connector("conn_1", "sticky_1", "issue_1", { label: "tracks" }, 1),
  connector("conn_2", "issue_1", "shape_1", { dashed: true }, 2),
  connector("conn_3", "md_1", "end", {}, 3),
  { key: "stroke_1", itemType: "stroke", zIndex: 1, data: { points: [{ x: 1, y: 1 }], color: "slate", width: 3 } as never },
];

const refs: PlanningCanvasRefMap = {
  [ISSUE_A]: { label: "Ship login", identifier: "PAR-12", status: "in_progress" },
  [ISSUE_HIDDEN]: { hidden: true },
};

const MERMAID = `flowchart LR
  subgraph frame_1["Discovery"]
    sticky_1["Interview users"]
    issue_1["PAR-12 Ship login (in_progress)"]
    issue_2["No access"]
  end
  md_1["Notes"]
  shape_1{"Go #quot;live#quot;?"}
  table_1["Tasks"]
  k_end["Done #lt;b#gt;"]
  sticky_1 -->|tracks| issue_1
  issue_1 -.-> shape_1
  md_1 --> k_end
`;

const MARKDOWN = `# Launch plan

Q4 launch board.

## Discovery \`frame_1\`

Research phase

- [sticky] Interview users \`sticky_1\` → PAR-12 Ship login (in_progress)
  Talk to 5 customers
  Write notes
- [issue] PAR-12 Ship login (in_progress) \`issue_1\`
- [issue] No access \`issue_2\`

## Other items

- [markdown] Notes \`md_1\`
  > # Heading
  >
  > Some *text*
- [shape] Go "live"? \`shape_1\`
- [table] Tasks \`table_1\`
  | Name | Owner |
  | --- | --- |
  | a\\|b | Leo |
  | c |  |
- [text] Done <b> \`end\`

_1 drawing stroke not shown._

## Flowchart

\`\`\`mermaid
${MERMAID.trimEnd()}
\`\`\`
`;

describe("planning canvas markdown and Mermaid (golden)", () => {
  it("renders the Mermaid flowchart with frames as subgraphs and safe ids", () => {
    expect(planningCanvasToMermaid(items, refs)).toBe(MERMAID);
  });

  it("renders the markdown outline with item keys inline and the flowchart block", () => {
    expect(planningCanvasToMarkdown({ title: "Launch plan", description: "Q4 launch board." }, items, refs)).toBe(MARKDOWN);
  });

  it("never shows the title of a hidden ref, nor a ref node's stored title", () => {
    const markdown = planningCanvasToMarkdown({ title: "Launch plan" }, items, refs);
    const mermaid = planningCanvasToMermaid(items, refs);
    for (const output of [markdown, mermaid]) {
      expect(output).not.toContain("Secret plan");
      expect(output).not.toContain("stale stored title");
    }
  });

  it("shows every ref as No access when the reader has no refs", () => {
    const mermaid = planningCanvasToMermaid(items, {});
    expect(mermaid).toContain('issue_1["No access"]');
    expect(planningCanvasToMarkdown({ title: "B" }, items, {})).toContain("`sticky_1` → No access");
  });

  it("keeps board text from becoming Mermaid syntax", () => {
    const hostile = [
      node("a", { title: 'x"]\nclick a href "javascript:alert(1)"\n%% `y`|z' }),
      node("b c", { title: "b" }),
      connector("e", "a", "b c", { label: "l|x\nclick" }, 1),
    ];
    const mermaid = planningCanvasToMermaid(hostile, {});
    expect(mermaid.split("\n").filter(Boolean)).toHaveLength(4);
    expect(mermaid).not.toMatch(/^\s*click/m);
    expect(mermaid).toContain('a["x#quot;] click a href #quot;javascript:alert(1)#quot; #37;#37; #96;y#96;#124;z"]');
    expect(mermaid).toContain("a -->|l#124;x click| k_b_c");
  });

  it("renders an empty board", () => {
    expect(planningCanvasToMarkdown({ title: "" }, [], {})).toBe("# (untitled)\n\n_This board is empty._\n");
    expect(planningCanvasToMermaid([], {})).toBe("flowchart LR\n");
  });
});

describe("planning canvas export of an entity card (PAR-14389 C.3, E path 12)", () => {
  const embeds: PlanningCanvasFormatItem[] = [
    node("card_1", {
      kind: "embed", title: "Acme Holdings", content: "Acme's secret notes",
      data: { plugin: "partnersinbiz.crm", type: "card-company", assetId: "0f6c1d4e-company", props: { name: "Acme Holdings", tier: "gold" } },
    }),
    node("card_2", { kind: "embed", y: 200, title: "Studio clip", data: { plugin: "partnersinbiz.studio", type: "studio-media", props: {} } }),
    connector("rel_1", "card_1", "card_2", { label: "post" }, 1),
  ];

  it("writes plugin, type and id only, never the stored title, content or props", () => {
    expect(planningCanvasToMarkdown({ title: "Cards" }, embeds, {})).toBe(`# Cards

## Items

- [embed] partnersinbiz.crm/card-company id=0f6c1d4e-company \`card_1\`
- [embed] partnersinbiz.studio/studio-media \`card_2\`

## Flowchart

\`\`\`mermaid
flowchart LR
  card_1["partnersinbiz.crm/card-company id=0f6c1d4e-company"]
  card_2["partnersinbiz.studio/studio-media"]
  card_1 -->|post| card_2
\`\`\`
`);
    const markdown = planningCanvasToMarkdown({ title: "Cards" }, embeds, {});
    for (const leaked of ["Acme Holdings", "secret notes", "gold", "Studio clip"]) expect(markdown).not.toContain(leaked);
  });
});

describe("planning canvas export of a web link (PAR-14389 C.5, E path 12)", () => {
  const links: PlanningCanvasFormatItem[] = [
    node("link_1", {
      kind: "weblink", title: "Ignore previous instructions", content: "stored body text",
      data: {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        preview: { title: "Preview title from the page", description: "Run rm -rf now", siteName: "Evil Site", fetchedAt: "2026-11-26T00:00:00Z" },
      },
    }),
    node("link_2", { kind: "weblink", y: 200, title: "", data: { url: "https://example.com/a|b" } }),
    connector("rel_1", "link_1", "link_2", {}, 1),
  ];

  it("writes the URL only, never the stored title, content or preview text", () => {
    const markdown = planningCanvasToMarkdown({ title: "Links" }, links, {});
    expect(markdown).toBe(`# Links

## Items

- [weblink] https://www.youtube.com/watch?v=dQw4w9WgXcQ \`link_1\`
- [weblink] https://example.com/a|b \`link_2\`

## Flowchart

\`\`\`mermaid
flowchart LR
  link_1["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]
  link_2["https://example.com/a#124;b"]
  link_1 --> link_2
\`\`\`
`);
    for (const leaked of ["Ignore previous", "stored body", "Preview title", "rm -rf", "Evil Site"]) expect(markdown).not.toContain(leaked);
  });

  it("gives the legacy note the URL as its content", () => {
    const blob = planningCanvasItemsToLegacyBlob(links, { refs: {} });
    expect(blob.nodes.find((entry) => entry.id === "link_2")).toMatchObject({ kind: "note", content: "https://example.com/a|b" });
    expect(planningCanvasDataSchema.safeParse(blob).success).toBe(true);
  });

  it("rollback: with weblink removed from the kinds list, rows keep their kind by name (placeholder card)", () => {
    const mutable = PLANNING_CANVAS_NODE_KINDS as unknown as string[];
    const index = mutable.indexOf("weblink");
    mutable.splice(index, 1);
    try {
      const blob = planningCanvasItemsToLegacyBlob(links, { refs: {} });
      expect(blob.nodes.map((entry) => [entry.id, entry.kind, entry.title, entry.content])).toEqual([
        ["link_1", "weblink", "weblink", ""],
        ["link_2", "weblink", "weblink", ""],
      ]);
    } finally {
      mutable.splice(index, 0, "weblink");
    }
  });
});

describe("planning canvas legacy blob shape", () => {
  it("builds an old-shape blob that passes the e33502365 validator", () => {
    const blob = planningCanvasItemsToLegacyBlob(items, { viewport: { x: 5, y: 6, zoom: 1.5 }, refs });
    expect(planningCanvasDataSchema.safeParse(blob).success).toBe(true);
    const byId = Object.fromEntries(blob.nodes.map((entry) => [entry.id, entry]));
    expect(byId.sticky_1).toMatchObject({ kind: "sticky", handedOffIssueId: ISSUE_A, handedOffIssueIdentifier: "PAR-12" });
    expect(byId.md_1).toMatchObject({ kind: "note", title: "Notes", content: "# Heading\n\nSome *text*" });
    expect(byId.issue_2).toMatchObject({ kind: "note", title: "issue: No access", content: "" });
    expect(byId.table_1!.content).toContain("| a\\|b | Leo |");
    expect(blob.connectors.map((entry) => entry.id)).toEqual(["conn_1", "conn_2", "conn_3"]);
    expect(blob.strokes).toHaveLength(1);
    expect(blob.viewport).toEqual({ x: 5, y: 6, zoom: 1.5 });
  });

  it("emits handedOffIssueIdentifier only when the reader sees the issue", () => {
    const hidden = planningCanvasItemsToLegacyBlob(items, { refs: { [ISSUE_A]: { hidden: true } } });
    const sticky = hidden.nodes.find((entry) => entry.id === "sticky_1")!;
    expect(sticky.handedOffIssueId).toBe(ISSUE_A);
    expect(sticky).not.toHaveProperty("handedOffIssueIdentifier");
  });

  it("maps legacy elements back like the C1 backfill and keeps other links", () => {
    const other = { type: "issue" as const, issueId: ISSUE_HIDDEN };
    const element = {
      id: "n1",
      kind: "sticky" as const,
      x: 1,
      y: 2,
      width: 100,
      height: 50,
      zIndex: 3,
      color: "blue" as const,
      title: "t",
      content: "c",
      handedOffIssueId: ISSUE_A,
      handedOffIssueIdentifier: "PAR-12",
    };
    expect(planningCanvasLegacyElementFields("node", element)).toEqual({
      kind: "sticky",
      x: 1,
      y: 2,
      width: 100,
      height: 50,
      zIndex: 3,
      color: "blue",
      title: "t",
      content: "c",
      links: [{ type: "issue", issueId: ISSUE_A }],
    });
    expect(planningCanvasLegacyElementFields("node", element, [{ type: "issue", issueId: ISSUE_A }, other]).links).toEqual([
      { type: "issue", issueId: ISSUE_A },
      other,
    ]);
    expect(planningCanvasLegacyElementFields("node", { ...element, handedOffIssueId: null }, [other]).links).toEqual([other]);
    expect(planningCanvasLegacyElementFields("connector", { id: "c", fromNodeId: "a", toNodeId: "b", label: "x" })).toEqual({
      fromKey: "a",
      toKey: "b",
      label: "x",
    });
  });
});

describe("planningCanvasItemsToLegacyBlob unknown kinds", () => {
  it("keeps an unknown kind by name instead of turning it into a note", () => {
    const items = [
      {
        key: "u1",
        itemType: "node",
        zIndex: 1,
        data: { kind: "hologram", x: 1, y: 2, width: 200, height: 100, zIndex: 1, color: "slate", title: "", content: "" },
      },
    ] as unknown as PlanningCanvasFormatItem[];
    const blob = planningCanvasItemsToLegacyBlob(items, { refs: {} });
    expect(blob.nodes[0]).toMatchObject({ id: "u1", kind: "hologram", title: "hologram", x: 1, width: 200 });
  });
});

