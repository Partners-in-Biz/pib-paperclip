import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { companyInfo } from "../src/service/common.js";
import { addNeedsYou, onNeedsYouIssueUpdated } from "../src/service/needs-you.js";
import { seoHost, SPRINT, type Route, type Row } from "./helpers/seo-host.js";

// One Needs you issue per week for the whole company (PAR-7031): every sprint's items grouped by client.
const SPRINT_2: Row = { ...SPRINT, id: "sp-2", name: "Beta", site_url: "https://beta.co.za", site_name: "Beta Bakery", client_ref: "crm-2", client_name: "Beta Bakery (Pty) Ltd" };

const item = (key: string, title: string, check = "manual", status = "open"): Row => ({
  key, kind: "grant", title, why: "why", steps: [], links: [], after: "after", check, taskIds: [], status, addedAt: "2026-09-29T00:00:00Z",
});

const digest = (sprintId: string, items: Row[], issueId: string | null, status = "open"): Row => ({
  id: `ny-${sprintId}`, company_id: "co-1", sprint_id: sprintId, week_start: "2026-09-28", issue_id: issueId, issue_identifier: issueId ? "PIB-9" : null, items, status,
});

function world(digests: Row[], issueStatus = "todo") {
  const routes: Route[] = [
    [/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1/, (p) => [p[0] === "sp-2" ? SPRINT_2 : SPRINT]],
    [/needs_you WHERE company_id = \$1 AND week_start = /, () => digests],
    [/needs_you WHERE company_id = \$1 AND issue_id = \$2/, () => digests],
    [/needs_you WHERE company_id = \$1 AND sprint_id = \$2 AND week_start = /, (p) => digests.filter((d) => d.sprint_id === p[1])],
  ];
  const h = seoHost({ routes });
  h.ctx.issues.get = (async (id: string) => ({ id, status: issueStatus, identifier: "PIB-9" })) as never;
  return h;
}

const savedFor = (h: ReturnType<typeof world>, sprintId: string) =>
  h.executes.filter((e) => /INSERT INTO plugin_seo_8099f8879a\.needs_you /.test(e.sql) && e.params[2] === sprintId);

describe("one weekly Needs you issue", () => {
  it("opens a single issue 'SEO week of <date>' with no client prefix, and no per-sprint title", async () => {
    const h = world([digest("sp-1", [], null)]);
    const info = await companyInfo(h.env, "co-1");
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    await addNeedsYou(h.env, info, sprint, { key: "k1", kind: "grant", title: "Link the repo", why: "w", steps: [], links: [], after: "a", check: "manual", taskIds: [] });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.input.title).toBe("SEO week of 2026-09-28");
    expect(h.created[0]!.input.originId).toBe("weekly:2026-09-28");
    expect(String(h.created[0]!.input.description)).toContain("## Acme Accounting");
  });

  it("a second sprint joins the first one's issue and the description groups the items by client", async () => {
    const acme = digest("sp-1", [item("a1", "Acme grant")], "wk-issue");
    const beta = digest("sp-2", [], null);
    const h = world([acme, beta]);
    const info = await companyInfo(h.env, "co-1");
    const sprint2 = (await db.getSprint(h.env.ctx.db, "co-1", "sp-2"))!;
    const result = await addNeedsYou(h.env, info, sprint2, { key: "b1", kind: "grant", title: "Beta grant", why: "w", steps: [], links: [], after: "a", check: "manual", taskIds: [] });
    expect(h.created).toHaveLength(0); // no second issue
    expect(result.issueId).toBe("wk-issue");
    const patch = h.updates.find((u) => u.id === "wk-issue")!.patch;
    const text = String(patch.description);
    expect(text.indexOf("## Acme Accounting")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("## Beta Bakery")).toBeGreaterThan(text.indexOf("## Acme Accounting"));
    expect(text.indexOf("Acme grant")).toBeLessThan(text.indexOf("## Beta Bakery"));
    expect(text.indexOf("Beta grant")).toBeGreaterThan(text.indexOf("## Beta Bakery"));
    expect(h.executes.some((e) => /UPDATE plugin_seo_8099f8879a\.needs_you SET issue_id/.test(e.sql) && e.params[2] === "ny-sp-2")).toBe(true); // sp-2 now points at it
  });

  it("closing it marks nothing done: manual items stay open and it reopens with a comment naming each client's count", async () => {
    const acme = digest("sp-1", [item("a1", "Acme grant")], "wk-issue");
    const beta = digest("sp-2", [item("b1", "Beta grant"), item("b2", "Beta login")], "wk-issue");
    const h = world([acme, beta], "done");
    expect(await onNeedsYouIssueUpdated(h.env, "co-1", "wk-issue")).toBe(true);
    for (const saved of [...savedFor(h, "sp-1"), ...savedFor(h, "sp-2")]) {
      expect((JSON.parse(String(saved.params[4])) as Row[]).every((i) => i.status === "open")).toBe(true);
    }
    const reopened = h.comments.find((c) => c.id === "wk-issue" && /Reopened/.test(c.body))!;
    expect(reopened.body).toContain("Acme Accounting (Acme Accounting (Pty) Ltd): 1");
    expect(reopened.body).toContain("Beta Bakery (Beta Bakery (Pty) Ltd): 2");
    expect(reopened.body).not.toContain("Beta grant");
    expect(h.updates.some((u) => u.id === "wk-issue" && u.patch.status === "todo")).toBe(true);
  });

  it("the new issue is in no client's project", async () => {
    const h = world([digest("sp-1", [], null)]);
    const info = await companyInfo(h.env, "co-1");
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    await addNeedsYou(h.env, info, sprint, { key: "k1", kind: "grant", title: "Link the repo", why: "w", steps: [], links: [], after: "a", check: "manual", taskIds: [] });
    expect(h.created[0]!.input.projectId).toBeUndefined();
  });

  it("an issue linked to one sprint alone shows only that client, never a sibling with its own issue", async () => {
    const acme = digest("sp-1", [item("a0", "Acme first")], "acme-issue");
    const beta = digest("sp-2", [item("b1", "Beta grant")], "beta-issue");
    const h = world([acme, beta]);
    const info = await companyInfo(h.env, "co-1");
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    await addNeedsYou(h.env, info, sprint, { key: "a1", kind: "grant", title: "Acme second", why: "w", steps: [], links: [], after: "a", check: "manual", taskIds: [] });
    const text = String(h.updates.find((u) => u.id === "acme-issue")!.patch.description);
    expect(text).toContain("## Acme Accounting");
    expect(text).not.toContain("Beta");
    expect(h.updates.some((u) => u.id === "beta-issue")).toBe(false);
  });

  it("summarises instead of copying every item: steps and copy stay on the page, long lists are cut", async () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ ...item(`k${n}`, `Item ${n}`), steps: ["SECRET STEP"], copy: "COPY TEXT" }));
    const h = world([digest("sp-1", many, "wk-issue")]);
    const info = await companyInfo(h.env, "co-1");
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    await addNeedsYou(h.env, info, sprint, { key: "new", kind: "grant", title: "Item new", why: "w", steps: [], links: [], after: "a", check: "manual", taskIds: [] });
    const text = String(h.updates.find((u) => u.id === "wk-issue")!.patch.description);
    expect(text).toContain("**13 open**");
    expect(text).toContain("- Item 4");
    expect(text).not.toContain("- Item 5");
    expect(text).toContain("- and 8 more");
    expect(text).not.toContain("SECRET STEP");
    expect(text).not.toContain("COPY TEXT");
  });

  it("does nothing when every digest sharing the issue is already done", async () => {
    const h = world([digest("sp-1", [item("a1", "Acme grant", "manual", "done")], "wk-issue", "done")], "done");
    expect(await onNeedsYouIssueUpdated(h.env, "co-1", "wk-issue")).toBe(true);
    expect(h.executes).toHaveLength(0);
    expect(h.comments).toHaveLength(0);
  });
});
