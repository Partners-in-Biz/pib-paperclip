/**
 * "Managed by" (access stage B, PAR-12581) on a real Postgres with the host's SQL rules: migration 025 on existing rows,
 * who may change the managers, which ids are accepted, the companies a person manages and the event other plugins get.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { managedAccountIds, managersView, setManagers } from "../src/managers.js";
import { companyEvent } from "../src/sync.js";
import type { Viewer } from "../src/domain.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const T = `${NAMESPACE}.companies`;
const CO = "co-1";

const MEMBERS = [
  { principalType: "user", principalId: "peet", status: "active", membershipRole: "owner" },
  { principalType: "user", principalId: "adm", status: "active", membershipRole: "admin" },
  { principalType: "user", principalId: "jan", status: "active", membershipRole: "operator" },
  { principalType: "user", principalId: "kim", status: "active", membershipRole: "operator" },
  { principalType: "user", principalId: "gone", status: "suspended", membershipRole: "operator" },
  { principalType: "agent", principalId: "agent-1", status: "active", membershipRole: null },
];

const viewer = (userId: string | null, role: string | null, agentId: string | null = null): Viewer => ({ companyId: CO, userId, agentId, role, runId: null });

describe.skipIf(!available)("Managed by on a real database", () => {
  let pg: PgHarness;
  let ctx: PluginContext;
  const logged: unknown[] = [];

  beforeAll(async () => {
    pg = await startPg();
    ctx = Object.assign(pg.ctx, {
      access: { members: { list: async () => MEMBERS } },
      activity: { log: async (entry: unknown) => void logged.push(entry) },
    }) as unknown as PluginContext;
  }, 60_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await pg.reset();
    logged.length = 0;
    for (const [id, company, owner] of [["acme", CO, "peet"], ["globex", CO, "jan"], ["initech", CO, null], ["foreign", "co-2", "jan"]] as const) {
      await pg.client.query(`INSERT INTO ${T} (id, company_id, name, owner_user_id) VALUES ($1, $2, $3, $4)`, [id, company, id, owner]);
    }
  });

  it("migration 025: existing companies get an empty list; the CHECK refuses a fourth manager and a non-list", async () => {
    expect((await pg.client.query(`SELECT id, manager_user_ids FROM ${T} ORDER BY id`)).rows).toEqual([
      { id: "acme", manager_user_ids: [] }, { id: "foreign", manager_user_ids: [] }, { id: "globex", manager_user_ids: [] }, { id: "initech", manager_user_ids: [] },
    ]);
    await expect(pg.client.query(`UPDATE ${T} SET manager_user_ids = '["a","b","c","d"]' WHERE id = 'acme'`)).rejects.toThrow(/companies_manager_user_ids/);
    await expect(pg.client.query(`UPDATE ${T} SET manager_user_ids = '"a"' WHERE id = 'acme'`)).rejects.toThrow(/companies_manager_user_ids/);
  });

  it("his companies: the ones he owns or manages, in this workspace only", async () => {
    expect(await managedAccountIds(ctx, CO, "jan")).toEqual(["globex"]);
    await setManagers(ctx, viewer("peet", "owner"), { companyRecordId: "acme", ownerUserId: "peet", managerUserIds: ["jan"] });
    expect(await managedAccountIds(ctx, CO, "jan")).toEqual(["acme", "globex"]);
    expect(await managedAccountIds(ctx, CO, "peet")).toEqual(["acme"]);
    expect(await managedAccountIds(ctx, CO, "kim")).toEqual([]);
    expect(await managedAccountIds(ctx, "co-2", "jan")).toEqual(["foreign"]);
    expect(await managedAccountIds(ctx, CO, "")).toEqual([]);
  });

  it("an owner or admin changes the owner and adds a second manager; the timeline and the audit log record it", async () => {
    const out = await setManagers(ctx, viewer("adm", "admin"), { companyRecordId: "initech", ownerUserId: "kim", managerUserIds: ["jan", "kim", "jan"] });
    expect(out).toEqual({ ownerUserId: "kim", managerUserIds: ["jan"], canChange: true, you: "adm" });
    expect((await pg.client.query(`SELECT owner_user_id, manager_user_ids FROM ${T} WHERE id = 'initech'`)).rows).toEqual([{ owner_user_id: "kim", manager_user_ids: ["jan"] }]);
    const activity = (await pg.client.query(`SELECT record_type, record_id, kind, meta FROM ${NAMESPACE}.activities`)).rows;
    expect(activity).toEqual([{ record_type: "company", record_id: "initech", kind: "managers", meta: { before: { ownerUserId: null, managerUserIds: [] }, after: { ownerUserId: "kim", managerUserIds: ["jan"] }, changedBy: "adm" } }]);
    expect(logged).toHaveLength(1);
    expect(await managersView(ctx, viewer("jan", "operator"), "initech")).toEqual({ ownerUserId: "kim", managerUserIds: ["jan"], canChange: false, you: "jan" });
  });

  it("refused: a limited person (even the company's own manager), an agent, nobody signed in", async () => {
    for (const v of [viewer("jan", "operator"), viewer("peet", "owner", "agent-1"), viewer(null, null, "agent-1"), viewer(null, "owner")]) {
      await expect(setManagers(ctx, v, { companyRecordId: "globex", ownerUserId: "jan", managerUserIds: ["kim"] })).rejects.toThrow(/Only an owner or an admin/);
    }
    expect((await pg.client.query(`SELECT manager_user_ids FROM ${T} WHERE id = 'globex'`)).rows).toEqual([{ manager_user_ids: [] }]);
  });

  it("refused: a guessed id, another workspace's company, a non-member, a suspended member, an agent id, too many managers", async () => {
    const owner = viewer("peet", "owner");
    await expect(setManagers(ctx, owner, { companyRecordId: "guessed-id", ownerUserId: "jan" })).rejects.toThrow(/Company was not found/);
    await expect(setManagers(ctx, owner, { companyRecordId: "foreign", ownerUserId: "kim" })).rejects.toThrow(/Company was not found/);
    for (const bad of ["stranger", "gone", "agent-1", "local-board"]) {
      await expect(setManagers(ctx, owner, { companyRecordId: "acme", ownerUserId: "peet", managerUserIds: [bad] })).rejects.toThrow(/active member/);
      await expect(setManagers(ctx, owner, { companyRecordId: "acme", ownerUserId: bad })).rejects.toThrow(/active member/);
    }
    await expect(setManagers(ctx, owner, { companyRecordId: "acme", ownerUserId: "peet", managerUserIds: ["jan", "kim", "adm", "x"] })).rejects.toThrow(/at most 3/);
    await expect(setManagers(ctx, owner, { companyRecordId: "acme", managerUserIds: ["jan"] })).rejects.toThrow(/ownerUserId is required/);
    await expect(setManagers(ctx, owner, { companyRecordId: "acme", ownerUserId: "peet", managerUserIds: "jan" })).rejects.toThrow(/must be a list/);
    expect((await pg.client.query(`SELECT id, owner_user_id, manager_user_ids FROM ${T} WHERE id IN ('acme', 'foreign') ORDER BY id`)).rows).toEqual([
      { id: "acme", owner_user_id: "peet", manager_user_ids: [] }, { id: "foreign", owner_user_id: "jan", manager_user_ids: [] },
    ]);
  });

  it("company.upserted carries the owner and managers when they were read, and leaves them out otherwise", async () => {
    await setManagers(ctx, viewer("peet", "owner"), { companyRecordId: "acme", ownerUserId: "peet", managerUserIds: ["jan"] });
    const [row] = (await pg.client.query(`SELECT id, name, domain, lifecycle, owner_user_id, manager_user_ids, updated_at FROM ${T} WHERE id = 'acme'`)).rows as never[];
    expect(companyEvent(row).managers).toEqual({ ownerUserId: "peet", managerUserIds: ["jan"] });
    expect("managers" in companyEvent({ id: "acme", name: "acme", domain: null, lifecycle: null, updated_at: null } as never)).toBe(false);
  });
});
