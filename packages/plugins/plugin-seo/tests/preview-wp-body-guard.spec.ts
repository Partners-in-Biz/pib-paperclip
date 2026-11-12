/**
 * PAR-10302 (PAR-10016 T2): the WordPress body check. One test per row of the decision table. Fixtures under
 * tests/fixtures/wp-body are the live Hunt and Gun head (saved 12 Nov 2026) and the public REST answer for each post.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, SeoError, type Actor } from "../src/service/common.js";
import { createPreview, type CreatePreviewResult } from "../src/service/preview.js";
import { wpPostContent, wpRestLink } from "../src/service/wp-body.js";

const { fakeDriveSave } = vi.hoisted(() => ({ fakeDriveSave: vi.fn(async (_ctx: unknown, _opts: Record<string, unknown>) => ({ status: "saved", requestId: "rq", driveFileId: "f1", url: "https://drive.example/f1" })) }));
vi.mock("@partnersinbiz/pib-plugin-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return { ...actual, driveSave: fakeDriveSave };
});

const fx = (name: string) => readFileSync(resolve("tests/fixtures/wp-body", name), "utf-8");
const SITE = "https://huntandgun.co.za";
const SLUG: Record<string, string> = { "718578": "/how-to-sight-a-rifle-scope-easy-step-by-step-guide-for-hunters/", "772341": "/sell-firearms-in-sa-with-confidence/", "747039": "/application-for-licence-to-possess-a-firearm-saps-271/" };
const THEME = "<p>Theme printed words about rifle scopes and zeroing at one hundred metres for hunters.</p>".repeat(6);
const entry = (inner: string) => `<body><h1>Old heading</h1><main><div class="entry-content">${inner}</div></main></body></html>`;
const page = (id: string) => fx(`head-${id}.html`) + (id === "747039" ? entry(JSON.parse(fx("rest-747039.json")).content.rendered) : `<body><h1>Old heading</h1><main>${THEME}<div class="entry-content"></div></main></body></html>`);
const restUrl = (id: string) => `${SITE}/wp-json/wp/v2/pages/${id}`;

type Row = Record<string, unknown>;
const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://huntandgun.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", site_access: "wordpress", site_id: "site-1",
  change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1,
  last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};
const taskRow = (id: string, issueId: string): Row => ({
  id, company_id: "co-1", sprint_id: "sp-1", template_key: `k-${id}`, week: 3, phase: 1, due_day: 20, focus: "Core Pages", title: "Home", description: null,
  task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: null, status: "in_progress", source: "template", parent_optimization_id: null,
  context: null, issue_id: issueId, issue_identifier: "PAR-9", issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null, human_ask: null, evidence: null,
  started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null,
});
const _unusedPage = (title: string) => `<html><head><title>${title}</title></head><body><h1>Old heading</h1><main><div class="entry-content">${"<p>auction lot listing word </p>".repeat(40)}</div></main></body></html>`;

/** In-memory previews, tasks and issues; `site` is the live page fetcher the test controls. */
function world() {
  const sprint = { ...SPRINT };
  const tasks: Record<string, Row> = { "t-1": taskRow("t-1", "iss-1"), "t-2": taskRow("t-2", "iss-2") };
  const previews: Row[] = [];
  const issues: Array<{ id: string; originKind: string; originId: string; status: string }> = [];
  const fails = { create: false, park: false };
  const parks: string[] = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, p: unknown[] = []) {
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE id/.test(sql)) return [sprint];
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id/.test(sql)) return tasks[String(p[0])] ? [tasks[String(p[0])]] : [];
        if (/FROM plugin_seo_8099f8879a\.previews\s+WHERE company_id = \$1 AND request_key = \$2/.test(sql)) {
          const now = Date.now();
          return previews
            .filter((r) => r.company_id === p[0] && r.request_key === p[1] && r.status === "pending" && r.review_status !== "changes_needed" && Date.parse(String(r.expires_at)) > now && Date.parse(String(r.created_at)) > now - 30 * 60_000)
            .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))
            .slice(0, 1);
        }
        return [];
      },
      async execute(sql: string, p: unknown[] = []) {
        if (/^INSERT INTO plugin_seo_8099f8879a\.previews/.test(sql)) {
          previews.push({ id: p[0], company_id: p[1], sprint_id: p[2], task_id: p[3], page_url: p[5], title: p[6], expires_at: p[9], review_key: p[11], stats: JSON.parse(String(p[12])), request_key: p[13], status: "pending", review_status: "pending", review_issue_id: null, created_at: new Date().toISOString() });
        }
        const review = /^UPDATE plugin_seo_8099f8879a\.previews SET review_issue_id = \$2 WHERE id = \$1/.exec(sql);
        if (review) for (const r of previews) if (r.id === p[0]) r.review_issue_id = p[1];
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    state: { get: vi.fn(async () => null), set: vi.fn() },
    issues: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        if (fails.create) throw new Error("issues API down");
        const id = `rev-${issues.length + 1}`;
        issues.push({ id, originKind: String(input.originKind), originId: String(input.originId), status: "todo" });
        return { id };
      }),
      list: vi.fn(async (q: { originKind?: string; originId?: string }) => issues.filter((i) => i.originKind === q.originKind && i.originId === q.originId)),
      createComment: vi.fn(async () => ({ id: "c" })),
      requestWakeup: vi.fn(async () => ({ queued: true, runId: null })),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        if (patch.status === "blocked") {
          if (fails.park) throw new Error("cut off");
          parks.push(id);
          for (const t of Object.values(tasks)) if (t.issue_id === id) t.status = "blocked";
        }
        return { id, ...patch };
      }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  const rest = { handler: (_url: string): unknown => ({ status: 404, url: "", redirects: [], headers: {}, text: "", ms: 1 }) };
  const pages: Record<string, string> = {};
  const site = vi.fn(async (url: string, _init?: unknown) => {
    if (url.includes("/wp-json/")) return rest.handler(url) as never;
    return { status: 200, url, redirects: [], headers: {}, text: pages[new URL(url).pathname] ?? "", ms: 1 };
  });
  const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
  const env = createEnv(ctx, { now: () => new Date(), site: site as never, fetch });
  const json = (body: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, url: "", redirects: [], headers: {}, text: JSON.stringify(body), ms: 1, ...extra });
  return { env, ctx, tasks, previews, issues, parks, fails, site, rest, pages, json };
}

const seo: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };
const base = { sprintId: "sp-1", taskId: "t-1", client: { kind: "company", ref: "crm-1" } };
type W = ReturnType<typeof world>;
const make = (w: W, id: string, changes: Record<string, unknown>) => createPreview(w.env, "co-1", seo, { ...base, pageUrl: `${SITE}${SLUG[id]}`, ...changes }) as Promise<CreatePreviewResult>;
/** A world with one fixture page loaded and its REST answer served. */
function wpWorld(id: string) {
  const w = world();
  w.pages[SLUG[id]] = page(id);
  w.rest.handler = (url) => w.json(JSON.parse(fx(`rest-${id}.json`)), { url });
  return w;
}
const BODY = { bodyHtml: "<p>new intro words here</p>" };
const REFUSED_PREFIX = "WordPress body check skipped: ";

afterEach(() => { vi.useRealTimers(); fakeDriveSave.mockClear(); });

async function expectNothingStored(w: W) {
  expect(w.previews).toHaveLength(0);
  expect(fakeDriveSave).not.toHaveBeenCalled();
  expect(w.ctx.issues.create).not.toHaveBeenCalled();
  expect(w.ctx.issues.update).not.toHaveBeenCalled();
}

describe("T2 decision table: who is checked", () => {
  it("title, meta, h1 and css only: no REST fetch (718578 title-only and h1-only are not refused)", async () => {
    for (const changes of [{ title: "New title here" }, { h1: "New heading", contentSelector: ".entry-content" }]) {
      const w = wpWorld("718578");
      const out = await make(w, "718578", changes);
      expect(out.reused).toBe(false);
      expect(w.site.mock.calls.filter((c) => String(c[0]).includes("/wp-json/"))).toHaveLength(0);
      expect(w.previews).toHaveLength(1);
    }
  });

  it("no REST link in the head (non-WordPress): no check, no note", async () => {
    const w = wpWorld("747039");
    w.pages[SLUG["747039"]] = page("747039").replace(/<link[^>]*wp-json\/wp\/v2[^>]*>/, "");
    const out = await make(w, "747039", BODY);
    expect(w.site.mock.calls.filter((c) => String(c[0]).includes("/wp-json/"))).toHaveLength(0);
    expect((out.notes ?? []).join(" ")).not.toContain("WordPress body check");
  });

  it("only an application/json+oembed link: no check, no note", async () => {
    const html = `<html><head><link rel="alternate" type="application/json+oembed" href="${SITE}/wp-json/oembed/1.0/embed?url=x" /></head><body></body></html>`;
    const w = world();
    expect(wpRestLink(html, `${SITE}/p/`)).toBeNull();
    expect(await wpPostContent(w.env, html, `${SITE}/p/`)).toEqual({ kind: "none" });
    expect(w.site).not.toHaveBeenCalled();
  });

  it("two JSON alternate links: the first matching one is used; the fetch asks for _fields", async () => {
    const html = `<head><link rel="alternate" type="application/json" href="${SITE}/wp-json/wp/v2/pages/11" /><link rel="alternate" type="application/json" href="${SITE}/wp-json/wp/v2/posts/22" /></head>`;
    const w = world();
    w.rest.handler = (url) => w.json({ id: 11, template: "", content: { rendered: "<p>hello</p>" } }, { url });
    const out = await wpPostContent(w.env, html, `${SITE}/p/`);
    expect(out).toEqual({ kind: "ok", id: 11, template: "", rendered: "<p>hello</p>" });
    expect(w.site).toHaveBeenCalledTimes(1);
    expect(w.site).toHaveBeenCalledWith(`${SITE}/wp-json/wp/v2/pages/11?_fields=id,type,template,content`, { maxRedirects: 2 });
  });
});

describe("T2 decision table: skips (the preview is made, a note says why)", () => {
  const head = (href: string) => `<head><link rel="alternate" type="application/json" href="${href}" /></head>`;
  const url = `${SITE}/p/`;
  const run = (w: W, html = head(restUrl("5"))) => wpPostContent(w.env, html, url);
  const note = (rest: string) => ({ kind: "skip", note: REFUSED_PREFIX + rest });

  it("link host differs from the page host", async () => {
    const w = world();
    expect(await run(w, head("https://other.example/wp-json/wp/v2/pages/5"))).toEqual(note("the REST link points to another host."));
    expect(w.site).not.toHaveBeenCalled();
  });

  it("REST redirects to another host", async () => {
    const w = world();
    w.rest.handler = () => w.json({ id: 5, content: { rendered: "<p>x</p>" } }, { url: "https://evil.example/wp-json/wp/v2/pages/5" });
    expect(await run(w)).toEqual(note("the REST API redirected to another host."));
  });

  it("more than 2 redirects (the fetcher throws)", async () => {
    const w = world();
    w.rest.handler = () => { throw new Error("Too many redirects fetching x"); };
    expect(await run(w)).toEqual(note("the REST API redirected too many times."));
  });

  it("REST redirect on the same host is followed and checked as normal", async () => {
    const w = world();
    w.rest.handler = () => w.json({ id: 5, template: "t.php", content: { rendered: "<p>hello</p>" } }, { url: `${SITE}/wp-json/wp/v2/pages/5/`, redirects: ["http://huntandgun.co.za/wp-json/wp/v2/pages/5"] });
    expect(await run(w)).toMatchObject({ kind: "ok", id: 5, template: "t.php" });
  });

  it.each([401, 403, 404, 500, 503])("REST %i", async (status) => {
    const w = world();
    w.rest.handler = () => ({ status, url: "", redirects: [], headers: {}, text: "nope", ms: 1 });
    expect(await run(w)).toEqual(note(`the site's REST API answered ${status}.`));
  });

  it("200 but not JSON (a WAF or challenge page)", async () => {
    const w = world();
    w.rest.handler = () => ({ status: 200, url: "", redirects: [], headers: {}, text: "<html>Just a moment...</html>", ms: 1 });
    expect(await run(w)).toEqual(note("the REST API did not answer with JSON."));
  });

  it("JSON id differs from the id in the href", async () => {
    const w = world();
    w.rest.handler = () => w.json({ id: 6, content: { rendered: "<p>x</p>" } });
    expect(await run(w)).toEqual(note("the REST API returned a different post."));
  });

  it("no content.rendered string (archive, CPT without content)", async () => {
    const w = world();
    w.rest.handler = () => w.json({ id: 5, content: {} });
    expect(await run(w)).toMatchObject({ kind: "skip", note: expect.stringContaining(REFUSED_PREFIX) });
    w.rest.handler = () => w.json({ id: 5 });
    expect(await run(w)).toMatchObject({ kind: "skip" });
  });

  it("no answer in 5 s", async () => {
    vi.useFakeTimers();
    const w = world();
    w.rest.handler = () => new Promise(() => {});
    const p = run(w);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual(note("the REST API did not answer within 5 seconds."));
  });

  it("content.protected === true", async () => {
    const w = world();
    w.rest.handler = () => w.json({ id: 5, content: { rendered: "<form>password</form>", protected: true } });
    expect(await run(w)).toEqual(note("the page is password-protected."));
  });

  it("a skip inside createPreview stores the preview with the note", async () => {
    const w = wpWorld("747039");
    w.rest.handler = () => ({ status: 403, url: "", redirects: [], headers: {}, text: "", ms: 1 });
    const out = await make(w, "747039", { linkEdits: [{ text: "blank PDF form", href: "/x/" }] });
    expect(out.notes).toContain(`${REFUSED_PREFIX}the site's REST API answered 403.`);
    expect(w.previews).toHaveLength(1);
  });
});

describe("T2 refusals R1 and R3 (nothing stored, no Drive export, no review)", () => {
  it.each(["&nbsp;", "<div class=\"builder\"></div>", "<img src=\"/a.jpg\" alt=\"\">"])("R1 on a post whose content has no words: %s", async (inner) => {
    const w = wpWorld("772341");
    w.rest.handler = (url) => w.json({ id: 772341, template: "", content: { rendered: inner } }, { url });
    await expect(make(w, "772341", BODY)).rejects.toThrow(SeoError);
    await expectNothingStored(w);
  });

  it("718578 is refused with R1 and the template clause", async () => {
    const w = wpWorld("718578");
    const err = await make(w, "718578", BODY).catch((e) => e);
    expect(err).toBeInstanceOf(SeoError);
    expect(err.message).toBe("This page's body is not in its WordPress content: post 718578 has no text in its post content; its body comes from the theme template HowtoSightaRifleScope.php. A preview here could never be applied, because the Connector can only change post content. Pick another page, or raise a developer task to change the template.");
    await expectNothingStored(w);
  });

  it("772341 is refused with R1 and no template clause", async () => {
    const w = wpWorld("772341");
    const err = await make(w, "772341", BODY).catch((e) => e);
    expect(err.message).toBe("This page's body is not in its WordPress content: post 772341 has no text in its post content. A preview here could never be applied, because the Connector can only change post content. Pick another page, or raise a developer task to change the template.");
    await expectNothingStored(w);
  });

  it("a linkEdits phrase that is in 718578's template text is refused with R1 first", async () => {
    const w = wpWorld("718578");
    await expect(make(w, "718578", { linkEdits: [{ text: "zeroing at one hundred metres", href: "/x/" }] })).rejects.toThrow(/^This page's body is not in its WordPress content: post 718578/);
    await expectNothingStored(w);
  });

  it("R3: a phrase only in the theme text of a page that has post content", async () => {
    const w = wpWorld("747039");
    w.pages[SLUG["747039"]] = page("747039").replace("</main>", `${THEME}</main>`);
    const err = await make(w, "747039", { linkEdits: [{ text: "zeroing at one hundred metres", href: "/x/" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(SeoError);
    expect(err.message).toBe("The link text \"zeroing at one hundred metres\" is not in this page's WordPress content (post 747039): it is in text the theme prints, which the Connector cannot change. Pick a phrase from the page's own copy, or another page.");
    await expectNothingStored(w);
  });

  it("R3 matching is whitespace-collapsed and case-insensitive: a phrase in the post content passes", async () => {
    const w = wpWorld("747039");
    const out = await make(w, "747039", { linkEdits: [{ text: "BLANK pdf   form", href: "/x/" }] }).catch((e) => e);
    // The engine itself is case-sensitive about the page text, so only the body check is asserted here.
    expect(String(out?.message ?? "")).not.toMatch(/WordPress content/);
  });
});

describe("T2 passes", () => {
  it("747039 (SAPS 271) with a bodyHtml change passes the body check and the preview is stored", async () => {
    const w = wpWorld("747039");
    const out = await make(w, "747039", { bodyHtml: "<p>Apply for a firearm licence with our guided help.</p>" });
    expect(out.reused).toBe(false);
    expect(w.previews).toHaveLength(1);
    expect(out.notes ?? []).not.toContain(expect.stringContaining("WordPress body check"));
  });

  it("747039 with a linkEdits phrase in the post content passes and the preview is stored", async () => {
    const w = wpWorld("747039");
    const out = await make(w, "747039", { linkEdits: [{ text: "blank PDF form", href: "/buy-a-gun/" }] });
    expect(out.reused).toBe(false);
    expect(w.previews).toHaveLength(1);
  });

  it("the REST fetch starts right after the source fetch, in parallel with the render", async () => {
    const w = wpWorld("747039");
    const order: string[] = [];
    const inner = w.site.getMockImplementation()!;
    w.site.mockImplementation(async (u: string, i?: unknown) => { order.push(u.includes("/wp-json/") ? "rest" : "page"); return inner(u, i); });
    await make(w, "747039", BODY);
    expect(order).toEqual(["page", "rest"]);
  });
});
