/**
 * 0.45.0 (PAR-9493 T3, PAR-9530): on a pr_only WordPress sprint with manual client sign-off, resolving a page change set
 * without pageUrls says no apply window was opened (for an agent and a person), and needs-you-add warns when such a change
 * set names no task. The window-opening path (pageUrls) is in page-apply-tools.pg.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { isPageChangeTitle, needsPageWindow } from "../src/engine/needs-you-handoff.js";
import type { Actor } from "../src/service/common.js";
import { dispatch } from "../src/dispatch.js";
import { PAGE_CHANGE_NO_TASK_WARNING } from "../src/service/needs-you.js";
import { sprintFor, world } from "./helpers/rehearsal-world.js";
import type { Route, Row } from "./helpers/seo-host.js";

const person: Actor = { kind: "user", userId: "user-peet" };
const agent: Actor = { kind: "agent", agentId: "agent-seo", runId: "run-1", responsibleUserId: "user-peet" };

const WEEK = "2026-09-28"; // the Monday of the test clock's 2026-10-03
const MANUAL = { site_access: "wordpress", site_id: "site-1", change_policy: "pr_only", client_signoff: "manual", client_project_id: "proj-agri" };
const crmSite: Row = { id: "site-1", company_id: "co-1", client_kind: "company", url: "https://agristudies.co.za", label: null, connector_status: "connected", connector_seen_at: null, access: ["connector"], deleted: false };
const sites: Route = [/FROM plugin_seo_8099f8879a\.crm_sites/, () => [crmSite]];
const item = (key: string, title: string, extra: Row = {}): Row => ({ key, kind: "task", title, why: "why it waits", steps: ["step one"], links: [], after: "after", check: "manual", taskIds: [], status: "open", addedAt: "2026-09-29T00:00:00Z", ...extra });
const digestRow = (items: Row[]): Row => ({ id: "ny-1", company_id: "co-1", sprint_id: "sp-real", week_start: WEEK, issue_id: "wk-1", issue_identifier: "PIB-9", items, status: "open" });
const setup = (items: Row[], sprint: Row = MANUAL) => world({ sprints: [sprintFor("real", sprint)], needsYouRecent: [digestRow(items)], routes: [sites] });
const itemsNow = (w: ReturnType<typeof world>) => w.needsYou.find((r) => r.id === "ny-1")!.items as Row[];

const CHANGE_SET = "Approve page refresh: crop production course (Agri Studies)";

describe("isPageChangeTitle and needsPageWindow", () => {
  it("reads change sets as page changes, and a person's job or markup as not", () => {
    expect(isPageChangeTitle(CHANGE_SET)).toBe(true);
    expect(isPageChangeTitle('Refresh the page for "hydroponics course"')).toBe(true);
    expect(isPageChangeTitle("Deactivate plugin X")).toBe(false);
    expect(isPageChangeTitle("Add empty alt to decorative Share icon on all product pages (62)")).toBe(false);
  });
  it("only a pr_only WordPress sprint with manual sign-off waits for a window", () => {
    expect(needsPageWindow({ siteAccess: "wordpress", changePolicy: "pr_only", clientSignoff: "manual" })).toBe(true);
    expect(needsPageWindow({ siteAccess: "wordpress", changePolicy: "pr_only", clientSignoff: "auto" })).toBe(false);
    expect(needsPageWindow({ siteAccess: "wordpress", changePolicy: "merge_seo_scope", clientSignoff: "manual" })).toBe(false);
    expect(needsPageWindow({ siteAccess: "repo", changePolicy: "pr_only", clientSignoff: "manual" })).toBe(false);
  });
});

describe("needs-you-resolve without pageUrls", () => {
  it.each([["an agent", agent], ["a person", person]])("a page change set, by %s: resolved, applyWindow not_opened, next names approve-page-apply", async (_n, actor) => {
    const w = setup([item("cs", CHANGE_SET, { taskIds: [] })]);
    const r = (await dispatch(w.env, "co-1", actor, "needs-you-resolve", { sprintId: "sp-real", key: "cs" })) as Row;
    expect(r).toMatchObject({ resolved: true, applyWindow: "not_opened" });
    expect(String(r.next)).toContain("approve-page-apply");
    expect(itemsNow(w)[0]!.status).toBe("done");
  });

  it("a non-page item resolves as before (no applyWindow)", async () => {
    const w = setup([item("og", "Deactivate plugin X")]);
    const r = (await dispatch(w.env, "co-1", agent, "needs-you-resolve", { sprintId: "sp-real", key: "og" })) as Row;
    expect(r).toMatchObject({ resolved: true });
    expect(r.applyWindow).toBeUndefined();
    expect(r.next).toBeUndefined();
  });

  it("a repo sprint resolves a page change set as before", async () => {
    const w = setup([item("cs", CHANGE_SET)], { change_policy: "pr_only", client_signoff: "manual" });
    const r = (await dispatch(w.env, "co-1", person, "needs-you-resolve", { sprintId: "sp-real", key: "cs" })) as Row;
    expect(r).toMatchObject({ resolved: true });
    expect(r.applyWindow).toBeUndefined();
  });

  it("pageUrls on a repo sprint is refused by the window rules and the item stays open", async () => {
    const w = setup([item("cs", CHANGE_SET, { taskIds: ["t-1"] })], { change_policy: "pr_only", client_signoff: "manual" });
    await expect(dispatch(w.env, "co-1", person, "needs-you-resolve", { sprintId: "sp-real", key: "cs", pageUrls: ["https://agristudies.co.za/x"] })).rejects.toThrow(/not linked to a WordPress site/);
    expect(itemsNow(w)[0]!.status).toBe("open");
  });
});

describe("needs-you-add on a pr_only manual sign-off WordPress sprint", () => {
  const add = (w: ReturnType<typeof world>, title: string, extra: Row = {}) =>
    dispatch(w.env, "co-1", agent, "needs-you-add", { sprintId: "sp-real", kind: "task", key: "cs-new", title, why: "pr_only site", after: "apply", ...extra }) as Promise<Row>;

  it("a page change set with no taskIds is added with a warning to pass the task id", async () => {
    const w = setup([]);
    const r = await add(w, CHANGE_SET);
    expect(r.warning).toBe(PAGE_CHANGE_NO_TASK_WARNING);
    expect(itemsNow(w).some((i) => i.key === "cs-new")).toBe(true);
  });

  it("no warning with taskIds, for a non-page item, or on an automatic sign-off sprint", async () => {
    expect((await add(setup([]), CHANGE_SET, { taskIds: ["t-1"] })).warning).toBeUndefined();
    expect((await add(setup([]), "Deactivate plugin X")).warning).toBeUndefined();
    const auto = setup([], { ...MANUAL, change_policy: "merge_seo_scope" });
    expect((await add(auto, "Deactivate plugin X")).warning).toBeUndefined();
  });
});
