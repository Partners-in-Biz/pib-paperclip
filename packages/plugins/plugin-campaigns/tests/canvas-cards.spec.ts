/**
 * The Campaigns card on a planning canvas (PAR-14423; plan PAR-14389 C.2 and E). The manifest declares the slot and the
 * worker registers through the kit helper; `resolve`, `search` and `related` agree with the page's own actions for an
 * admin, a plain member and a member the page refuses; another company's id, an unknown id and a closed caller all read
 * as hidden or empty.
 */
import { readFileSync } from "node:fs";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import { ACCESS_TEST_IDS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { accessCompanyScope } from "@partnersinbiz/pib-plugin-kit";
import { describe, expect, it } from "vitest";
import { CAMPAIGN_CARD } from "../src/canvas-cards.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { boot, campaign, CO, seed, type Harness } from "./helpers/harness.js";

const T = ACCESS_TEST_IDS;
const person = (userId: string, restricted = false, companyId = CO) => ({
  companyId,
  actor: { type: "user" as const, userId, agentId: null, runId: null, companyId, onBehalfOfUserId: userId, onBehalfOfRestricted: restricted },
});
const ADMIN = person("user-admin");
const MEMBER = person("user-member");
const RESOLVE = "canvas.cards.resolve";
const SEARCH = "canvas.cards.search";
const RELATED = "canvas.cards.related";
const CRM = "partnersinbiz.crm";

function seeded() {
  const store = seed();
  store.campaigns!.push(
    campaign("news-1", { name: "Spring newsletter", status: "active", created_at: "2026-09-03T00:00:00Z" }),
    campaign("news-2", { name: "Autumn NEWS", status: "draft", created_at: "2026-09-02T00:00:00Z" }),
    campaign("promo", { name: "Promo run", status: "paused", created_at: "2026-09-01T00:00:00Z" }),
    campaign("acme-1", { name: "Acme onboarding", status: "active", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }),
    campaign("ada-1", { name: "Ada follow-up", status: "draft", client_kind: "contact", client_ref: "ada", client_name: "Ada Lovelace" }),
    campaign("other-co", { name: "Other company", company_id: "co-other" }),
  );
  return store;
}

type Page = { campaigns: Array<{ id: string; name: string; status: string }> };
const page = (harness: Harness, who: ReturnType<typeof person>, params: Record<string, unknown> = {}) =>
  harness.performAction<Page>("campaigns.load", params, who);
/** The page's search box (ui/index.tsx): name or status label contains the text. */
const pageSearch = async (harness: Harness, who: ReturnType<typeof person>, q: string) => {
  const labels: Record<string, string> = { active: "Active", completed: "Completed", draft: "Draft", scheduled: "Scheduled", paused: "Paused" };
  const needle = q.trim().toLowerCase();
  return (await page(harness, who)).campaigns.filter((c) => !needle || c.name.toLowerCase().includes(needle) || (labels[c.status] ?? c.status).toLowerCase().includes(needle)).map((c) => c.id);
};
const ids = (cards: Array<{ id: string }>) => cards.map((c) => c.id);

describe("Campaigns entity card wiring", () => {
  it("declares the card-campaign slot with entityCard, and the worker registers through registerCanvasCards", () => {
    const slot = manifest.ui?.slots?.find((s) => s.id === CAMPAIGN_CARD);
    expect(slot).toMatchObject({ type: "canvasNode", exportName: "CampaignCanvasCard", entityCard: { kind: "campaign", search: true, related: true } });
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(worker).toMatch(/registerCanvasCards\(\{ register: g\.action,/);
    expect(readFileSync(new URL("../src/ui/index.tsx", import.meta.url), "utf8")).toContain("CampaignCanvasCard");
  });
});

describe.each([["an admin", ADMIN], ["a plain member", MEMBER]])("Campaigns card parity for %s", (_name, who) => {
  it("resolve agrees with campaigns.detail record by record; another company, an unknown id and a closed id are hidden", async () => {
    const { harness } = await boot({ store: seeded() });
    const asked = ["news-1", "promo", "other-co", "no-such", "acme-1"];
    const out = await harness.performAction<{ cards: Array<Record<string, any>> }>(RESOLVE, { items: asked.map((id) => ({ type: CAMPAIGN_CARD, id })) }, who);
    expect(out.cards.map((c) => c.id)).toEqual(asked);
    for (const card of out.cards) {
      const detail = await harness.performAction<{ campaign: { name: string; status: string } }>("campaigns.detail", { campaignId: card.id }, who).catch(() => null);
      if (!detail) {
        expect(card).toEqual({ type: CAMPAIGN_CARD, id: card.id, hidden: true });
      } else {
        expect(card).toMatchObject({ type: CAMPAIGN_CARD, title: detail.campaign.name, href: `/campaigns?campaign=${card.id}` });
        expect(card.status.toLowerCase()).toBe(detail.campaign.status);
      }
    }
    expect(out.cards.filter((c) => c.hidden).map((c) => c.id)).toEqual(["other-co", "no-such"]);
  });

  it("search equals the page's own list for the same text", async () => {
    const { harness } = await boot({ store: seeded() });
    for (const q of ["news", "NEWS", "  draft ", "act", "zzz", ""]) {
      const out = await harness.performAction<{ cards: Array<{ id: string }> }>(SEARCH, { type: CAMPAIGN_CARD, q }, who);
      expect(ids(out.cards), `q="${q}"`).toEqual(await pageSearch(harness, who, q));
    }
    const limited = await harness.performAction<{ cards: Array<{ id: string }> }>(SEARCH, { type: CAMPAIGN_CARD, q: "", limit: 2 }, who);
    expect(ids(limited.cards)).toEqual(["news-1", "news-2"]);
  });

  it("related answers a CRM client with the page's list for that client", async () => {
    const { harness } = await boot({ store: seeded() });
    for (const [type, id, client] of [["card-company", "acme", "company:acme"], ["card-contact", "ada", "contact:ada"]] as const) {
      const out = await harness.performAction<{ groups: Array<{ relation: string; type: string; cards: Array<{ id: string }> }> }>(RELATED, { of: { plugin: CRM, type, id } }, who);
      const expected = ids((await page(harness, who, { client })).campaigns);
      expect(expected.length).toBe(1);
      expect(out.groups).toHaveLength(1);
      expect(out.groups[0]).toMatchObject({ relation: "campaigns", type: CAMPAIGN_CARD });
      expect(ids(out.groups[0]!.cards)).toEqual(expected);
    }
  });

  it("related with a client the caller cannot see in CRM answers what the page shows for that client", async () => {
    const { harness } = await boot({ store: seeded() });
    // CRM company "ghost" is not in the CRM copy: the page lists nothing for it, so the card says nothing either.
    const page_ = await page(harness, who, { client: "company:ghost" }).catch(() => ({ campaigns: [] as Page["campaigns"] }));
    const out = await harness.performAction<{ groups: unknown[] }>(RELATED, { of: { plugin: CRM, type: "card-company", id: "ghost" } }, who);
    expect(page_.campaigns).toEqual([]);
    expect(out.groups).toEqual([]);
    // An `of` from another plugin is not a CRM client.
    expect(await harness.performAction(RELATED, { of: { plugin: "partnersinbiz.billing", type: "card-invoice", id: "acme" } }, who)).toEqual({ groups: [] });
  });
});

describe("Campaigns card for callers the page closes", () => {
  it("a restricted member gets hidden and empty answers", async () => {
    const { harness } = await boot({ store: seeded() });
    const who = person("user-restricted", true);
    expect(await harness.performAction(RESOLVE, { items: [{ type: CAMPAIGN_CARD, id: "news-1" }] }, who)).toEqual({ cards: [{ type: CAMPAIGN_CARD, id: "news-1", hidden: true }] });
    expect(await harness.performAction(SEARCH, { type: CAMPAIGN_CARD, q: "" }, who)).toEqual({ cards: [] });
    expect(await harness.performAction(RELATED, { of: { plugin: CRM, type: "card-company", id: "acme" } }, who)).toEqual({ groups: [] });
  });

  it("with the access switch on enforce, a member without campaigns.view is refused as on the page; the owner is answered", async () => {
    const harness = createTestHarness({ manifest });
    const at = new Date().toISOString();
    const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: T.enforce, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
    harness.seed({ accessMembers: [member(T.owner, "owner"), member(T.operator, "member")] });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(accessCompanyScope(T.enforce), { mode: "enforce", rev: 1, userIds: [], receivedAt: at });
    const as = (userId: string) => ({ companyId: T.enforce, actor: { type: "user" as const, userId, agentId: null, runId: null, companyId: T.enforce, onBehalfOfUserId: userId, onBehalfOfRestricted: false } });
    const calls: Array<[string, Record<string, unknown>]> = [
      [RESOLVE, { items: [{ type: CAMPAIGN_CARD, id: "x" }] }],
      [SEARCH, { type: CAMPAIGN_CARD, q: "" }],
      [RELATED, { of: { plugin: CRM, type: "card-company", id: "acme" } }],
    ];
    const pageRefusal = await harness.performAction("campaigns.detail", {}, as(T.operator));
    expect(pageRefusal).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
    for (const [key, params] of calls) {
      expect(await harness.performAction(key, params, as(T.operator)), key).toEqual(pageRefusal);
      expect(await harness.performAction(key, params, as(T.owner)).catch((e: unknown) => e), key).not.toMatchObject({ refused: true });
    }
  });

  it("an agent caller is refused: cards answer people only", async () => {
    const { harness } = await boot({ store: seeded() });
    const out = await harness.performAction(SEARCH, { type: CAMPAIGN_CARD, q: "" }, { companyId: CO, actor: { type: "agent", userId: null, agentId: "agent-camp", runId: "run-1", companyId: CO } } as never);
    expect(out).toMatchObject({ ok: false, refused: true });
  });
});
