// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

import { LinkedIssueChip } from "./LinkedIssueChip";

describe("LinkedIssueChip", () => {
  it("links to the issue and shows its live status", () => {
    const html = renderToStaticMarkup(
        <LinkedIssueChip issue={{ id: "i1", identifier: "PAR-7", title: "Sketch the flow", status: "in_progress", assigneeAgentId: "a1" }} />
    );
    expect(html).toContain("PAR-7");
    expect(html).toContain("Sketch the flow");
    expect(html).toContain("in progress");
    expect(html).toContain('href="/issues/PAR-7"');
  });

  it("shows no detail for a hidden issue", () => {
    const html = renderToStaticMarkup(<LinkedIssueChip issue={{ id: "i2", hidden: true }} />);
    expect(html).toContain("no access");
    expect(html).not.toContain("href");
  });
});
