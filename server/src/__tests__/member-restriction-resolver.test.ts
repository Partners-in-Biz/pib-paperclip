import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, companyMemberships, createDb, type Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import {
  memberRestrictionFor,
  memberRestrictionOrUnavailable,
  memberRestrictionResolver,
  reportMemberRestrictionKillSwitchAtBoot,
} from "../services/member-restriction/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const PERSON = "user-1";
const COMPANY = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

/** A query-builder stand-in that records which tables were read. */
function stubDb(rowsFor: { company?: Row | null; membership?: Row | null; companiesList?: Row[] }) {
  const tablesRead: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        tablesRead.push(table);
        const rows = table === companies
          ? rowsFor.companiesList ?? (rowsFor.company ? [rowsFor.company] : [])
          : rowsFor.membership ? [rowsFor.membership] : [];
        return { where: () => Promise.resolve(rows) };
      },
    })),
  };
  return { db: db as unknown as Db, tablesRead };
}

const flagged = { restricted: true, pluginKeys: ["crm"], agentIds: ["agent-1"] };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("memberRestrictionFor", () => {
  it("with the kill switch exactly `off` answers not restricted and reads nothing", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const { db, tablesRead } = stubDb({ company: { mode: "enforce" }, membership: flagged });
    await expect(memberRestrictionFor(db, PERSON, COMPANY)).resolves.toEqual({
      restricted: false, mode: "off", pluginKeys: [], agentIds: [],
    });
    expect(tablesRead).toEqual([]);
  });

  it.each(["false", "0", "OFF ", "Off", ""])("ignores the kill switch value %j, read per call", async (value) => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
    const { db } = stubDb({ company: { mode: "enforce" }, membership: flagged });
    expect((await memberRestrictionFor(db, PERSON, COMPANY)).restricted).toBe(true);
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    expect((await memberRestrictionFor(db, PERSON, COMPANY)).restricted).toBe(false);
  });

  it("in mode `off` reads only the company mode, never the membership", async () => {
    const { db, tablesRead } = stubDb({ company: { mode: "off" }, membership: flagged });
    await expect(memberRestrictionFor(db, PERSON, COMPANY)).resolves.toEqual({
      restricted: false, mode: "off", pluginKeys: [], agentIds: [],
    });
    expect(tablesRead).toEqual([companies]);
  });

  it.each(["report", "enforce"] as const)("in mode %s returns the flag and both lists", async (mode) => {
    const { db, tablesRead } = stubDb({ company: { mode }, membership: flagged });
    await expect(memberRestrictionFor(db, PERSON, COMPANY)).resolves.toEqual({
      restricted: true, mode, pluginKeys: ["crm"], agentIds: ["agent-1"],
    });
    expect(tablesRead).toEqual([companies, companyMemberships]);
  });

  it("answers not restricted for an unflagged member, a missing membership or a missing company", async () => {
    const unflagged = stubDb({ company: { mode: "enforce" }, membership: { ...flagged, restricted: false } });
    expect(await memberRestrictionFor(unflagged.db, PERSON, COMPANY)).toEqual({
      restricted: false, mode: "enforce", pluginKeys: [], agentIds: [],
    });
    const noMembership = stubDb({ company: { mode: "enforce" }, membership: null });
    expect((await memberRestrictionFor(noMembership.db, PERSON, COMPANY)).restricted).toBe(false);
    const noCompany = stubDb({ company: null });
    expect(await memberRestrictionFor(noCompany.db, PERSON, COMPANY)).toEqual({
      restricted: false, mode: "off", pluginKeys: [], agentIds: [],
    });
  });

  it("throws on an unknown mode or a malformed list instead of guessing", async () => {
    await expect(memberRestrictionFor(stubDb({ company: { mode: "audit" } }).db, PERSON, COMPANY)).rejects.toThrow(
      /member_restriction_mode/,
    );
    const malformed = stubDb({ company: { mode: "enforce" }, membership: { ...flagged, agentIds: { id: 1 } } });
    await expect(memberRestrictionFor(malformed.db, PERSON, COMPANY)).rejects.toThrow(/restricted_agent_ids/);
  });
});

describe("memberRestrictionOrUnavailable", () => {
  it("turns a failed read into 503 MEMBER_RESTRICTION_UNAVAILABLE and returns no data", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("connection reset"));
    const app = express();
    app.get("/thing", async (_req, res, next) => {
      try {
        await memberRestrictionOrUnavailable(failing, PERSON, COMPANY);
        res.json({ secret: "data" });
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);

    const res = await request(app).get("/thing");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
    expect(res.body).not.toHaveProperty("secret");
    expect(failing).toHaveBeenCalledWith(PERSON, COMPANY);
  });
});

describe("reportMemberRestrictionKillSwitchAtBoot", () => {
  const logger = () => ({ warn: vi.fn() });

  it("logs a value that is not exactly `off` once as ignored, writes nothing, and is silent when unset", async () => {
    const log = logger();
    const { db, tablesRead } = stubDb({ companiesList: [{ id: COMPANY, mode: "enforce" }] });
    const result = await reportMemberRestrictionKillSwitchAtBoot(db, {
      env: { PAPERCLIP_MEMBER_RESTRICTION: "OFF " }, logger: log as never,
    });
    expect(result).toEqual({ forcedOff: false, companyIds: [] });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![1]).toMatch(/not understood, ignored/);
    expect(tablesRead).toEqual([]);
    await reportMemberRestrictionKillSwitchAtBoot(db, { env: {}, logger: log as never });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

const support = await getEmbeddedPostgresTestSupport();

describe("member-restriction database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("member restriction against the database", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function companyWith(mode: "off" | "report" | "enforce") {
    const [company] = await db
      .insert(companies)
      .values({ name: `Restriction ${mode}`, issuePrefix: `R${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode })
      .returning();
    return company!;
  }

  it("treats a suspended flagged member as restricted here (AC-X4, resolver level)", async () => {
    const company = await companyWith("enforce");
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "suspended",
      membershipRole: "operator",
      restricted: true,
      restrictedPluginKeys: ["crm"],
      restrictedAgentIds: [],
    });

    await expect(memberRestrictionResolver(db)(userId, company.id)).resolves.toEqual({
      restricted: true, mode: "enforce", pluginKeys: ["crm"], agentIds: [],
    });
  });

  it("never reads an agent membership with the same id as a person", async () => {
    const company = await companyWith("enforce");
    const principalId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "agent", principalId, status: "active", restricted: true,
    });
    expect((await memberRestrictionFor(db, principalId, company.id)).restricted).toBe(false);
  });

  it("refuses a mode outside off, report and enforce", async () => {
    const company = await companyWith("off");
    await expect(
      db.execute(sql`UPDATE companies SET member_restriction_mode = 'audit' WHERE id = ${company.id}`),
    ).rejects.toThrow();
  });

  it("with the kill switch on, logs at boot and leaves one activity entry per company not on `off`", async () => {
    const enforced = await companyWith("enforce");
    const reported = await companyWith("report");
    await companyWith("off");
    const log = { warn: vi.fn() };

    const result = await reportMemberRestrictionKillSwitchAtBoot(db, {
      env: { PAPERCLIP_MEMBER_RESTRICTION: "off" }, logger: log as never,
    });

    expect(result.forcedOff).toBe(true);
    expect(new Set(result.companyIds)).toEqual(new Set([enforced.id, reported.id]));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![1]).toMatch(/switched off for the whole server/);
    const entries = await db.select().from(activityLog);
    expect(entries.map((entry) => [entry.companyId, entry.action]).sort()).toEqual(
      [[enforced.id, "member_restriction.forced_off"], [reported.id, "member_restriction.forced_off"]].sort(),
    );
  });
});
