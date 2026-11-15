import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { liveFingerprint } from "../src/engine/preview.js";
import { assertPreviewLinksChecked, createPreview, listPreviews, previewLink, previewRows, previewSlug, reviewPreview, SOURCE_BASIS_NOTICE } from "../src/service/preview.js";
import { PREVIEW_RENDER_URL } from "../src/service/preview-links.js";
import { ORIGIN } from "../src/constants.js";

const { fakeDriveSave } = vi.hoisted(() => ({ fakeDriveSave: vi.fn(async (_ctx: unknown, _opts: Record<string, unknown>) => ({ status: "saved", requestId: "rq", driveFileId: "f1", url: "https://drive.example/f1" })) }));
vi.mock("@partnersinbiz/pib-plugin-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return { ...actual, driveSave: fakeDriveSave };
});

type Row = Record<string, unknown>;
const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", site_access: "wordpress", site_id: "site-1",
  change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1,
  last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};
const TASK: Row = {
  id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w3-homepage", week: 3, phase: 1, due_day: 20, focus: "Core Pages", title: "Home", description: null,
  task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: "w3-homepage", status: "in_progress", source: "template", parent_optimization_id: null,
  context: null, issue_id: "iss-1", issue_identifier: "PAR-9", issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null, human_ask: null, evidence: null,
  started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null,
};
const LIVE = `<html><head><title>Old</title></head><body><h1>Old heading</h1><main><div class="entry-content">${"<p>auction lot listing word </p>".repeat(40)}</div></main></body></html>`;

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;
// No render service in tests unless one is given: create-preview falls back to the source.
const noRender: FetchMock = async () => { throw new TypeError("fetch failed"); };

function host(previewRow?: Row, rounds = 0, evidence: Row | null = null, opts: { fetch?: FetchMock; siteMs?: number; live?: string } = {}) {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const created: Array<Record<string, unknown>> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const wakes: string[] = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string) {
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE id/.test(sql)) return [SPRINT];
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id/.test(sql)) return [{ ...TASK, evidence }];
        if (/count\(\*\)(?! OVER)/.test(sql)) return [{ n: rounds }];
        if (/needs_you/.test(sql)) return [];
        if (/FROM plugin_seo_8099f8879a\.previews/.test(sql)) return previewRow ? [previewRow] : [];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) { executes.push({ sql, params }); return { rowCount: 1 }; },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    state: { get: vi.fn(async () => null), set: vi.fn() },
    issues: {
      create: vi.fn(async (input: Record<string, unknown>) => { created.push(input); return { id: "rev-1" }; }),
      createComment: vi.fn(async (id: string, body: string) => { comments.push({ id, body }); return { id: "c" }; }),
      requestWakeup: vi.fn(async (id: string) => { wakes.push(id); return { queued: true, runId: null }; }),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); return { id, ...patch }; }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  let clock = Date.parse("2026-10-02T12:00:00Z");
  const site = vi.fn(async (_url: string) => {
    clock += opts.siteMs ?? 0;
    return { status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: opts.live ?? LIVE, ms: 1 };
  });
  const fetch = vi.fn(opts.fetch ?? noRender);
  return { env: createEnv(ctx, { now: () => new Date(clock), site: site as never, fetch }), executes, created, comments, wakes, updates, site, fetch };
}

const seo: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };
const reviewer: Actor = { kind: "agent", agentId: "rev-agent", runId: "r2", responsibleUserId: null };
const base = { sprintId: "sp-1", taskId: "t-1", pageUrl: "/", h1: "New heading" };

describe("create-preview", () => {
  it("refuses a body that would wipe most of the live page", async () => {
    await expect(createPreview(host().env, "co-1", seo, { ...base, bodyHtml: "<p>short intro</p>", bodyMode: "replace" })).rejects.toThrow(/keep only \d+% of the live page/);
    // The kept-text message names every add mode, including afterFirstParagraph.
    await expect(createPreview(host().env, "co-1", seo, { ...base, bodyHtml: "<p>short intro</p>", bodyMode: "replace" })).rejects.toThrow(/"before", "after" or "afterFirstParagraph"/);
  });

  it("adds copy by default, holds the preview and opens a review issue for the owner or Reviewer", async () => {
    const h = host();
    const out = (await createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>new intro words</p>" })) as { reviewStatus: string; stats: { keptPct: number }; reviewIssueId: string; url: string };
    expect(out).toMatchObject({ reviewStatus: "pending", reviewIssueId: "rev-1" });
    expect(out.url).toMatch(/^https:\/\/preview\.partnersinbiz\.online\/p\/acme\/[A-Za-z0-9_-]{20,}$/);
    expect(out.stats.keptPct).toBeGreaterThanOrEqual(95);
    expect(h.created[0]).toMatchObject({ originKind: ORIGIN.previewReview, parentId: "iss-1" });
    expect(String(h.created[0]!.description)).toMatch(/review\?key=/);
    expect(String(h.created[0]!.description)).toMatch(/Kept-text figure: measured when the review page is first opened \(made from the page source\)/);
    const insert = h.executes.find((e) => /INSERT INTO plugin_seo_8099f8879a\.previews/.test(e.sql))!;
    expect(out).toHaveProperty("rubric.score");
    expect(String(h.created[0]!.description)).toMatch(/Creative score: \d+\/100, (passes|below the bar of 70)/);
    expect(String(insert.params[7])).toContain("new intro words");
    expect(String(insert.params[7])).toContain("auction lot listing word");
  });

  it("forwards a caller-supplied client to the Drive save", async () => {
    fakeDriveSave.mockClear();
    await createPreview(host().env, "co-1", seo, { ...base, bodyHtml: "<p>new intro words</p>", client: { kind: "company", ref: "crm-co-42" } });
    expect(fakeDriveSave).toHaveBeenCalledTimes(1);
    expect(fakeDriveSave.mock.calls[0]![1]).toMatchObject({ kind: "seo", subfolder: "03 Deliverables", client: { kind: "company", ref: "crm-co-42" } });
  });

  it("a sprint with only a free-text client name and no caller client is not copied to Drive (PAR-8128)", async () => {
    // The fixture sprint has client_ref null and client_name "Acme Ltd" (legacy): it could be anyone's, so no own-folder copy.
    fakeDriveSave.mockClear();
    const result = await createPreview(host().env, "co-1", seo, { ...base, bodyHtml: "<p>new intro words</p>" });
    expect(result).toBeTruthy();
    expect(fakeDriveSave).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "person", ref: "x" }, /client.kind must be company or contact/],
    [{ kind: "contact", ref: "  " }, /client.ref must be a non-empty/],
    [{ kind: "contact" }, /client.ref must be a non-empty/],
    ["company:x", /client must be an object/],
  ])("refuses a bad client %j before anything is saved", async (client, msg) => {
    fakeDriveSave.mockClear();
    const h = host();
    await expect(createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>new intro words</p>", client } as never)).rejects.toThrow(msg);
    expect(fakeDriveSave).not.toHaveBeenCalled();
    expect(h.executes).toHaveLength(0);
  });
});

describe("preview links", () => {
  it("carry the site name before the token", () => {
    expect(previewSlug("https://www.huntandgun.co.za/")).toBe("huntandgun");
    expect(previewSlug("agriauctionssa.co.za")).toBe("agriauctionssa");
    expect(previewLink("https://huntandgun.co.za", "TOKEN")).toBe("https://preview.partnersinbiz.online/p/huntandgun/TOKEN");
  });
});

describe("review-preview", () => {
  const row = { id: "p1", task_id: "t-1", issue_id: "iss-1", page_url: "https://acme.co.za/", title: "Home", created_by: "seo-1", stats: { rendered: { keptPct: 96, liveWords: 500 } } };
  const lossy = { ...row, stats: { rendered: { keptPct: 22, liveWords: 500 } } };
  const zeroLive = { ...row, stats: { rendered: { keptPct: 100, liveWords: 0 } } };
  const noWords = { ...row, stats: { rendered: { keptPct: 100 } } };
  const unchecked = { ...row, stats: {} };
  const owner = { kind: "user", userId: "user-1" } as unknown as Actor;
  it("cannot be done by the agent that made the preview", async () => {
    await expect(reviewPreview(host(row).env, "co-1", seo, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).rejects.toThrow(/someone else/);
  });

  it("an agent cannot pass before the rendered check ran or when it shows a lot missing; the owner can", async () => {
    await expect(reviewPreview(host(unchecked).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).rejects.toThrow(/Open the review page first/);
    await expect(reviewPreview(host(lossy).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).rejects.toThrow(/only 22%/);
    expect(await reviewPreview(host(lossy).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: "Listings missing" })).toMatchObject({ reviewStatus: "changes_needed" });
    expect(await reviewPreview(host(lossy).env, "co-1", owner, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).toMatchObject({ reviewStatus: "passed" });
  });

  it("an agent cannot pass when the live page rendered 0 words or the count is missing", async () => {
    for (const r of [zeroLive, noWords]) await expect(reviewPreview(host(r).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).rejects.toThrow(/0 words/);
  });

  it("pass releases the link and wakes the SEO agent; changes needs notes and holds it", async () => {
    const h = host(row);
    expect(await reviewPreview(h.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).toMatchObject({ reviewStatus: "passed", clientCanOpen: true });
    expect(h.executes.some((e) => /SET review_status/.test(e.sql) && e.params.includes("passed"))).toBe(true);
    expect(h.wakes).toEqual(["iss-1"]);
    await expect(reviewPreview(host(row).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes" })).rejects.toThrow(/notes are required/);
    const h2 = host(row);
    expect(await reviewPreview(h2.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: "Listings are missing" })).toMatchObject({ reviewStatus: "changes_needed", clientCanOpen: false });
    expect(h2.comments[0]!.body).toMatch(/Listings are missing/);
  });
});

describe("a page that keeps failing", () => {
  const row = { id: "p1", task_id: "t-1", issue_id: "iss-1", page_url: "https://acme.co.za/", title: "Home", created_by: "seo-1", stats: { rendered: { keptPct: 96, liveWords: 500 } } };
  it("goes to the owner after two rounds once the Senior Developer has had a go, instead of back to the agent", async () => {
    const h = host(row, 2, { builds: [{ issueId: "fix-0", agentId: "sen-1", at: "2026-10-02T10:00:00Z", kind: "preview-fix", level: "senior", pageUrl: "https://acme.co.za/" }] });
    const out = await reviewPreview(h.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: "Claims the client's terms contradict" });
    expect(out).toMatchObject({ escalatedToOwner: true });
    expect(h.wakes).toEqual([]);
    expect(h.executes.some((e) => /needs_you/.test(e.sql))).toBe(true);
    expect(h.comments[0]!.body).toMatch(/sent back 2 times/);
  });

  it("the first round still goes back to the agent", async () => {
    const h = host(row, 1);
    const out = await reviewPreview(h.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: "Wording" });
    expect(out).not.toHaveProperty("escalatedToOwner");
    expect(h.wakes).toEqual(["iss-1"]);
  });
});

describe("preview links in asks", () => {
  const TOK = "R6cEBXyHMKM9AvnRAcnz9O4G294tisdJ";
  const ask = (tok: string) => ({ humanAsk: `Show the client https://preview.partnersinbiz.online/p/acme/${tok}` });
  const withRow = (status: string | null) => {
    const h = host(status ? ({ id: TOK, review_status: status, page_url: "https://acme.co.za/" } as Row) : undefined);
    return h.env;
  };

  it("refuses links to previews that are not passed, or not ours", async () => {
    await expect(assertPreviewLinksChecked(withRow("pending"), "co-1", ask(TOK))).rejects.toThrow(/has not been checked/);
    await expect(assertPreviewLinksChecked(withRow("changes_needed"), "co-1", ask(TOK))).rejects.toThrow(/changes needed/);
    await expect(assertPreviewLinksChecked(withRow(null), "co-1", ask(TOK))).rejects.toThrow(/not one of this company/);
  });

  it("allows passed previews and text without a preview link", async () => {
    await expect(assertPreviewLinksChecked(withRow("passed"), "co-1", ask(TOK))).resolves.toBeUndefined();
    await expect(assertPreviewLinksChecked(withRow(null), "co-1", { humanAsk: "Nothing to link" })).resolves.toBeUndefined();
  });
});

describe("waiting for the Reviewer", () => {
  it("parks the task when a preview is made", async () => {
    const h = host();
    await createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>new intro words</p>" });
    expect(h.updates).toEqual([{ id: "iss-1", patch: { status: "blocked" } }]);
    expect(h.executes.some((e) => /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET/.test(e.sql) && e.params.includes("reviewer"))).toBe(true);
  });
});

describe("create-preview from the rendered live page (PAR-8787)", () => {
  // What scripts add on the live page (a banner) is in the render but not in the source.
  const BANNER = `<div class="auctionUpdatesLiveGroup">${"<p>live auction update banner </p>".repeat(10)}</div>`;
  const RENDERED = LIVE.replace("<body>", `<body>${BANNER}`).replace("<script>", "");
  const json = (body: unknown, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const add = { ...base, bodyHtml: "<p>new intro words</p>" };
  const stored = (h: ReturnType<typeof host>) => {
    const insert = h.executes.find((e) => /INSERT INTO plugin_seo_8099f8879a\.previews/.test(e.sql))!;
    return { html: String(insert.params[7]), stats: JSON.parse(String(insert.params[12])) as Record<string, any> };
  };

  it("builds from the rendered HTML and stores only stats.rendered with basis rendered", async () => {
    const h = host(undefined, 0, null, { fetch: json({ html: RENDERED }) });
    const out = (await createPreview(h.env, "co-1", seo, add)) as { basis: string; notes: string[] };
    const { html, stats } = stored(h);
    expect(html).toContain("live auction update banner");
    expect(html.match(/<!DOCTYPE html>/gi)).toHaveLength(1);
    expect(Object.keys(stats).sort()).toEqual(["basis", "liveFingerprint", "rendered"]);
    expect(stats.basis).toBe("rendered");
    expect(stats).not.toHaveProperty("keptPct");
    expect(stats.rendered).toMatchObject({ keptPct: 100, liveWords: 203, at: "2026-10-02T12:00:00.000Z" });
    expect(out.basis).toBe("rendered");
    expect(out.notes.join(" ")).not.toContain(SOURCE_BASIS_NOTICE);
  });

  it("calls the fixed render URL with env.fetch, never through env.site", async () => {
    const h = host(undefined, 0, null, { fetch: json({ html: RENDERED }) });
    await createPreview(h.env, "co-1", seo, { ...add, renderUrl: "http://evil.example/" } as never);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe(PREVIEW_RENDER_URL);
    expect(url).toBe("http://127.0.0.1:3033/render");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ url: "https://acme.co.za/" }) });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(h.site.mock.calls.map((c) => c[0])).toEqual(["https://acme.co.za/"]);
  });

  it("does not double a doctype the render already has", async () => {
    const h = host(undefined, 0, null, { fetch: json({ html: `<!doctype html>${RENDERED}` }) });
    await createPreview(h.env, "co-1", seo, add);
    expect(stored(h).html.match(/<!DOCTYPE html>/gi)).toHaveLength(1);
  });

  it("logs both selector counts when the contentSelector matches the same in both", async () => {
    const h = host(undefined, 0, null, { fetch: json({ html: RENDERED }) });
    const out = (await createPreview(h.env, "co-1", seo, { ...add, contentSelector: ".entry-content" })) as { basis: string; notes: string[] };
    expect(out.basis).toBe("rendered");
    expect(out.notes.join(" ")).toMatch(/contentSelector \.entry-content: 1 in the rendered page, 1 in the source/);
  });

  const twoAreas = RENDERED.replace("</main>", `</main><div class="entry-content"><p>sidebar copy</p></div>`);
  const noArea = RENDERED.replace('class="entry-content"', 'class="content"');
  it.each([
    ["500", { fetch: json({ error: "boom" }, 500) }, {}, /answered 500/],
    ["abort", { fetch: async () => { throw new DOMException("timed out", "TimeoutError"); } }, {}, /no render within 15 s/],
    ["unreachable", { fetch: noRender }, {}, /could not be reached/],
    ["empty", { fetch: json({ html: "  " }) }, {}, /came back empty/],
    ["no html", { fetch: json({}) }, {}, /came back empty/],
    ["bad JSON", { fetch: json("<html>not json") }, {}, /did not answer JSON/],
    ["0 words", { fetch: json({ html: "<html><body><script>x()</script></body></html>" }) }, {}, /shows 0 words/],
    ["selector 2 vs 1", { fetch: json({ html: twoAreas }) }, { contentSelector: ".entry-content" }, /matches 2 element\(s\) in the rendered page and 1 in the source/],
    ["selector 0", { fetch: json({ html: noArea }) }, { contentSelector: ".entry-content" }, /matches 0 element\(s\) in the rendered page and 1 in the source/],
    ["elapsed >= 12 s", { fetch: json({ html: RENDERED }), siteMs: 12_000 }, {}, /12 s already spent/],
  ] as const)("falls back to the source on %s, with the notice and no rendered figure", async (_name, opts, extra, reason) => {
    const h = host(undefined, 0, null, opts as never);
    const out = (await createPreview(h.env, "co-1", seo, { ...add, ...extra })) as { basis: string; notes: string[] };
    const { html, stats } = stored(h);
    expect(html).not.toContain("live auction update banner");
    expect(stats).toMatchObject({ basis: "source", liveWords: 163 });
    expect(typeof stats.keptPct).toBe("number");
    expect(stats).not.toHaveProperty("rendered");
    expect(out.basis).toBe("source");
    expect(out.notes[0]).toContain(SOURCE_BASIS_NOTICE);
    expect(out.notes[0]).toMatch(reason);
    const issue = String(h.created[0]!.description);
    expect(issue).toContain(SOURCE_BASIS_NOTICE);
    expect(issue).toMatch(reason);
    expect(issue).toContain("Kept-text figure: measured when the review page is first opened (made from the page source)");
    if (_name === "elapsed >= 12 s") expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refuses on the rendered figure below MIN_KEPT_PCT", async () => {
    const h = host(undefined, 0, null, { fetch: json({ html: RENDERED }) });
    await expect(createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>short intro</p>", bodyMode: "replace" })).rejects.toThrow(/keep only \d+% of the live page's text \(\d+ of 203 words gone\)/);
  });

  it("one stored value: list-previews, rows, the Reviewer gate and the review issue all show stats.rendered.keptPct", async () => {
    const h = host(undefined, 0, null, { fetch: json({ html: RENDERED }) });
    await createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>short intro</p>", bodyMode: "replace", allowReplace: true });
    const { stats } = stored(h);
    const kept = stats.rendered.keptPct as number;
    expect(kept).toBeLessThan(70);
    expect(String(h.created[0]!.description)).toContain(`Text kept from the live page: ${kept}% (203 words live`);
    const row = { id: "p1", task_id: "t-1", issue_id: "iss-1", page_url: "https://acme.co.za/", title: "Home", status: "pending", review_status: "pending", created_by: "seo-1", expires_at: "2026-11-01", created_at: "2026-10-02", total: 1, stats: JSON.stringify(stats) };
    const list = (await listPreviews(host(row).env, "co-1", { sprintId: "sp-1" })) as { previews: Array<Record<string, unknown>> };
    expect(list.previews[0]).toMatchObject({ keptPct: kept, basis: "rendered" });
    expect((await previewRows(host(row).env, "co-1", "sp-1"))[0]).toMatchObject({ keptPct: kept, basis: "rendered", renderedChecked: true });
    await expect(reviewPreview(host(row).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).rejects.toThrow(`only ${kept}%`);
  });

  it("previewRows adds expired, overlapIds and changedFields for the Previews tab (PAR-9145)", async () => {
    const mk = (id: string, status: string, expired: boolean, changes: unknown) => ({ id, task_id: "t-1", issue_id: "iss-1", issue_identifier: "PAR-1", page_url: "https://acme.co.za/", title: "Home", status, review_status: "passed", expires_at: "2026-11-30", created_at: "2026-11-01", total: 3, stats: "{}", expired, changes: JSON.stringify(changes) });
    const rowsIn = [mk("a", "pending", false, { title: "x", h1: "y", why: "Searchers want the price" }), mk("b", "pending", false, { bodyHtml: "<p>z</p>" }), mk("c", "pending", true, {})];
    const h = host();
    (h.env.ctx.db as { query: (sql: string) => Promise<Row[]> }).query = async (sql: string) => (/FROM plugin_seo_8099f8879a\.previews/.test(sql) ? rowsIn : []);
    const out = await previewRows(h.env, "co-1", "sp-1");
    expect(out.map((r) => r.expired)).toEqual([false, false, true]);
    expect(out[0]).toMatchObject({ issueIdentifier: "PAR-1", changedFields: ["Title", "Heading"], overlapIds: ["b"] });
    expect(out[1]!.changedFields).toEqual(["Body copy"]);
    expect(out[0]).toMatchObject({ changes: { title: "x", metaDescription: null, h1: "y", bodyMode: null }, why: "Searchers want the price" });
    expect(out[1]).toMatchObject({ changes: { bodyMode: "before" }, why: null });
    expect(out[2]!.overlapIds).toEqual(["a", "b"]);
  });

  describe("live fingerprint and checkLive (PAR-9006)", () => {
    const pageHtml = (title: string, h1 = "Old heading", extra = "") => `<html><head><title>${title}</title><meta name="description" content="Old description"></head><body><h1>${h1}</h1><main><div class="entry-content">${"<p>auction lot listing word </p>".repeat(40)}${extra}</div></main></body></html>`;
    const fp = { title: "Old", metaDescription: "Old description", h1: "Old heading", words: 163, counter: 2 };
    const row = (stats: unknown) => ({ id: "p1", task_id: "t-1", page_url: "https://acme.co.za/", title: "Home", status: "approved", review_status: "passed", expires_at: "2020-01-01", created_at: "2020-01-01", total: 1, stats: JSON.stringify(stats), changes: "{}" });
    const check = async (stats: unknown, live: string | Error, extra: Record<string, unknown> = { checkLive: true }) => {
      const h = host(row(stats));
      h.site.mockImplementation((async () => { if (live instanceof Error) throw live; return { status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: live, ms: 1 }; }) as never);
      const out = (await listPreviews(h.env, "co-1", { sprintId: "sp-1", previewId: "p1", ...extra })) as { previews: Array<Record<string, unknown>> };
      return out.previews[0]!;
    };

    it("create-preview stores stats.liveFingerprint of the live page", async () => {
      const h = host();
      await createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>new intro words</p>" });
      expect(stored(h).stats.liveFingerprint).toEqual({ title: "Old", metaDescription: "", h1: "Old heading", words: 163, counter: 2 });
    });

    it("unchanged when the live page still matches", async () => {
      const first = await check({ liveFingerprint: fp }, pageHtml("Old"));
      expect(first.liveCheck).toEqual({ result: "unchanged" });
    });

    it("changed names the fields that moved", async () => {
      const out = await check({ liveFingerprint: fp }, pageHtml("New title", "New heading", "<p>more words here</p>"));
      expect(out.liveCheck).toEqual({ result: "changed", fields: ["title", "h1", "words"] });
    });

    it("unknown without a stored fingerprint, or when the live page cannot be read", async () => {
      expect(((await check({}, pageHtml("Old"))).liveCheck as { result: string }).result).toBe("unknown");
      expect(((await check({ liveFingerprint: fp }, new Error("timeout"))).liveCheck as { result: string }).result).toBe("unknown");
    });

    it("is not run unless asked, and a listing page skips the word count", async () => {
      expect(await check({ liveFingerprint: fp }, pageHtml("Old"), {})).not.toHaveProperty("liveCheck");
      const listing = `<html><head><title>Cat</title></head><body><h1>Cat</h1><article><p>a</p></article><article><p>b</p></article></body></html>`;
      expect(liveFingerprint(listing)).toEqual({ title: "Cat", metaDescription: "", h1: "Cat", words: null, counter: 2 });
      const out = await check({ liveFingerprint: { title: "Cat", metaDescription: "", h1: "Cat", words: null } }, listing.replace("<p>b</p>", "<p>b b b b</p>"));
      expect(out.liveCheck).toEqual({ result: "unchanged" });
    });
  });

  it("previewId returns the approved copy as changes (and the stored html only with includeHtml); compact rows stay without it", async () => {
    const row = { id: "p1", task_id: "t-1", page_url: "https://acme.co.za/category/x/", title: "X", status: "cancelled", review_status: "passed", expires_at: "2020-01-01", created_at: "2020-01-01", total: 1, stats: {}, html: "<html>stored</html>", changes: JSON.stringify({ title: "T", metaDescription: "M", h1: "H", bodyHtml: "<p>b</p>", bodyMode: "after", css: "x{}" }) };
    type Out = { previews: Array<Record<string, unknown>> };
    const plain = (await listPreviews(host(row).env, "co-1", { sprintId: "sp-1", previewId: "p1" })) as Out;
    expect(plain.previews[0]!.changes).toEqual({ title: "T", metaDescription: "M", h1: "H", bodyHtml: "<p>b</p>", bodyMode: "after", linkEdits: null });
    expect(plain.previews[0]).not.toHaveProperty("html");
    const withHtml = (await listPreviews(host(row).env, "co-1", { sprintId: "sp-1", previewId: "p1", includeHtml: true })) as Out;
    expect(withHtml.previews[0]!.html).toBe("<html>stored</html>");
    const compact = (await listPreviews(host(row).env, "co-1", { sprintId: "sp-1" })) as Out;
    expect(compact.previews[0]).not.toHaveProperty("changes");
    expect(compact.previews[0]).not.toHaveProperty("html");
  });

  it("an old row without a basis lists as source", async () => {
    const row = { id: "p1", task_id: "t-1", page_url: "https://acme.co.za/", title: "Home", status: "pending", review_status: "pending", expires_at: "2026-11-01", created_at: "2026-10-02", total: 1, stats: { keptPct: 91, liveWords: 200 } };
    const list = (await listPreviews(host(row).env, "co-1", { sprintId: "sp-1" })) as { previews: Array<Record<string, unknown>> };
    expect(list.previews[0]).toMatchObject({ keptPct: 91, basis: "source" });
    const full = (await listPreviews(host(row).env, "co-1", { sprintId: "sp-1", previewId: "p1" })) as { previews: Array<{ stats: Record<string, unknown> }> };
    expect(full.previews[0]!.stats.basis).toBe("source");
    expect((await previewRows(host(row).env, "co-1", "sp-1"))[0]).toMatchObject({ keptPct: 91, basis: "source", renderedChecked: false });
  });
});
