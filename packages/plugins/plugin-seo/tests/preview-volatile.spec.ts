// PAR-9945: a title-and-meta-only preview of a WooCommerce product page showed 99% kept in create-preview and 83% on
// the review page. The review page measures a fresh load of the live page, and WooCommerce picks the "Related courses"
// products at random on every load; a page built from the source also lost the script that hides all tabs but one.
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { buildPreviewHtml, fingerprintChanges, liveFingerprint, previewStats, visibleWords } from "../src/engine/preview.js";
import { createPreview, listPreviews } from "../src/service/preview.js";
import { wordsOf } from "../ops/preview-server/render.mjs";

const course = (name: string) =>
  `<div class="product type-product kad_product"><a href="https://acme.co.za/product/${name.toLowerCase()}/"><h5>${name}</h5></a><div class="product_excerpt">This ${name} course covers everything you need to know to run a farm well, with practical guidance and planning skills.</div><span class="price">R 1200,00</span><a class="button">Add to cart</a></div>`;

/** One load of a WooCommerce product page: its related strip shows these courses. `tabsHidden` = as the browser leaves it. */
const productPage = (related: string[], tabsHidden = false) => `<!DOCTYPE html><html><head><title>Hydroponics Course</title><meta name="description" content="Old description"></head><body>
<header><nav>Home Courses Contact</nav></header>
<div class="product"><h1 class="product_title entry-title">Hydroponics Course</h1>
<div class="woocommerce-tabs wc-tabs-wrapper"><ul class="tabs wc-tabs"><li><a href="#tab-description">Course Overview</a></li><li><a href="#tab-who">Who Should Enrol</a></li></ul>
<div class="woocommerce-Tabs-panel panel entry-content wc-tab" id="tab-description"${tabsHidden ? ' style=""' : ""}>${"<p>Grow crops without soil using nutrient solutions and controlled water systems. </p>".repeat(12)}</div>
<div class="woocommerce-Tabs-panel panel entry-content wc-tab" id="tab-who"${tabsHidden ? ' style="display: none;"' : ""}><p>Farm workers, small growers and anyone starting a soil-less farming unit.</p></div>
</div>
<section class="related products"><h2>Related courses</h2><div id="product_wrapper" class="products kt-masonry-init">${related.map(course).join("")}</div></section>
</div><footer>Agri Studies 2026</footer></body></html>`;

const LOAD_A = productPage(["Poultry", "Dairy", "Irrigation", "Vegetables"]);
const LOAD_B = productPage(["Budgets", "Accounts", "Piggery", "Fieldcrops"]);
const meta = { title: "Hydroponics Course: Soil-Less Farming | Agri Studies", metaDescription: "Hydroponics course on soil-less farming." };

describe("kept-text figure on a page with a random product strip", () => {
  it("two loads of the same page count the same: only the strip's heading is counted", () => {
    expect(visibleWords(LOAD_A)).toEqual(visibleWords(LOAD_B));
    expect(visibleWords(LOAD_A)).toContain("related");
    expect(visibleWords(LOAD_A)).not.toContain("irrigation");
    expect(previewStats(LOAD_A, LOAD_B).keptPct).toBe(100);
  });

  it("the review page counts words exactly as create-preview does (render.mjs wordsOf = engine visibleWords)", () => {
    const built = buildPreviewHtml(LOAD_A, "https://acme.co.za/product/hydroponics-course/", meta, { token: "tok" }).html;
    for (const html of [LOAD_A, LOAD_B, productPage(["X"], true), built]) expect(wordsOf(html)).toEqual(visibleWords(html));
  });

  it("a metadata-only proposal measured against a later load of the live page stays at the create-preview figure", () => {
    const built = buildPreviewHtml(LOAD_A, "https://acme.co.za/product/hydroponics-course/", meta, { token: "tok" }).html;
    const atCreate = previewStats(LOAD_A, built).keptPct;
    // What the review page does: a fresh live load (other related products) against the stored proposal.
    const a = wordsOf(LOAD_B);
    const pool = new Map<string, number>();
    for (const w of wordsOf(built)) pool.set(w, (pool.get(w) ?? 0) + 1);
    let kept = 0;
    for (const w of a) if ((pool.get(w) ?? 0) > 0) { kept += 1; pool.set(w, pool.get(w)! - 1); }
    expect(atCreate).toBe(100);
    expect(Math.round((kept / a.length) * 100)).toBe(atCreate);
  });

  it("a proposal that really drops the strip still loses its heading", () => {
    const dropped = LOAD_A.replace(/<section class="related products">[\s\S]*?<\/section>/, "");
    expect(previewStats(LOAD_A, dropped).removedWords).toBe(2);
  });
});

describe("entities are counted as a browser shows them", () => {
  it("the source's &#82; and &ldquo; count as the rendered page's R and quote marks, in both counters", () => {
    const source = "<p>Price &#82; 1200,00 &ldquo;Grow&rdquo; &amp; learn&hellip; &copy; Agri &#x52;</p>";
    const rendered = "<p>Price R 1200,00 \u201cGrow\u201d & learn\u2026 \u00a9 Agri R</p>";
    expect(visibleWords(source)).toEqual(visibleWords(rendered));
    expect(wordsOf(source)).toEqual(visibleWords(source));
  });

  it("a fingerprint stored before the new count is not flagged as a changed page", () => {
    const now = liveFingerprint(LOAD_B);
    expect(fingerprintChanges({ ...now, words: now.words! + 120, counter: undefined }, now)).toEqual([]);
    expect(fingerprintChanges({ ...now, words: now.words! + 1 }, now)).toEqual(["words"]);
    expect(fingerprintChanges(liveFingerprint(LOAD_A), now)).toEqual([]);
  });
});

describe("the proposal body matches the live page", () => {
  it("keeps the related strip and hides all tabs but the first when built from the source", () => {
    const out = buildPreviewHtml(LOAD_A, "https://acme.co.za/product/hydroponics-course/", meta, { token: "tok" });
    expect(out.html).toContain('<section class="related products"><h2>Related courses</h2>');
    expect(out.html).toContain("Irrigation");
    expect(out.html).toContain('<style id="pib-wc-tabs">.wc-tabs-wrapper .wc-tab ~ .wc-tab{display:none}</style></head>');
    expect(out.notes.join(" ")).toMatch(/picks its products at random on every load/);
    // Only the head changed: the body is the live body plus the preview bar.
    const proposed = out.html.slice(out.html.indexOf("<body>"), out.html.indexOf('<div id="pib-preview-bar"'));
    expect(proposed).toBe(LOAD_A.slice(LOAD_A.indexOf("<body>"), LOAD_A.indexOf("</body>")));
  });

  it("adds nothing to a page without WooCommerce tabs or a product strip", () => {
    const plain = "<html><head><title>x</title></head><body><main><p>Plain page words</p></main></body></html>";
    const out = buildPreviewHtml(plain, "https://acme.co.za/", meta, { token: "tok" });
    expect(out.html).not.toContain("pib-wc-tabs");
    expect(out.notes.join(" ")).not.toMatch(/random/);
  });
});

describe("create-preview waits for a busy render service", () => {
  const SPRINT = {
    id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
    status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
    project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", site_access: "wordpress", site_id: "site-1",
    change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1,
    last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  };
  const seo: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };
  function host(fetch: (url: string) => Promise<Response>) {
    const executes: Array<{ sql: string; params: unknown[] }> = [];
    const ctx = {
      db: {
        namespace: NAMESPACE,
        async query(sql: string) {
          if (/FROM plugin_seo_8099f8879a\.sprints WHERE id/.test(sql)) return [SPRINT];
          return [];
        },
        async execute(sql: string, params: unknown[] = []) { executes.push({ sql, params }); return { rowCount: 1 }; },
      },
      config: { get: vi.fn(async () => ({})) },
      companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
      state: { get: vi.fn(async () => null), set: vi.fn() },
      issues: { create: vi.fn(async () => ({ id: "rev-1" })), createComment: vi.fn(async () => ({ id: "c" })), requestWakeup: vi.fn(async () => ({ queued: true })), update: vi.fn(async () => ({})) },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as unknown as PluginContext;
    const site = vi.fn(async () => ({ status: 200, url: "https://acme.co.za/product/hydroponics-course/", redirects: [], headers: {}, text: LOAD_A, ms: 1 }));
    const f = vi.fn(fetch);
    return { env: createEnv(ctx, { now: () => new Date(), site: site as never, fetch: f as never }), executes, fetch: f };
  }

  it("asks again after a 503 and builds from the render; list-previews shows the create-preview figure", async () => {
    let calls = 0;
    const h = host(async () => (++calls === 1 ? new Response(JSON.stringify({ error: "a render is already running" }), { status: 503 }) : new Response(JSON.stringify({ html: productPage(["Budgets", "Accounts"], true) }), { status: 200 })));
    const out = (await createPreview(h.env, "co-1", seo, { sprintId: "sp-1", pageUrl: "/product/hydroponics-course/", ...meta })) as { basis: string; stats: { rendered: { keptPct: number } } };
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(out.basis).toBe("rendered");
    expect(out.stats.rendered.keptPct).toBe(100);
    const insert = h.executes.find((e) => /INSERT INTO plugin_seo_8099f8879a\.previews/.test(e.sql))!;
    const html = String(insert.params[7]);
    expect(html).toContain('id="tab-who" style="display: none;"');
    const row = { id: "p1", page_url: "https://acme.co.za/product/hydroponics-course/", title: "Hydroponics", status: "pending", review_status: "pending", expires_at: "2026-11-20", created_at: "2026-11-12", total: 1, stats: String(insert.params[12]) };
    const listHost = host(async () => new Response("{}"));
    (listHost.env.ctx.db as { query: (sql: string) => Promise<unknown[]> }).query = async () => [row];
    const list = (await listPreviews(listHost.env, "co-1", { sprintId: "sp-1" })) as { previews: Array<Record<string, unknown>> };
    expect(list.previews[0]).toMatchObject({ keptPct: out.stats.rendered.keptPct, basis: "rendered" });
  });
});
