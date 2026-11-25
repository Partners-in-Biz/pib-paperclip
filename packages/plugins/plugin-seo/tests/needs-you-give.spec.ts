/**
 * Give to agent on the SEO page's Needs you list: only items the SEO agent can do get the button, a press hands them back
 * (task comments or one issue), and needs-you-add refuses page changes the agent can make itself.
 */
import { describe, expect, it } from "vitest";
import { agentInstruction, agentRouteFor, type HandoffSite } from "../src/engine/needs-you-handoff.js";
import type { NeedsYouItem } from "../src/engine/needs-you.js";
import { companyInfo, type Actor } from "../src/service/common.js";
import { dispatch, HANDLERS, UI_ONLY_HANDLERS } from "../src/dispatch.js";
import * as db from "../src/db.js";
import { needsYouView } from "../src/service/needs-you.js";
import { sprintFor, world } from "./helpers/rehearsal-world.js";
import { taskRow, type Route, type Row } from "./helpers/seo-host.js";

const user: Actor = { kind: "user", userId: "user-peet" };
const agentActor: Actor = { kind: "agent", agentId: "agent-seo", runId: "run-1", responsibleUserId: "user-peet" };

const AGRI: HandoffSite = { siteAccess: "wordpress", changePolicy: "pr_only", clientSignoff: "auto", connectorConnected: true, sftp: false };
const it_ = (key: string, title: string, extra: Partial<NeedsYouItem> = {}) => ({ key, kind: "task" as const, title, check: "manual" as const, status: "open" as const, ...extra });

describe("which items the agent can do", () => {
  // The Agri Studies list of 2026-11-08, item by item.
  const cases: Array<[string, string, string | null]> = [
    ["task:2b9e", "Set up Google Merchant Center free listings (product feed)", null],
    ["par131-duplicate-og-plugin", "Deactivate the redundant Open Graph & Twitter Card Tags plugin on agristudies.co.za", null],
    ["cwv_lcp_optimization", "Fix LCP (fails 2.5s target) on Agri Studies core pages: install + configure a Caching / JS-CSS optimization plugin", null],
    ["product-share-icon-alt", "Add empty alt to decorative Share icon on all product pages (62)", null],
    ["approval-email:seo-approval:x", "Send the approval email to the client (1 page)", null],
    ["apply:par-2368:oct6-four", "Open the apply window for 4 approved Agri Studies product pages", null],
    ["cwv_home_lcp_v2", "Fix homepage LCP on agristudies.co.za: compress banner + defer third-party scripts (replaces cwv_home_lcp)", null],
    ["task:0d21", "Write the top 5 category pages (unique intro, FAQ, links)", "content"],
    ["wp-change:PAR-5534", "Apply hydroponics course page refresh (postId 97)", "content"],
    ["task:2d0b", 'Refresh the page for "hydroponics course"', "content"],
    ["task:fb04", 'Add 3 internal links to the "cattle farming course" page', "content"],
    ["task:category-pages-approve-change-set-4", "Category pages: approve change set (4 categories exist, not 5)", "content"],
    ["par-7468-crop-production-refresh", "Approve page refresh: crop production course (Agri Studies)", "content"],
    ["review-stalled:KVeL", "A preview has waited for the Reviewer through 3 tries: https://agristudies.co.za/", "review"],
    ["page-skipped:0d21:x", "Skipped after 2 failed previews: https://agristudies.co.za/product/poultry-production-course/", "retry"],
  ];
  for (const [key, title, route] of cases) {
    it(`${route ?? "person"}: ${title.slice(0, 60)}`, () => {
      expect(agentRouteFor(it_(key, title), AGRI)).toBe(route);
    });
  }

  it("never offers a grant, a PR, a message, a review of the playbook or an item the plugin checks itself", () => {
    expect(agentRouteFor(it_("x", "Refresh the page for x", { kind: "grant" }), AGRI)).toBeNull();
    expect(agentRouteFor(it_("pr:x", "Refresh the page for x", { kind: "pr" }), AGRI)).toBeNull();
    expect(agentRouteFor(it_("playbook_changes", "Keep or discard 1 learned SEO playbook change", { kind: "review", check: "playbook_decided" as never }), AGRI)).toBeNull();
    expect(agentRouteFor(it_("x", "Refresh the page for x", { check: "task_done" as never }), AGRI)).toBeNull();
    expect(agentRouteFor(it_("x", "Refresh the page for x", { status: "done" }), AGRI)).toBeNull();
  });

  it("a pr_only site with manual client sign-off keeps its change sets on Needs you (the person approves them)", () => {
    expect(agentRouteFor(it_("x", 'Refresh the page for "x"'), { ...AGRI, clientSignoff: "manual" })).toBeNull();
    expect(agentRouteFor(it_("x", 'Refresh the page for "x"'), { ...AGRI, changePolicy: "merge_seo_scope", clientSignoff: "manual" })).toBe("content");
  });

  it("no Connector or no site link: nothing to write with", () => {
    expect(agentRouteFor(it_("x", 'Refresh the page for "x"'), { ...AGRI, connectorConnected: false })).toBeNull();
    expect(agentRouteFor(it_("x", 'Refresh the page for "x"'), { ...AGRI, siteAccess: "none" })).toBeNull();
    expect(agentRouteFor(it_("page-skipped:x", "Skipped after 2 failed previews: x"), { ...AGRI, siteAccess: "unlinked" })).toBeNull();
    expect(agentRouteFor(it_("x", 'Refresh the page for "x"'), { ...AGRI, siteAccess: "repo", connectorConnected: false })).toBe("content");
  });

  it("template markup is the agent's only with an SFTP login", () => {
    const alt = it_("product-share-icon-alt", "Add empty alt to decorative Share icon on all product pages (62)");
    expect(agentRouteFor(alt, AGRI)).toBeNull();
    expect(agentRouteFor(alt, { ...AGRI, sftp: true })).toBe("theme");
  });

  it("tells the agent to go through the client preview on a pr_only site, and to apply directly elsewhere", () => {
    expect(agentInstruction("content", AGRI, "sp-1")).toContain("create-preview");
    expect(agentInstruction("content", AGRI, "sp-1")).toContain("Never write to the live page before the client approved it");
    expect(agentInstruction("content", { ...AGRI, changePolicy: "merge_seo_scope" }, "sp-1")).toContain("Apply it yourself through the Connector");
    for (const route of ["content", "review", "retry", "theme"] as const) expect(agentInstruction(route, AGRI, "sp-1")).toContain("Do not put this back on Needs you");
  });
});

// ---------------------------------------------------------------------------

const WEEK = "2026-09-28"; // the Monday of the test clock's 2026-10-03
const wpSprint = (extra: Row = {}) => sprintFor("real", { site_access: "wordpress", site_id: "site-1", change_policy: "pr_only", client_signoff: "auto", client_project_id: "proj-agri", ...extra });
const crmSite: Row = { id: "site-1", company_id: "co-1", client_kind: "company", url: "https://agristudies.co.za", label: null, connector_status: "connected", connector_seen_at: null, access: ["connector"], deleted: false };
const sites: Route = [/FROM plugin_seo_8099f8879a\.crm_sites/, () => [crmSite]];
const item = (key: string, title: string, extra: Row = {}): Row => ({ key, kind: "task", title, why: "why it waits", steps: ["step one"], links: [], after: "after", check: "manual", taskIds: [], status: "open", addedAt: "2026-09-29T00:00:00Z", ...extra });
const digestRow = (items: Row[]): Row => ({ id: "ny-1", company_id: "co-1", sprint_id: "sp-real", week_start: WEEK, issue_id: "wk-1", issue_identifier: "PIB-9", items, status: "open" });

function setup(items: Row[], tasks: Row[] = [], agent: { id: string; status: string } | null = { id: "agent-seo", status: "idle" }) {
  const w = world({ sprints: [wpSprint()], tasks, needsYouRecent: [digestRow(items)], routes: [sites], agent });
  return w;
}
const itemsNow = (w: ReturnType<typeof world>) => (w.needsYou.find((r) => r.id === "ny-1")!.items as Row[]);

describe("the Needs you view", () => {
  it("marks the items the agent can do", async () => {
    const w = setup([item("og", "Deactivate the redundant Open Graph plugin"), item("task:a", 'Refresh the page for "hydroponics course"')]);
    const sprint = (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!;
    const view = await needsYouView(w.env, await companyInfo(w.env, "co-1"), sprint);
    expect(view.open.map((i) => [i.key, i.agent])).toEqual([["og", null], ["task:a", "content"]]);
  });
});

describe("needs-you-give", () => {
  it("is a page button for people, not an agent tool", async () => {
    expect(UI_ONLY_HANDLERS["needs-you-give"]).toBeDefined();
    expect(HANDLERS["needs-you-give"]).toBeUndefined();
    const w = setup([item("task:a", 'Refresh the page for "x"')]);
    await expect(dispatch(w.env, "co-1", agentActor, "needs-you-give", { sprintId: "sp-real", all: true })).rejects.toThrow(/people/);
  });

  it("refuses an item only a person can do, and changes nothing", async () => {
    const w = setup([item("og", "Deactivate the redundant Open Graph plugin")]);
    await expect(dispatch(w.env, "co-1", user, "needs-you-give", { sprintId: "sp-real", key: "og" })).rejects.toThrow(/Only a person/);
    expect(itemsNow(w)[0]!.status).toBe("open");
    expect(w.created).toHaveLength(0);
  });

  it("all: closes every item the agent can do, hands its waiting task back with the instructions, and puts the rest in one issue in the client's project", async () => {
    const task = taskRow({ id: "t-hydro", sprint_id: "sp-real", status: "blocked", issue_id: "iss-hydro", assignee_kind: "needs_you", blocker_reason: "Waiting on you" });
    const w = setup(
      [
        item("og", "Deactivate the redundant Open Graph plugin"),
        item("task:t-hydro", 'Refresh the page for "hydroponics course"', { taskIds: ["t-hydro"] }),
        item("wp-change:PAR-5534", "Apply hydroponics course page refresh (postId 97)", { taskIds: ["t-hydro"] }),
        item("review-stalled:p1", "A preview has waited for the Reviewer through 3 tries: https://agristudies.co.za/"),
        item("par-7468", "Approve page refresh: crop production course (Agri Studies)"),
      ],
      [task],
    );
    const out = (await dispatch(w.env, "co-1", user, "needs-you-give", { sprintId: "sp-real", all: true })) as Record<string, unknown>;
    expect(out).toMatchObject({ given: 4, tasksResumed: 1, stillNeedYou: 1 });

    const after = itemsNow(w);
    expect(after.find((i) => i.key === "og")!.status).toBe("open");
    expect(after.filter((i) => i.status === "done").map((i) => i.doneBy)).toEqual(Array(4).fill("user user-peet, given to the SEO Specialist"));

    // The task goes back to the agent once, with both items that named it.
    expect(w.updates.find((u) => u.id === "iss-hydro")!.patch).toMatchObject({ status: "todo", assigneeAgentId: "agent-seo" });
    const comment = w.comments.find((c) => c.id === "iss-hydro")!.body;
    expect(comment).toContain('Refresh the page for "hydroponics course"');
    expect(comment).toContain("Apply hydroponics course page refresh");
    expect(comment).toContain("create-preview");
    expect(w.wakeups).toContain("iss-hydro");
    expect(w.store.tasks.find((t) => t.id === "t-hydro")).toMatchObject({ status: "in_progress", assignee_kind: "agent", blocker_reason: null });

    // The two without a task: one issue for the agent, in the client's project.
    expect(w.created).toHaveLength(1);
    const issue = w.created[0]!.input;
    expect(issue).toMatchObject({ assigneeAgentId: "agent-seo", projectId: "proj-agri", title: "Needs you items given back to you: Agri Studies (2)" });
    expect(String(issue.description)).toContain("A preview has waited for the Reviewer");
    expect(String(issue.description)).toContain("Approve page refresh: crop production course");
    expect(String(issue.description)).not.toContain("Open Graph");
  });

  it("one item without a task becomes one issue named after it", async () => {
    const w = setup([item("par-7468", "Approve page refresh: crop production course (Agri Studies)")]);
    await dispatch(w.env, "co-1", user, "needs-you-give", { sprintId: "sp-real", key: "par-7468" });
    expect(w.created[0]!.input.title).toBe("Do it yourself: Approve page refresh: crop production course (Agri Studies)");
  });

  it("hands nothing over when the SEO Specialist is paused", async () => {
    const w = setup([item("task:a", 'Refresh the page for "x"')], [], { id: "agent-seo", status: "paused" });
    await expect(dispatch(w.env, "co-1", user, "needs-you-give", { sprintId: "sp-real", all: true })).rejects.toThrow(/not available/);
    expect(itemsNow(w)[0]!.status).toBe("open");
  });
});

describe("needs-you-add refuses page changes the agent can make", () => {
  it("refuses one, and lets it through with personOnly (kept on the item)", async () => {
    const w = setup([]);
    const params = { sprintId: "sp-real", kind: "task", key: "wp-change:x", title: "Apply refresh for \"cattle farming course\" on the beef page", why: "pr_only site", after: "verify" };
    await expect(dispatch(w.env, "co-1", agentActor, "needs-you-add", params)).rejects.toThrow(/you can do this yourself.*create-preview/s);
    await dispatch(w.env, "co-1", agentActor, "needs-you-add", { ...params, personOnly: "The page is built in Elementor; only wp-admin can edit it." });
    const added = itemsNow(w).find((i) => i.key === "wp-change:x")!;
    expect(String(added.why)).toContain("Only a person: The page is built in Elementor");
  });

  it("still takes a person's job (a plugin to deactivate)", async () => {
    const w = setup([]);
    await dispatch(w.env, "co-1", agentActor, "needs-you-add", { sprintId: "sp-real", kind: "task", key: "og", title: "Deactivate the duplicate Open Graph plugin", why: "two og blocks", after: "re-check" });
    expect(itemsNow(w).some((i) => i.key === "og")).toBe(true);
  });
});
