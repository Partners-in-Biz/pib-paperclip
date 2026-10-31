import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

describe("agent config revision numbers", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-config-revision-numbers-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Revision numbers", issuePrefix: "CRN" });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  const numbers = async (agentId: string) =>
    (await agentService(db).listConfigRevisions(agentId)).map((r) => r.revisionNumber).sort((a, b) => Number(a) - Number(b));

  it("numbers revisions 1..n per agent, independently of other agents", async () => {
    const service = agentService(db);
    const a = await service.create(companyId, { name: "A", role: "engineer", adapterType: "process" });
    const b = await service.create(companyId, { name: "B", role: "engineer", adapterType: "process" });
    await service.update(a.id, { name: "A1" }, { recordRevision: { source: "test" } });
    await service.update(a.id, { name: "A2" }, { recordRevision: { source: "test" } });
    await service.update(b.id, { name: "B1" }, { recordRevision: { source: "test" } });
    expect(await numbers(a.id)).toEqual([1, 2]);
    expect(await numbers(b.id)).toEqual([1]);
  });

  it("gives concurrent patches on one agent distinct numbers", async () => {
    const service = agentService(db);
    const agent = await service.create(companyId, { name: "C", role: "engineer", adapterType: "process" });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        service.update(agent.id, { title: `t${i}` }, { recordRevision: { source: "test" } }),
      ),
    );
    expect(await numbers(agent.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rollback records a new numbered revision pointing at the restored one", async () => {
    const service = agentService(db);
    const agent = await service.create(companyId, { name: "D", role: "engineer", adapterType: "process" });
    await service.update(agent.id, { name: "D1" }, { recordRevision: { source: "test" } });
    await service.update(agent.id, { name: "D2" }, { recordRevision: { source: "test" } });
    const first = (await service.listConfigRevisions(agent.id)).find((r) => r.revisionNumber === 1)!;
    const restored = await service.rollbackConfigRevision(agent.id, first.id, {});
    expect(restored?.name).toBe("D1");
    const latest = (await service.listConfigRevisions(agent.id)).find((r) => r.revisionNumber === 3)!;
    expect(latest.source).toBe("rollback");
    expect(latest.rolledBackFromRevisionId).toBe(first.id);
  });

  it("records an instruction file delete as its own revision", async () => {
    const service = agentService(db);
    const agent = await service.create(companyId, { name: "E", role: "engineer", adapterType: "process" });
    await service.recordInstructionsRevision(agent, {
      source: "instructions_file_delete",
      changedKeys: ["instructionsFile:notes.md"],
    });
    const [rev] = await service.listConfigRevisions(agent.id);
    expect(rev.revisionNumber).toBe(1);
    expect(rev.changedKeys).toEqual(["instructionsFile:notes.md"]);
  });

  it("refuses to roll back an instruction-file revision", async () => {
    const service = agentService(db);
    const agent = await service.create(companyId, { name: "F", role: "engineer", adapterType: "process" });
    await service.recordInstructionsRevision(agent, {
      source: "instructions_file_delete",
      changedKeys: ["instructionsFile:notes.md"],
    });
    const [rev] = await service.listConfigRevisions(agent.id);
    await expect(service.rollbackConfigRevision(agent.id, rev.id, {})).rejects.toThrow(/Nothing to restore/);
  });

  it("backfills numbers chronologically per agent", async () => {
    const { sql } = await import("drizzle-orm");
    const { agentConfigRevisions } = await import("@paperclipai/db");
    const service = agentService(db);
    const a = await service.create(companyId, { name: "G1", role: "engineer", adapterType: "process" });
    const b = await service.create(companyId, { name: "G2", role: "engineer", adapterType: "process" });
    await db.execute(sql`DROP INDEX IF EXISTS agent_config_revisions_agent_number_uq`);
    const base = Date.parse("2026-01-01T00:00:00Z");
    const rows = [[a, 3], [b, 2], [a, 1], [b, 1], [a, 2]] as const;
    for (const [agent, day] of rows) {
      await db.insert(agentConfigRevisions).values({
        companyId, agentId: agent.id, source: "legacy", changedKeys: ["name"],
        beforeConfig: {}, afterConfig: { day }, createdAt: new Date(base + day * 86_400_000),
      });
    }
    const migration = await (await import("node:fs/promises")).readFile(
      new URL("../../../packages/db/src/migrations/0285_agent_config_revision_numbers.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    for (const agent of [a, b]) {
      const revs = (await service.listConfigRevisions(agent.id)).sort((x, y) => Number(x.revisionNumber) - Number(y.revisionNumber));
      expect(revs.map((r) => (r.afterConfig as { day: number }).day)).toEqual(revs.map((_, i) => i + 1));
    }
  });
});
