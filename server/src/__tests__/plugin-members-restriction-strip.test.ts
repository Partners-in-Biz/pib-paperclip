import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-12608 4.2: the restriction flag and lists never reach plugins (members.list and members.get).
const support = await getEmbeddedPostgresTestSupport();
const restrictionFields = ["restricted", "restrictedPluginKeys", "restrictedAgentIds"] as const;

describe("plugin members restriction strip database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("plugin members.list and members.get strip restriction fields", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-members-strip-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns a flagged member without restricted, restrictedPluginKeys or restrictedAgentIds", async () => {
    const [company] = await db.insert(companies).values({
      name: `Strip ${randomUUID()}`,
      issuePrefix: `STR${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const [flagged] = await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "user",
      principalId: `user-${randomUUID()}`,
      status: "active",
      membershipRole: "operator",
      restricted: true,
      restrictedPluginKeys: ["crm"],
      restrictedAgentIds: [randomUUID()],
    }).returning();
    const services = buildHostServices(db, "plugin-record-id", "permissions-extension", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as any);

    const listed = await services.access.listMembers({ companyId: company!.id });
    const listedMember = listed.find((row) => row.id === flagged!.id);
    expect(listedMember).toBeDefined();
    const got = await services.access.getMember({ companyId: company!.id, memberId: flagged!.id });
    expect(got).not.toBeNull();

    for (const field of restrictionFields) {
      expect(listedMember).not.toHaveProperty(field);
      expect(got).not.toHaveProperty(field);
    }
    services.dispose();
  });
});
