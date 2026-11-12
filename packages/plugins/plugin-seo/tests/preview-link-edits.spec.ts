import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, SeoError, type Actor } from "../src/service/common.js";
import { applyLinkEdits, buildPreviewHtml, previewStats } from "../src/engine/preview.js";
import { fallbackWhy } from "../src/engine/why.js";
import { LINK_EDITS_APPLY_GUIDANCE } from "../src/apply-guidance.js";
import { createPreview, listPreviews, parseLinkHref, previewRows } from "../src/service/preview.js";

// PAR-10109: linkEdits wraps one plain-text phrase in <a href>; nothing else on the page moves.
const SOURCE = readFileSync(resolve("tests/fixtures/huntandgun-hunting.html"), "utf-8");
const URL_ = "https://huntandgun.co.za/hunting-in-south-africa/";
const SITE = "https://huntandgun.co.za";
const PHRASE = "extraordinary landscapes, rich wildlife";
const opts = { token: "tok", clientName: "Hunt and Gun" };
const link = (text: string, href = "/buy-a-gun/") => buildPreviewHtml(SOURCE, URL_, { linkEdits: [{ text, href }] }, opts);

describe("engine: applyLinkEdits on the hunting fixture", () => {
  it("wraps the phrase inside the card; kept 100%, 0 added, the rest byte-identical", () => {
    const out = link(PHRASE);
    expect(out.applied).toEqual(["links"]);
    expect(out.html).toContain(`<a href="/buy-a-gun/">${PHRASE}</a>`);
    expect(out.html.replace(`<a href="/buy-a-gun/">${PHRASE}</a>`, PHRASE)).toBe(buildPreviewHtml(SOURCE, URL_, {}, opts).html);
    const stats = previewStats(SOURCE, out.html);
    expect(stats.keptPct).toBe(100);
    expect(stats.addedWords).toBe(0);
  });

  it.each([
    ["not found", "no such phrase anywhere", /phrase not found/],
    ["found twice", "South Africa", /occurs \d+ times/],
    ["inside a heading", "Conclusion", /inside a <h2>/],
    ["inside a link", "Browse From Our Auction", /inside a <h1>|occurs/],
  ])("refuses a phrase that is %s, naming it", (_n, text, re) => {
    const run = () => link(text);
    expect(run).toThrow(SeoError);
    expect(run).toThrow(re);
    expect(run).toThrow(new RegExp(text.slice(0, 10)));
  });

  it("refuses a phrase found once inside an <a>", () => {
    const html = "<html><head></head><body><main><p>See <a href=\"/x\">our shotgun range</a> now</p></main></body></html>";
    expect(() => buildPreviewHtml(html, URL_, { linkEdits: [{ text: "our shotgun range", href: "/y/" }] }, opts)).toThrow(/inside a <a>/);
  });

  it.each(["it's fine here", "rock & roll music", "tom \"quoted\" text", "a -- b dashes", "<b>x</b> tag"])("refuses text with a quote, apostrophe, & or --: %s", (text) => {
    expect(() => link(text)).toThrow(SeoError);
  });

  it("a phrase split by a tag does not match", () => {
    const html = "<html><head></head><body><main><p>big <b>game</b> hunts</p></main></body></html>";
    expect(() => buildPreviewHtml(html, URL_, { linkEdits: [{ text: "big game hunts", href: "/y/" }] }, opts)).toThrow(/not found/);
  });

  it("escapes \" and < in the href", () => {
    const html = applyLinkEdits("<main><p>buy a gun today</p></main>", { innerStart: 6, innerEnd: 28 }, [{ text: "buy a gun", href: "/a\"b<c>&d" }]).html;
    expect(html).toContain('<a href="/a&quot;b&lt;c&gt;&amp;d">buy a gun</a>');
  });
});

describe("service: parseLinkHref", () => {
  it.each([
    "javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "https://evil.example/", "//evil.example", "/\\evil.example",
    "https://huntandgun.co.za@evil.example/", "https://huntandgun.co.za.evil.example/", "https://evil.example/huntandgun.co.za",
  ])("refuses %j", (href) => {
    expect(() => parseLinkHref(href, SITE)).toThrow(SeoError);
  });

  it("accepts the site's own paths and addresses, www or apex", () => {
    expect(parseLinkHref("/buy-a-gun/", SITE)).toBe("/buy-a-gun/");
    expect(parseLinkHref("/buy-a-gun/?a=1#x", SITE)).toBe("/buy-a-gun/?a=1#x");
    expect(parseLinkHref("https://huntandgun.co.za/buy-a-gun/", SITE)).toBe("https://huntandgun.co.za/buy-a-gun/");
    expect(parseLinkHref("https://www.huntandgun.co.za/buy-a-gun/", SITE)).toBe("https://www.huntandgun.co.za/buy-a-gun/");
  });
});

describe("why and guidance", () => {
  it("a links-only change gets the links sentence", () => {
    expect(fallbackWhy({ linkEdits: [{ text: "abc", href: "/x/" }] })).toBe("Links from this page to related pages should help visitors and search engines find them.");
  });
  it("the apply guidance says exactly once and do not apply", () => {
    expect(LINK_EDITS_APPLY_GUIDANCE).toMatch(/exactly once/);
    expect(LINK_EDITS_APPLY_GUIDANCE).toMatch(/do not apply/);
  });
});

describe("service: links-only create-preview", () => {
  const SPRINT = { id: "sp-1", company_id: "co-1", name: "HG", site_url: SITE, site_name: "HG", client_ref: null, client_name: "HG", status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1", project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", site_access: "wordpress", site_id: "site-1", change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" };
  const LIVE = `<html><head><title>Old</title></head><body><main><div class="entry-content"><p>Browse our range of hunting rifles and shotguns for sale today, with plenty of detail.</p><p>${"auction lot listing word ".repeat(30)}</p></div></main></body></html>`;
  const seo: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };

  function host() {
    const created: Array<Record<string, unknown>> = [];
    const stored: unknown[][] = [];
    const ctx = {
      db: {
        namespace: NAMESPACE,
        async query(sql: string) {
          if (/sprints WHERE id/.test(sql)) return [SPRINT];
          if (/count\(\*\)(?! OVER)/.test(sql)) return [{ n: 0 }];
          return [];
        },
        async execute(sql: string, params: unknown[] = []) { if (/INSERT INTO [\w.]*previews/.test(sql)) stored.push(params); return { rowCount: 1 }; },
      },
      config: { get: vi.fn(async () => ({})) },
      companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
      state: { get: vi.fn(async () => null), set: vi.fn() },
      issues: {
        create: vi.fn(async (input: Record<string, unknown>) => { created.push(input); return { id: "rev-1" }; }),
        createComment: vi.fn(async () => ({ id: "c" })),
        requestWakeup: vi.fn(async () => ({ queued: true, runId: null })),
        update: vi.fn(async (id: string) => ({ id })),
      },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as unknown as PluginContext;
    const site = vi.fn(async () => ({ status: 200, url: `${SITE}/`, redirects: [], headers: {}, text: LIVE, ms: 1 }));
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    return { env: createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z"), site: site as never, fetch }), created, stored };
  }

  it("passes the at-least-one-change check, applies links, has no rubric and lists Link added lines", async () => {
    const h = host();
    const out = (await createPreview(h.env, "co-1", seo, { sprintId: "sp-1", pageUrl: "/", linkEdits: [{ text: "hunting rifles and shotguns", href: "https://www.huntandgun.co.za/buy-a-gun/" }, { text: "plenty of detail", href: "/detail/" }] })) as Record<string, unknown> & { applied: string[] };
    expect(out.applied).toEqual(["links"]);
    expect("rubric" in out).toBe(false);
    const text = String(h.created[0]?.description);
    expect(text).not.toMatch(/Creative score/);
    expect(text.match(/^Link added: /gm)).toHaveLength(2);
    expect(text).toContain('Link added: "hunting rifles and shotguns" -> https://www.huntandgun.co.za/buy-a-gun/');
    expect(JSON.parse(String(h.stored[0]?.[8]))).toEqual({ linkEdits: [{ text: "hunting rifles and shotguns", href: "https://www.huntandgun.co.za/buy-a-gun/" }, { text: "plenty of detail", href: "/detail/" }] });
  });

  it("refuses a bad href before any fetch and a missing change message names linkEdits", async () => {
    const h = host();
    await expect(createPreview(h.env, "co-1", seo, { sprintId: "sp-1", pageUrl: "/", linkEdits: [{ text: "plenty of detail", href: "https://evil.example/" }] })).rejects.toThrow(/refused/);
    await expect(createPreview(h.env, "co-1", seo, { sprintId: "sp-1", pageUrl: "/" })).rejects.toThrow(/linkEdits/);
  });
});
