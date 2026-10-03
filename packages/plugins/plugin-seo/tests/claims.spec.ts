import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { checkClaims, factLines, parseFactLines, type ClientFact } from "../src/engine/claims.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { createPreview } from "../src/service/preview.js";
import { getClientFacts, setClientFacts } from "../src/service/facts.js";

const SHEET: ClientFact[] = [
  { kind: "say", text: "Everybody may bid until 19:45 on auction days. Between 19:45 and 20:00 only active bidders may continue bidding, unless the reserve price has not been met, in which case the lot is open to all bidders.", source: "terms 2" },
  { kind: "say", text: "Lots remain the property of the seller until the buyer's transaction has been completed.", source: "terms 19" },
  { kind: "say", text: "Bids go up by a minimum of R50 unless otherwise indicated." },
  { kind: "avoid", text: "inspected and described by our team" },
];

describe("the claims rule", () => {
  it("lets copy without claims through", () => {
    expect(checkClaims(["<h2>Handguns at auction</h2><p>Browse pistols and revolvers listed by sellers across South Africa.</p>"], SHEET)).toEqual([]);
  });

  it("refuses the claims the Reviewer found on Hunt & Gun", () => {
    const v = checkClaims([
      "<p>Open any lot to see its reserve price and current bid.</p><p>If the reserve is met and yours is the last bid when the lot closes, the knife is yours.</p>",
      "Every lot is inspected and described by our team.",
    ], SHEET);
    expect(v.map((x) => x.kind)).toEqual(["unapproved", "unapproved", "avoid"]);
    expect(v[0]!.sentence).toMatch(/reserve price and current bid/);
    expect(v[2]!.why).toMatch(/never to say/);
  });

  it("accepts an approved wording, also cut down, but not a reworded one", () => {
    expect(checkClaims(["Lots remain the property of the seller until the buyer's transaction has been completed."], SHEET)).toEqual([]);
    expect(checkClaims(["Everybody may bid until 19:45 on auction days."], SHEET)).toEqual([]);
    expect(checkClaims(["The item stays the seller's until you have paid and the deal is done."], SHEET)).toEqual([]); // no claim term: not a claim sentence
    expect(checkClaims(["The reserve decides who gets the item at closing time."], SHEET)).toHaveLength(1);
  });

  it("with no fact sheet every claim of those kinds is refused", () => {
    expect(checkClaims(["Free delivery on all orders within 3 days. Guaranteed lowest price."], [])).toHaveLength(2);
  });

  it("round-trips the editor lines", () => {
    const text = factLines(SHEET);
    expect(parseFactLines(text)).toEqual(SHEET.map((f) => ({ ...f, ...(f.source ? { source: f.source } : {}) })));
    expect(parseFactLines("nonsense\n+ ok one | src\n- bad one")).toEqual([{ kind: "say", text: "ok one", source: "src" }, { kind: "avoid", text: "bad one" }]);
  });
});

type Row = Record<string, unknown>;
const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", site_access: "wordpress", site_id: "site-1",
  change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1,
  last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};
const LIVE = `<html><head><title>Old</title></head><body><main><div class="entry-content">${"<p>auction lot listing word </p>".repeat(40)}</div></main></body></html>`;

function host(sheet: ClientFact[] | null) {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string) {
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE id/.test(sql)) return [SPRINT];
        if (/FROM plugin_seo_8099f8879a\.client_facts/.test(sql)) return sheet ? [{ facts: sheet, status: "draft", updated_at: "x" }] : [];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) { executes.push({ sql, params }); return { rowCount: 1 }; },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    state: { get: vi.fn(async () => null), set: vi.fn() },
    issues: { create: vi.fn(async () => ({ id: "rev-1" })), createComment: vi.fn(), requestWakeup: vi.fn(), update: vi.fn() },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  const site = vi.fn(async () => ({ status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: LIVE, ms: 1 }));
  return { env: createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z"), site: site as never }), executes, site };
}
const seo: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };
const user = { kind: "user", userId: "user-1" } as unknown as Actor;
const base = { sprintId: "sp-1", pageUrl: "/" };

describe("licences and questions", () => {
  it("a link label or a question is not a claim; a rule about who needs a licence is", () => {
    expect(checkClaims(["SAPS 271 application for a licence to possess a firearm", "Do I need a licence to buy a gun safe?"], [])).toEqual([]);
    expect(checkClaims(["No firearm licence is needed to buy a gun safe."], [])).toHaveLength(1);
    expect(checkClaims(["You must hold a valid firearm licence to take ownership of a firearm lot."], [])).toHaveLength(1);
  });
});

describe("create-preview and the fact sheet", () => {
  it("refuses unapproved claims before it even fetches the page, and lists the approved wordings", async () => {
    const h = host(SHEET);
    await expect(createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>Open a lot to see its reserve price.</p>" })).rejects.toThrow(/does not cover[\s\S]*Approved wordings you may reuse[\s\S]*Bids go up by a minimum of R50/);
    expect(h.site).not.toHaveBeenCalled();
  });

  it("lets an approved wording through", async () => {
    const h = host(SHEET);
    const out = (await createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>Bids go up by a minimum of R50 unless otherwise indicated.</p>" })) as { reviewStatus: string };
    expect(out.reviewStatus).toBe("pending");
  });
});

describe("the fact sheet", () => {
  it("is readable by agents with the rule and the topics, and editable only by people", async () => {
    const h = host(SHEET);
    const got = (await getClientFacts(h.env, "co-1", { sprintId: "sp-1" })) as { say: Array<{ wording: string }>; avoid: string[]; rule: string; note: string };
    expect(got.say).toHaveLength(3);
    expect(got.avoid).toEqual(["inspected and described by our team"]);
    expect(got.rule).toMatch(/ONLY by reusing/);
    expect(got.note).toMatch(/not yet confirmed/);
    await expect(setClientFacts(h.env, "co-1", seo, { sprintId: "sp-1", text: "+ x" })).rejects.toThrow(/Only a person/);
    const saved = await setClientFacts(h.env, "co-1", user, { sprintId: "sp-1", text: "+ one\n- two", confirm: true });
    expect(saved).toMatchObject({ status: "confirmed", say: 1, avoid: 1 });
    expect(h.executes.some((e) => /INSERT INTO plugin_seo_8099f8879a\.client_facts/.test(e.sql))).toBe(true);
  });
});
