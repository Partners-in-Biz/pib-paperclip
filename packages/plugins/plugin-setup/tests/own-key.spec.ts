import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OWN_KEY_ITEM, ownKeyItem, parseRuns } from "../src/own-key.js";
import { ItemRow } from "../src/ui/components.js";

const run = (adapterType: string, billingType: string | null, at: string) => ({ adapterType, createdAt: at, finishedAt: at, status: "succeeded", usageJson: billingType ? { billingType, inputTokens: 1 } : null });

describe("parseRuns", () => {
  it("keeps runs that report a billing type, newest first, from a bare list or a data envelope", () => {
    const rows = [run("claude_local", "subscription_included", "2026-10-24T10:00:00Z"), run("claude_local", "metered_api", "2026-10-25T10:00:00Z"), run("claude_local", null, "2026-10-26T10:00:00Z")];
    expect(parseRuns(rows)?.map((r) => r.billingType)).toEqual(["metered_api", "subscription_included"]);
    expect(parseRuns({ data: rows })).toHaveLength(2);
  });
  it("returns null for a body that is not a run list", () => {
    expect(parseRuns(null)).toBeNull();
    expect(parseRuns({ error: "x" })).toBeNull();
  });
});

describe("ownKeyItem", () => {
  const runs = (billingType: string, adapterType = "claude_local") => parseRuns([run(adapterType, billingType, "2026-10-25T10:00:00Z")]);

  it("is done for a client company whose latest Claude run was metered", () => {
    expect(ownKeyItem(runs("metered_api"), false)).toMatchObject({ key: OWN_KEY_ITEM, status: "done", title: "This company bills on its own key" });
  });
  it("warns for a client company whose latest Claude run used the subscription", () => {
    const item = ownKeyItem(runs("subscription_included"), false);
    expect(item?.status).toBe("missing");
    expect(item?.title).toContain("subscription");
    expect(item?.steps?.length).toBeGreaterThan(0);
  });
  it("uses the newest Claude run only, and ignores other adapters", () => {
    const list = parseRuns([run("claude_local", "metered_api", "2026-10-20T10:00:00Z"), run("claude_local", "subscription_included", "2026-10-25T10:00:00Z"), run("codex_local", "metered_api", "2026-10-26T10:00:00Z")]);
    expect(ownKeyItem(list, false)?.status).toBe("missing");
  });
  it("waits for a first run, and does not guess from an odd billing type", () => {
    expect(ownKeyItem([], false)?.status).toBe("unknown");
    expect(ownKeyItem(parseRuns([run("codex_local", "metered_api", "2026-10-25T10:00:00Z")]), false)?.status).toBe("unknown");
    expect(ownKeyItem(runs("credits"), false)?.status).toBe("unknown");
  });
  it("shows nothing for PiB's own company or when a read failed", () => {
    expect(ownKeyItem(runs("subscription_included"), true)).toBeNull();
    expect(ownKeyItem(runs("subscription_included"), null)).toBeNull();
    expect(ownKeyItem(null, false)).toBeNull();
  });
  it("renders as a checklist row", () => {
    const html = renderToStaticMarkup(createElement(ItemRow, { item: ownKeyItem(runs("subscription_included"), false)!, linkFor: (href: string) => ({ href }), first: true }));
    expect(html).toContain(`data-item="${OWN_KEY_ITEM}"`);
    expect(html).toContain("Partners in Biz");
  });
});
