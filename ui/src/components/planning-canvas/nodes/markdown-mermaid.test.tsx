// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: "<svg data-mermaid></svg>" })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));
vi.mock("@/lib/router", () => ({ Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a> }));
import { ThemeProvider } from "@/context/ThemeContext";
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";
import { MarkdownNode } from "@/components/planning-canvas/nodes/MarkdownNode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.clearAllMocks());

describe("markdown node Mermaid", () => {
  it("renders through Mermaid with securityLevel strict and runs nothing from click directives", async () => {
    const source = 'flowchart TD\nA-->B\nclick A callback\nclick A href "javascript:alert(1)"';
    (window as unknown as { __ran?: boolean }).__ran = false;
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      createRoot(host).render(
        <QueryClientProvider client={new QueryClient()}>
          <ThemeProvider>
            <CanvasRefContext.Provider value={{ current: {} } as never}>
              <MarkdownNode nodeKey="m" title="" data={{ markdown: `\`\`\`mermaid\n${source}\n\`\`\`` }} />
            </CanvasRefContext.Provider>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalled());
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict" }));
    expect((window as unknown as { __ran?: boolean }).__ran).toBe(false);
    expect(host.querySelector("a[href^='javascript:' i]")).toBeNull();
  });
});
