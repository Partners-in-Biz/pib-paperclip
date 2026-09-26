import { readFileSync } from "node:fs";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { audienceContacts, clientCampaignCounts, listCampaigns } from "../src/db.js";
import {
  assertAudienceMode,
  audienceSource,
  campaignClientSummary,
  clientPrefix,
  createCampaign,
  stepIssueCopy,
  withClient,
} from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";

const acme = { kind: "company" as const, id: "co-acme", name: "Acme" };
const ada = { kind: "contact" as const, id: "ct-ada", name: "Ada Lovelace" };

function fakeCtx(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return rows;
      },
      execute: async () => ({ rowCount: 0 }),
    },
  } as unknown as PluginContext;
  return { ctx, calls };
}

function contactRow(id: string, tags: string[], accountIds: string[] = []) {
  return { id, name: id, emails: [`${id}@example.test`], phones: [], lifecycle: null, tags, account_ids: accountIds };
}

describe("campaign client migration", () => {
  it("adds client and audience columns without touching data", () => {
    const sql = readFileSync(new URL("../migrations/009_campaigns.sql", import.meta.url), "utf8");
    for (const column of ["client_kind text", "client_ref text", "client_name text", "audience_mode text NOT NULL DEFAULT 'tags'"]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain(`CREATE INDEX campaigns_client ON ${NAMESPACE}.campaigns`);
    expect(sql).not.toMatch(/\bdelete\b/i);
  });
});

describe("campaign client scope", () => {
  it("defaults the audience from the client", () => {
    expect(createCampaign({ companyId: "w", name: "Own" }).audienceMode).toBe("tags");
    const company = createCampaign({ companyId: "w", name: "Nurture", client: acme });
    expect(company).toMatchObject({ clientKind: "company", clientRef: "co-acme", clientName: "Acme", audienceMode: "client_contacts" });
    expect(createCampaign({ companyId: "w", name: "Hi", client: ada }).audienceMode).toBe("client_contact");
    expect(createCampaign({ companyId: "w", name: "Wide", client: acme, audienceMode: "tags" }).audienceMode).toBe("tags");
  });

  it("refuses an audience that does not fit the client", () => {
    expect(() => assertAudienceMode("client_contacts", null)).toThrow(/company client/);
    expect(() => assertAudienceMode("client_contacts", { kind: "contact", id: "x" })).toThrow(/company client/);
    expect(() => assertAudienceMode("client_contact", { kind: "company", id: "x" })).toThrow(/contact client/);
    expect(() => assertAudienceMode("everyone", null)).toThrow(/audienceMode must be/);
  });

  it("resets the audience when a draft moves to another client", () => {
    const own = createCampaign({ companyId: "w", name: "Own", audienceTags: ["hot"] });
    const moved = withClient(own, acme);
    expect(moved).toMatchObject({ clientRef: "co-acme", audienceMode: "client_contacts", audienceTags: ["hot"] });
    expect(withClient(withClient(moved, acme, "tags"), acme).audienceMode).toBe("tags");
    const back = withClient(moved, null);
    expect(back).toMatchObject({ clientKind: null, clientRef: null, clientName: null, audienceMode: "tags" });
    expect(() => withClient(own, ada, "client_contacts")).toThrow(/company client/);
  });

  it("prefixes client issue titles with the client name", () => {
    const step = { position: 1, delayDays: 0, subject: "Welcome", body: "Hi", htmlBody: null, variant: "a" as const };
    expect(stepIssueCopy("Bob", step, "Acme").title).toBe("[Acme] Welcome: Bob");
    expect(stepIssueCopy("Bob", step, null).title).toBe("Welcome: Bob");
    expect(clientPrefix("  ")).toBe("");
  });
});

describe("campaign audience", () => {
  it("picks the source from the audience mode", () => {
    expect(audienceSource(createCampaign({ companyId: "w", name: "A", audienceTags: ["vip"] }))).toEqual({ kind: "tags", tags: ["vip"] });
    expect(audienceSource(createCampaign({ companyId: "w", name: "B", client: acme, audienceTags: ["vip"] })))
      .toEqual({ kind: "company-contacts", crmCompanyId: "co-acme", tags: ["vip"] });
    expect(audienceSource(createCampaign({ companyId: "w", name: "C", client: ada }))).toEqual({ kind: "contact", contactId: "ct-ada" });
    const orphan = { ...createCampaign({ companyId: "w", name: "D", client: acme }), clientRef: null, clientKind: null };
    expect(audienceSource(orphan)).toEqual({ kind: "tags", tags: [] });
  });

  it("enrolls the contacts at the client company, narrowed by tags", async () => {
    const { ctx, calls } = fakeCtx([contactRow("c1", ["vip"], ["co-acme"]), contactRow("c2", ["cold"], ["co-acme"])]);
    const all = await audienceContacts(ctx, "w", createCampaign({ companyId: "w", name: "B", client: acme }));
    expect(all.map((contact) => contact.id)).toEqual(["c1", "c2"]);
    expect(calls[0]!.sql).toContain("$2 = ANY(account_ids)");
    expect(calls[0]!.params).toEqual(["w", "co-acme"]);
    const vip = await audienceContacts(ctx, "w", createCampaign({ companyId: "w", name: "B", client: acme, audienceTags: ["VIP"] }));
    expect(vip.map((contact) => contact.id)).toEqual(["c1"]);
  });

  it("enrolls only the client contact for a contact client", async () => {
    const { ctx, calls } = fakeCtx([contactRow("ct-ada", [])]);
    const contacts = await audienceContacts(ctx, "w", createCampaign({ companyId: "w", name: "C", client: ada }));
    expect(contacts.map((contact) => contact.id)).toEqual(["ct-ada"]);
    expect(calls[0]!.sql).toContain("id = ANY(");
    expect(calls[0]!.params).toEqual(["w", JSON.stringify(["ct-ada"])]);
  });

  it("keeps tag audiences for own work", async () => {
    const { ctx } = fakeCtx([contactRow("a", ["hot"]), contactRow("b", ["cold"])]);
    const contacts = await audienceContacts(ctx, "w", createCampaign({ companyId: "w", name: "A", audienceTags: ["hot"] }));
    expect(contacts.map((contact) => contact.id)).toEqual(["a"]);
  });
});

describe("campaign scoped queries", () => {
  it("lists only own campaigns when no client is given", async () => {
    const { ctx, calls } = fakeCtx();
    await listCampaigns(ctx, "w");
    expect(calls[0]!.sql).toContain("WHERE company_id = $1 AND client_ref IS NULL");
    expect(calls[0]!.params).toEqual(["w"]);
  });

  it("lists one client's campaigns by kind and id", async () => {
    const { ctx, calls } = fakeCtx([
      { id: "c1", company_id: "w", name: "N", description: "", status: "draft", from_name: "", from_local: "campaigns", reply_to: null, audience_tags: "[]", start_at: null, end_at: null, approval_issue_id: null, winner_variant: null, client_kind: "company", client_ref: "co-acme", client_name: "Acme", audience_mode: "client_contacts" },
    ]);
    const campaigns = await listCampaigns(ctx, "w", { kind: "company", id: "co-acme" });
    expect(calls[0]!.sql).toContain("client_ref = $3 AND COALESCE(client_kind, 'company') = $2");
    expect(calls[0]!.params).toEqual(["w", "company", "co-acme"]);
    expect(campaigns[0]).toMatchObject({ clientKind: "company", clientRef: "co-acme", clientName: "Acme", audienceMode: "client_contacts" });
  });

  it("counts a client's campaigns, enrolled contacts and due steps", async () => {
    const { ctx, calls } = fakeCtx([{ total: "3", active: "2", enrolled: "7", due: "1" }]);
    const counts = await clientCampaignCounts(ctx, "w", { kind: "contact", id: "ct-ada" });
    expect(counts).toEqual({ total: 3, active: 2, enrolledContacts: 7, dueSteps: 1 });
    expect(calls[1]!.sql).toContain("c.client_ref = $3 AND COALESCE(c.client_kind, 'company') = $2");
    expect(calls[1]!.params).toEqual(["w", "contact", "ct-ada"]);
  });
});

describe("campaign client summary", () => {
  it("headlines active campaigns and flags due steps", () => {
    const summary = campaignClientSummary({ total: 3, active: 2, enrolledContacts: 7, dueSteps: 1 });
    expect(summary.headline).toBe("2 active campaigns");
    expect(summary.stats).toEqual([
      { label: "Active campaigns", value: 2, tone: "ok" },
      { label: "Enrolled contacts", value: 7 },
      { label: "Due steps", value: 1, tone: "warn" },
    ]);
    expect(campaignClientSummary({ total: 1, active: 1, enrolledContacts: 0, dueSteps: 0 }).headline).toBe("1 active campaign");
    expect(campaignClientSummary({ total: 2, active: 0, enrolledContacts: 0, dueSteps: 0 }).headline).toBe("2 campaigns, none active");
    expect(campaignClientSummary({ total: 0, active: 0, enrolledContacts: 0, dueSteps: 0 }).headline).toBe("No campaigns");
  });
});
