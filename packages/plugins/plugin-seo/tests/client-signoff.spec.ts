/**
 * Automatic client sign-off (0.26.0): a passed preview parks the task on the client without holding the rest of the week; one
 * approval email is drafted in Gmail per batch; the client's answers lift the lock and wake the agent once every preview of a
 * task is answered. Each "does X" test has the manual-sign-off sprint as its control.
 */
import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { approvalEmail, approvalSubject, approverAddresses } from "../src/engine/approval-email.js";
import { companyInfo, type Actor } from "../src/service/common.js";
import { afterPreviewPassed, AUTO_APPLY_HOURS, draftApprovalRequests, draftKeyFor, handleClientAnswer, onDraftResult, setSignoffMode } from "../src/service/client-signoff.js";
import { appearsOnPage, normaliseForMatch, proposeClientFacts } from "../src/service/facts.js";
import { dispatch, HANDLERS, UI_ONLY_HANDLERS } from "../src/dispatch.js";
import { SEO_TOOLS } from "../src/tools.js";
import { sprintFor, world } from "./helpers/rehearsal-world.js";
import { executed, taskRow, type Route, type Row } from "./helpers/seo-host.js";

const user: Actor = { kind: "user", userId: "user-peet" };
const agent: Actor = { kind: "agent", agentId: "agent-1", runId: "run-1", responsibleUserId: "user-peet" };

const wp = (extra: Row = {}) => sprintFor("real", { root_issue_id: "root-1", site_access: "wordpress", site_id: "site-1", change_policy: "pr_only", client_signoff: "auto", ...extra });
const parked = (extra: Row = {}) => taskRow({ id: "t1", sprint_id: "sp-real", template_key: "w3-cat-pages", week: 3, status: "blocked", issue_id: "iss-1", assignee_kind: "reviewer", blocker_reason: "Waiting for the Reviewer", due_day: 20, ...extra });
const preview = (id: string, page: string, extra: Row = {}): Row => ({ id, page_url: `https://agristudies.co.za/${page}`, title: `Page ${page}`, status: "pending", review_status: "passed", decision_note: null, handed_at: null, draft_key: null, reviewed_at: "2026-10-03T07:00:00Z", ...extra });

const latest = (rows: Row[]): Route => [/SELECT DISTINCT ON \(page_url\) id, page_url, title, status, review_status, decision_note, handed_at, draft_key/, () => rows];
const emitted = (w: ReturnType<typeof world>) => (w.ctx.events.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => ({ name: String(c[0]), companyId: c[1], payload: c[2] as Record<string, any> }));

describe("the approval email", () => {
  it("lists every page with its link and says nothing changes until the client approves", () => {
    const mail = approvalEmail({ siteName: "Agri Studies", firstNames: ["Elle"], pages: [{ title: "Hay bales", pageUrl: "https://agristudies.co.za/hay", link: "https://preview.partnersinbiz.online/p/agri/abc" }, { title: "Home", pageUrl: "https://agristudies.co.za/", link: "https://preview.partnersinbiz.online/p/agri/def" }], openDays: 30, signature: "Partners in Biz" });
    expect(mail.subject).toBe("Please review 2 proposed changes for Agri Studies");
    expect(mail.text).toMatch(/^Hi Elle,/);
    expect(mail.text).toContain("Nothing on your website changes until you approve it.");
    expect(mail.text).toContain("https://preview.partnersinbiz.online/p/agri/abc");
    expect(mail.html).toContain('<a href="https://preview.partnersinbiz.online/p/agri/def">');
    expect(approvalSubject("Agri Studies", 1)).toBe("Please review a proposed change for Agri Studies");
  });

  it("escapes what it quotes", () => {
    const mail = approvalEmail({ siteName: "A & B", firstNames: [], pages: [{ title: "<script>x</script>", pageUrl: "https://a.co/", link: "https://p/x" }], openDays: 30, signature: "PiB" });
    expect(mail.html).not.toContain("<script>");
    expect(mail.text).toMatch(/^Hi,/);
  });

  it("writes to the client's people on the client's own domain, else each person's first address, at most three", () => {
    const contacts = [
      { name: "Elle van Zyl", emails: ["elle@agriauctionssa.co.za", "elle@agristudies.co.za", "ellevanzyl12@gmail.com"] },
      { name: "Pieter Goosen", emails: ["goosenpg@gmail.com", "pieter@huntandgun.co.za"] },
    ];
    expect(approverAddresses(contacts, "www.agristudies.co.za")).toEqual([{ email: "elle@agristudies.co.za", name: "Elle van Zyl" }]);
    expect(approverAddresses(contacts, "other.co.za").map((a) => a.email)).toEqual(["elle@agriauctionssa.co.za", "goosenpg@gmail.com"]);
    expect(approverAddresses([], "x.co.za")).toEqual([]);
  });
});

describe("a passed preview parks the task on the client", () => {
  it("parks it when every preview was looked at, and does not wake the agent", async () => {
    const w = world({ sprints: [wp()], tasks: [parked()], routes: [latest([preview("p1", "a"), preview("p2", "b")])] });
    const sprint = (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!;
    expect(await afterPreviewPassed(w.env, sprint, "t1", "iss-1")).toBe("parked");
    const task = w.store.tasks.find((x) => x.id === "t1")!;
    expect(task).toMatchObject({ status: "blocked", assignee_kind: "client" });
    expect(String(task.blocker_reason)).toMatch(/client to answer 2 previews/);
    expect(w.wakeups).toEqual([]);
    expect(w.comments.at(-1)!.body).toMatch(/parked on the client/);
  });

  it("waits while a preview of the task is still with the Reviewer, and leaves the task to an agent that is revising", async () => {
    const pending = world({ sprints: [wp()], tasks: [parked()], routes: [latest([preview("p1", "a"), preview("p2", "b", { review_status: "pending" })])] });
    expect(await afterPreviewPassed(pending.env, (await db.getSprint(pending.env.ctx.db, "co-1", "sp-real"))!, "t1", "iss-1")).toBe("waiting");
    expect(pending.store.tasks[0]!.assignee_kind).toBe("reviewer");
    const revising = world({ sprints: [wp()], tasks: [parked({ status: "in_progress", assignee_kind: "agent" })], routes: [latest([preview("p1", "a")])] });
    expect(await afterPreviewPassed(revising.env, (await db.getSprint(revising.env.ctx.db, "co-1", "sp-real"))!, "t1", "iss-1")).toBe("agent");
    expect(revising.store.tasks[0]!.assignee_kind).toBe("agent");
  });

  it("does nothing on a sprint with manual sign-off (the control)", async () => {
    const w = world({ sprints: [wp({ client_signoff: "manual" })], tasks: [parked()], routes: [latest([preview("p1", "a")])] });
    expect(await afterPreviewPassed(w.env, (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!, "t1", "iss-1")).toBe("off");
    expect(w.store.tasks[0]!.assignee_kind).toBe("reviewer");
  });

  it("a task parked on the client does not hold the queue of its week (the next task opens)", async () => {
    const tasks = [parked({ assignee_kind: "client" }), taskRow({ id: "t2", sprint_id: "sp-real", template_key: "w3-products", week: 3, due_day: 20, status: "not_started" })];
    const w = world({ sprints: [wp({ pacing: "manual" })], tasks });
    const { openNextQueuedTask } = await import("../src/service/tasks.js");
    // t2 is released (a person started week 3) and nothing the agent holds stands in front of it.
    w.store.tasks[1]!.released_at = "2026-10-03T07:00:00Z";
    expect(await openNextQueuedTask(w.env, "co-1", { sprintId: "sp-real", week: 3, id: "t1" })).toBe("t2");
  });
});

describe("the approval email draft", () => {
  const draftRoutes = (rows: Row[]): Route[] => [
    [/SELECT id, company_id FROM plugin_seo_8099f8879a\.sprints WHERE client_signoff = 'auto'/, () => [{ id: "sp-real", company_id: "co-1" }]],
    [/FROM \(\s*SELECT DISTINCT ON \(page_url\) id, page_url, title, reviewed_at/, () => rows],
    [/FROM plugin_seo_8099f8879a\.crm_contacts WHERE company_id = \$1 AND \$2 = ANY\(account_ids\)/, () => [{ name: "Elle van Zyl", emails: ["elle@agristudies.co.za", "elle@agriauctionssa.co.za"] }]],
  ];

  it("waits for a batch to settle, then asks the Mailbox for ONE draft with every page", async () => {
    const recent = world({ sprints: [wp()], routes: draftRoutes([preview("p1", "a", { reviewed_at: "2026-10-03T07:50:00Z" })]) });
    expect(await draftApprovalRequests(recent.env)).toBe(0);
    expect(emitted(recent)).toEqual([]);

    const rows = [preview("p1", "a", { reviewed_at: "2026-10-03T07:00:00Z" }), preview("p2", "b", { reviewed_at: "2026-10-03T07:10:00Z" })];
    const w = world({ sprints: [wp({ client_signoff: "auto", client_kind: "company", client_ref: "47a39f83" })], routes: draftRoutes(rows) });
    expect(await draftApprovalRequests(w.env)).toBe(1);
    const [event] = emitted(w);
    expect(event!.name).toBe("mail.draft.requested");
    expect(event!.payload.key).toBe(draftKeyFor("sp-real", ["p1", "p2"]));
    expect(event!.payload.to).toEqual([{ email: "elle@agristudies.co.za", name: "Elle van Zyl" }]);
    expect(event!.payload.subject).toBe("Please review 2 proposed changes for Agri Studies");
    expect(event!.payload.text).toContain("/p/");
    expect(event!.payload.context).toMatchObject({ plugin: "partnersinbiz.seo", kind: "seo-approval", id: "sp-real" });
    // The previews are claimed before the event goes out, so the next run does not ask again.
    expect(executed(w, /SET draft_key = \$3, draft_status = 'requested'/)).toHaveLength(1);
  });

  it("asks again when the event could not be sent", async () => {
    const w = world({ sprints: [wp()], routes: draftRoutes([preview("p1", "a")]) });
    (w.ctx.events.emit as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error("host down"));
    expect(await draftApprovalRequests(w.env)).toBe(0);
    expect(executed(w, /SET draft_key = NULL, draft_status = NULL/)).toHaveLength(1);
  });

  it("does not draft for a sprint on manual sign-off", async () => {
    const w = world({ sprints: [wp({ client_signoff: "manual" })], routes: draftRoutes([preview("p1", "a")]) });
    expect(await draftApprovalRequests(w.env)).toBe(0);
  });

  it("records the Gmail draft and puts one line on Needs you; a failed draft puts the links there instead", async () => {
    const rows: Route[] = [[/FROM plugin_seo_8099f8879a\.previews WHERE company_id = \$1 AND draft_key = \$2/, () => [{ id: "p1", page_url: "https://agristudies.co.za/a", title: "Page a" }]]];
    const w = world({ sprints: [wp()], routes: rows });
    const key = "seo-approval:sp-real:abc";
    const context = { plugin: "partnersinbiz.seo", kind: "seo-approval", id: "sp-real" };
    await onDraftResult(w.env, { companyId: "co-1", payload: { key, status: "drafted", draftUrl: "https://mail.google.com/mail/u/x/#drafts?compose=1", context } });
    expect(executed(w, /SET draft_status = \$3, draft_url = \$4/)[0]!.params).toContain("https://mail.google.com/mail/u/x/#drafts?compose=1");
    const line = JSON.stringify(w.needsYou.at(-1)!.items);
    expect(line).toContain("Send the approval email to the client");
    expect(line).toContain("compose=1");
    const failed = world({ sprints: [wp()], routes: rows });
    await onDraftResult(failed.env, { companyId: "co-1", payload: { key, status: "failed", error: "no gmail", context } });
    expect(JSON.stringify(failed.needsYou.at(-1)!.items)).toContain("the email draft could not be made");
    // Somebody else's result is ignored.
    const other = world({ sprints: [wp()], routes: rows });
    await onDraftResult(other.env, { companyId: "co-1", payload: { key, status: "drafted", context: { plugin: "partnersinbiz.billing", kind: "x", id: "y" } } });
    expect(other.needsYou).toEqual([]);
  });
});

describe("the client's answers", () => {
  const answer = (extra: Partial<Parameters<typeof handleClientAnswer>[2]> = {}) => ({ id: "p1", companyId: "co-1", sprintId: "sp-real", taskId: "t1", issueId: "iss-1", pageUrl: "https://agristudies.co.za/a", title: "Page a", status: "approved", note: null, draftKey: null, ...extra });
  const lock = (w: ReturnType<typeof world>) => emitted(w).filter((e) => e.name === "site.write-approved");

  it("waits while other previews of the task are unanswered", async () => {
    const w = world({ sprints: [wp()], tasks: [parked({ assignee_kind: "client" })], routes: [latest([preview("p1", "a", { status: "approved" }), preview("p2", "b")])] });
    const sprint = (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!;
    expect(await handleClientAnswer(w.env, sprint, answer())).toBe(true);
    expect(lock(w)).toEqual([]);
    expect(w.wakeups).toEqual([]);
    expect(w.store.tasks[0]!.assignee_kind).toBe("client");
  });

  it("when every preview is answered: lifts the lock for the window, takes the task back and wakes the agent once with what to apply and what to revise", async () => {
    const w = world({ sprints: [wp()], tasks: [parked({ assignee_kind: "client" })], routes: [latest([preview("p1", "a", { status: "approved" }), preview("p2", "b", { status: "changes_requested", decision_note: "Use our logo colours" })])] });
    const sprint = (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!;
    expect(await handleClientAnswer(w.env, sprint, answer())).toBe(true);
    const [grant] = lock(w);
    expect(grant!.payload).toMatchObject({ siteId: "site-1", by: "client-approval:t1" });
    expect(new Date(String(grant!.payload.until)).getTime() - new Date("2026-10-03T08:00:00Z").getTime()).toBe(AUTO_APPLY_HOURS * 3_600_000);
    expect(w.store.tasks[0]).toMatchObject({ status: "in_progress", assignee_kind: "agent", blocker_reason: null });
    expect(w.wakeups).toEqual(["iss-1"]);
    const body = w.comments.at(-1)!.body;
    expect(body).toMatch(/Approved: apply these now/);
    expect(body).toContain("https://agristudies.co.za/a");
    expect(body).toMatch(/Changes requested: revise/);
    expect(body).toContain("Use our logo colours");
    expect(body).toMatch(/complete this task only when every page of it is applied/);
    expect(executed(w, /SET handed_at = now\(\)/)[0]!.params[1]).toBe(JSON.stringify(["p1", "p2"]));
  });

  it("changes requested only: no lock is lifted", async () => {
    const w = world({ sprints: [wp()], tasks: [parked({ assignee_kind: "client" })], routes: [latest([preview("p2", "b", { status: "changes_requested", decision_note: "no" })])] });
    await handleClientAnswer(w.env, (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!, answer({ id: "p2", status: "changes_requested" }));
    expect(lock(w)).toEqual([]);
    expect(w.wakeups).toEqual(["iss-1"]);
  });

  it("an answer already handed to the agent is not handed again", async () => {
    const w = world({ sprints: [wp()], tasks: [parked({ assignee_kind: "client" })], routes: [latest([preview("p1", "a", { status: "approved", handed_at: "2026-10-03T06:00:00Z" })])] });
    await handleClientAnswer(w.env, (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!, answer());
    expect(lock(w)).toEqual([]);
    expect(w.wakeups).toEqual([]);
  });

  it("is not handled on a manual sprint (the control): the old path comments and waits for a person", async () => {
    const w = world({ sprints: [wp({ client_signoff: "manual" })], tasks: [parked({ assignee_kind: "client" })], routes: [latest([preview("p1", "a", { status: "approved" })])] });
    expect(await handleClientAnswer(w.env, (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!, answer())).toBe(false);
    expect(lock(w)).toEqual([]);
  });
});

describe("set-signoff-mode", () => {
  it("is page-only, person-only, and only for a WordPress pr_only sprint", async () => {
    expect(UI_ONLY_HANDLERS["set-signoff-mode"]).toBeTypeOf("function");
    expect(HANDLERS["set-signoff-mode"]).toBeUndefined();
    expect(SEO_TOOLS.some((t) => t.name === "set-signoff-mode")).toBe(false);
    const w = world({ sprints: [wp({ client_signoff: "manual" })] });
    await expect(setSignoffMode(w.env, "co-1", agent, { sprintId: "sp-real", mode: "auto" })).rejects.toThrow(/signed-in person/);
    await expect(dispatch(w.env, "co-1", agent, "set-signoff-mode", { sprintId: "sp-real", mode: "auto" })).rejects.toThrow(/signed-in person/);
    expect(await setSignoffMode(w.env, "co-1", user, { sprintId: "sp-real", mode: "auto" })).toMatchObject({ mode: "auto", previous: "manual" });
    expect(w.sprintRow("sp-real").client_signoff).toBe("auto");
    const repo = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", client_signoff: "manual" })] });
    await expect(setSignoffMode(repo.env, "co-1", user, { sprintId: "sp-real", mode: "auto" })).rejects.toThrow(/WordPress site on the pr_only/);
  });
});

describe("propose-client-facts: the system drafts the fact sheet from the client's own pages", () => {
  const page = `<html><body><h1>Delivery</h1><p>We deliver to all major centres in South Africa within 5 working days.</p><p>Returns are accepted within 7 days of delivery.</p></body></html>`;
  const siteOf = (calls: string[]) => (async (url: string) => { calls.push(url); return { status: url.includes("/delivery") ? 200 : 404, text: url.includes("/delivery") ? page : "", url }; }) as never;

  it("accepts a wording that is on the client's page and refuses one that is not, one on another site, and a repeat", async () => {
    const calls: string[] = [];
    const w = world({ sprints: [wp()] });
    (w.env as unknown as { site: unknown }).site = siteOf(calls);
    const result = (await proposeClientFacts(w.env, "co-1", agent, {
      sprintId: "sp-real",
      say: [
        { wording: "We deliver to all major centres in South Africa within 5 working days.", sourceUrl: "/delivery" },
        { wording: "Free delivery on every order", sourceUrl: "/delivery" },
        { wording: "Returns are accepted within 7 days of delivery.", sourceUrl: "https://other.co.za/delivery" },
        { wording: "Returns are accepted within 7 days of delivery.", sourceUrl: "https://agristudies.co.za/missing" },
      ],
    })) as { accepted: number; rejected: Array<{ why: string }>; status: string };
    expect(result.accepted).toBe(1);
    expect(result.status).toBe("draft");
    expect(result.rejected.map((r) => r.why)).toEqual(["this wording is not on that page: copy it exactly from the page", expect.stringMatching(/must be a page of agristudies\.co\.za/), "the source page could not be read"]);
    const saved = executed(w, /INSERT INTO plugin_seo_8099f8879a\.client_facts/)[0]!;
    expect(JSON.parse(String(saved.params[2]))).toEqual([{ kind: "say", text: "We deliver to all major centres in South Africa within 5 working days.", source: "https://agristudies.co.za/delivery" }]);
    expect(saved.sql).toMatch(/'draft'/);
    // The other site was never fetched.
    expect(calls.some((u) => u.includes("other.co.za"))).toBe(false);
  });

  it("matches without caring about case, punctuation or spacing, but not about words", () => {
    expect(appearsOnPage("returns   are accepted WITHIN 7 days of delivery", "<p>Returns are accepted within 7 days of delivery.</p>".replace(/<[^>]+>/g, " "))).toBe(true);
    expect(appearsOnPage("Returns are accepted within 14 days", "Returns are accepted within 7 days of delivery.")).toBe(false);
    expect(appearsOnPage("short", "short text")).toBe(false);
    expect(normaliseForMatch("It’s “ours”")).toBe("it's 'ours'");
  });
});
