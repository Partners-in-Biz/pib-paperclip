import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, invites } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-12608 4.2a on the plugin host writer of `invites`: the reserved key is never
// taken from a plugin's free payload (AC-I6), and a plugin, which cannot choose the
// mark, may not create a human invite in a company whose mode is not `off` (AC-I7).

const modeRead = vi.hoisted(() => ({ fail: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...actual,
    memberRestrictionModeFor: async (...args: Parameters<typeof actual.memberRestrictionModeFor>) => {
      if (modeRead.fail) throw new actual.MemberRestrictionReadError("database down");
      return actual.memberRestrictionModeFor(...args);
    },
  };
});

type Mode = "off" | "report" | "enforce";

const support = await getEmbeddedPostgresTestSupport();

describe("member-restriction plugin invites database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("plugin host createInvite and the restriction mark", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let services!: ReturnType<typeof buildHostServices>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-plugin-invites-");
    db = createDb(tempDb.connectionString);
    services = buildHostServices(db, "plugin-record-id", "permissions-extension", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as never);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    modeRead.fail = false;
    await db.delete(activityLog);
    await db.delete(invites);
    await db.delete(companies);
  });

  afterAll(async () => {
    services?.dispose();
    await tempDb?.cleanup();
  });

  const company = async (mode: Mode) => (await db.insert(companies).values({
    name: "Plugin invites", issuePrefix: `PI${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode,
  }).returning())[0]!;
  const storedInvites = () => db.select().from(invites);

  it("AC-I6 (plugin host): a memberRestriction key in the plugin's free payload is not stored", async () => {
    const target = await company("off");
    await services.access.createInvite({
      companyId: target.id,
      allowedJoinTypes: "human",
      defaultsPayload: {
        human: { role: "operator" },
        memberRestriction: { restricted: true, pluginKeys: ["crm"], agentIds: [] },
        note: "kept",
      },
    });
    const [row] = await storedInvites();
    expect(row!.defaultsPayload).not.toHaveProperty("memberRestriction");
    expect(row!.defaultsPayload).toMatchObject({ note: "kept" });
  });

  it("AC-I7 (plugin host): under off a human invite is made unmarked; under report and enforce it is refused with 422", async () => {
    const off = await company("off");
    await services.access.createInvite({ companyId: off.id, allowedJoinTypes: "human" });
    expect(await storedInvites()).toHaveLength(1);

    for (const mode of ["report", "enforce"] as const) {
      const target = await company(mode);
      for (const allowedJoinTypes of ["human", "both"] as const) {
        await expect(services.access.createInvite({ companyId: target.id, allowedJoinTypes }))
          .rejects.toMatchObject({ status: 422, details: { code: "MEMBER_RESTRICTION_REQUIRED" } });
      }
    }
    expect(await storedInvites()).toHaveLength(1);
  });

  it("AC-I7 (plugin host): an agent-only invite stays allowed in an enforce company", async () => {
    const target = await company("enforce");
    const created = await services.access.createInvite({ companyId: target.id, allowedJoinTypes: "agent" });
    expect(created.allowedJoinTypes).toBe("agent");
    expect(await storedInvites()).toHaveLength(1);
  });

  it("AC-F8 (plugin host): with the kill switch `off` an enforce company behaves as mode off", async () => {
    const target = await company("enforce");
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    await services.access.createInvite({ companyId: target.id, allowedJoinTypes: "human" });
    const [row] = await storedInvites();
    expect(row!.defaultsPayload).not.toHaveProperty("memberRestriction");
  });

  it("AC-X1 (plugin host): when the mode read fails the call is refused with 503 and creates nothing", async () => {
    const target = await company("off");
    modeRead.fail = true;
    await expect(services.access.createInvite({ companyId: target.id, allowedJoinTypes: "human" }))
      .rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    expect(await storedInvites()).toHaveLength(0);
  });
});
