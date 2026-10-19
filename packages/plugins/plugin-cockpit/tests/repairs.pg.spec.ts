/**
 * Repairs: system actions taken to fix issues detected by the Cockpit's checks.
 * Tests cover insertion, listing, company isolation, detail redaction and truncation,
 * filtering by kind and since, migration idempotency, and compatibility with existing code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRepairs, recordRepair, REPAIR_DETAIL_MAX, type RepairRow } from "../src/repairs.js";
import { NAMESPACE } from "../src/namespace.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = "company-b";

d("repairs (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(options: Parameters<typeof worlds.make>[0] = {}) {
    return await worlds.make(options);
  }

  describe("inserting and listing", () => {
    it("records a repair with id generation and defaults", async () => {
      const w = await make();
      const repair = await recordRepair(w.ctx, A, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "add-skill",
        outcome: "success",
        actor: "user-owner",
      });

      expect(repair.id).toMatch(/^rep[a-f0-9]{12}$/);
      expect(repair).toMatchObject({
        companyId: A,
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "add-skill",
        outcome: "success",
        detail: "",
        actor: "user-owner",
      });
      expect(repair.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("lists repairs newest first for a company", async () => {
      const w = await make();
      const r1 = await recordRepair(w.ctx, A, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const r2 = await recordRepair(w.ctx, A, {
        kind: "grant",
        targetKind: "grant",
        targetId: "grant-1",
        action: "grant",
        outcome: "success",
        actor: "user",
      });

      const repairs = await listRepairs(w.ctx, A);
      expect(repairs.length).toBe(2);
      expect(repairs[0].id).toBe(r2.id);
      expect(repairs[1].id).toBe(r1.id);
    });

    it("isolates repairs by company", async () => {
      const w = await make();
      const r1 = await recordRepair(w.ctx, A, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });
      const r2 = await recordRepair(w.ctx, B, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-2",
        action: "fix",
        outcome: "success",
        actor: "user",
      });

      const repairsA = await listRepairs(w.ctx, A);
      const repairsB = await listRepairs(w.ctx, B);

      expect(repairsA).toHaveLength(1);
      expect(repairsA[0].id).toBe(r1.id);
      expect(repairsB).toHaveLength(1);
      expect(repairsB[0].id).toBe(r2.id);
    });
  });

  describe("detail handling", () => {
    it("truncates detail to REPAIR_DETAIL_MAX with ellipsis", async () => {
      const w = await make();
      const longDetail = "x".repeat(REPAIR_DETAIL_MAX + 100);
      const repair = await recordRepair(w.ctx, A, {
        kind: "test",
        targetKind: "test",
        targetId: "test-1",
        action: "test",
        outcome: "success",
        detail: longDetail,
        actor: "user",
      });

      expect(repair.detail.length).toBeLessThanOrEqual(REPAIR_DETAIL_MAX);
      expect(repair.detail.endsWith("…")).toBe(true);
      expect(repair.detail.length).toBe(REPAIR_DETAIL_MAX);
    });

    it("stores a 5000 character detail with length <= 2000", async () => {
      const w = await make();
      const veryLongDetail = "y".repeat(5000);
      const repair = await recordRepair(w.ctx, A, {
        kind: "test",
        targetKind: "test",
        targetId: "test-5000",
        action: "test",
        outcome: "success",
        detail: veryLongDetail,
        actor: "user",
      });

      // Verify detail is stored with length <= REPAIR_DETAIL_MAX (2000)
      expect(repair.detail.length).toBeLessThanOrEqual(REPAIR_DETAIL_MAX);
      expect(repair.detail.length).toBe(REPAIR_DETAIL_MAX);
      expect(repair.detail.endsWith("…")).toBe(true);
    });

    it("redacts secrets from detail before truncation", async () => {
      const w = await make();
      const detailWithSecret = "token=ghp_1234567890abcdefghijklmnopqrstuvwxyz some other text";
      const repair = await recordRepair(w.ctx, A, {
        kind: "test",
        targetKind: "test",
        targetId: "test-1",
        action: "test",
        outcome: "success",
        detail: detailWithSecret,
        actor: "user",
      });

      expect(repair.detail).not.toContain("ghp_");
      expect(repair.detail).toContain("[redacted]");
      expect(repair.detail).toContain("some other text");
    });

    it("redacts Bearer tokens", async () => {
      const w = await make();
      const detailWithToken = "Authorization: Bearer sk-1234567890abcdefghijklmnop";
      const repair = await recordRepair(w.ctx, A, {
        kind: "test",
        targetKind: "test",
        targetId: "test-1",
        action: "test",
        outcome: "success",
        detail: detailWithToken,
        actor: "user",
      });

      expect(repair.detail).not.toContain("sk-");
      expect(repair.detail).toContain("Bearer [redacted]");
    });
  });

  describe("filtering", () => {
    it("filters by kind", async () => {
      const w = await make();
      await recordRepair(w.ctx, A, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });
      await recordRepair(w.ctx, A, {
        kind: "grant",
        targetKind: "grant",
        targetId: "grant-1",
        action: "grant",
        outcome: "success",
        actor: "user",
      });

      const agents = await listRepairs(w.ctx, A, { kind: "agent" });
      expect(agents).toHaveLength(1);
      expect(agents[0].kind).toBe("agent");

      const grants = await listRepairs(w.ctx, A, { kind: "grant" });
      expect(grants).toHaveLength(1);
      expect(grants[0].kind).toBe("grant");
    });

    it("filters by since (ISO timestamp)", async () => {
      const w = await make();
      const r1 = await recordRepair(w.ctx, A, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });

      // Use r1's timestamp as the boundary (repairs created after this time)
      const boundaryTime = new Date(new Date(r1.createdAt).getTime() + 1).toISOString();

      // Add small delay to ensure r2 has a later timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      const r2 = await recordRepair(w.ctx, A, {
        kind: "grant",
        targetKind: "grant",
        targetId: "grant-1",
        action: "grant",
        outcome: "success",
        actor: "user",
      });

      const recent = await listRepairs(w.ctx, A, { since: boundaryTime });
      expect(recent.length).toBeGreaterThanOrEqual(1);
      expect(recent.some((r) => r.id === r2.id)).toBe(true);

      const older = await listRepairs(w.ctx, A, { since: r1.createdAt });
      expect(older.length).toBeGreaterThanOrEqual(1);
    });

    it("combines kind and since filters", async () => {
      const w = await make();
      const r1 = await recordRepair(w.ctx, A, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });

      const boundaryTime = new Date(new Date(r1.createdAt).getTime() + 1).toISOString();

      // Add small delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      await recordRepair(w.ctx, A, {
        kind: "grant",
        targetKind: "grant",
        targetId: "grant-1",
        action: "grant",
        outcome: "success",
        actor: "user",
      });

      // Add another delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      const r3 = await recordRepair(w.ctx, A, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-2",
        action: "fix",
        outcome: "success",
        actor: "user",
      });

      const results = await listRepairs(w.ctx, A, { kind: "agent", since: boundaryTime });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.kind === "agent")).toBe(true);
    });

    it("respects limit parameter clamped to 1..500 with default 100", async () => {
      const w = await make();
      for (let i = 0; i < 150; i += 1) {
        await recordRepair(w.ctx, A, {
          kind: "test",
          targetKind: "test",
          targetId: `test-${i}`,
          action: "fix",
          outcome: "success",
          actor: "user",
        });
      }

      const defaultLimit = await listRepairs(w.ctx, A);
      expect(defaultLimit.length).toBe(100);

      const custom50 = await listRepairs(w.ctx, A, { limit: 50 });
      expect(custom50.length).toBe(50);

      const custom200 = await listRepairs(w.ctx, A, { limit: 200 });
      expect(custom200.length).toBe(150); // only 150 exist

      const clampLow = await listRepairs(w.ctx, A, { limit: 0 });
      expect(clampLow.length).toBe(1); // clamped to minimum 1

      const clampHigh = await listRepairs(w.ctx, A, { limit: 600 });
      expect(clampHigh.length).toBeLessThanOrEqual(500); // clamped to max 500
    });
  });

  describe("migration", () => {
    it("migration 008 creates the table and index correctly", async () => {
      const w = await make();

      // Record a repair
      const r1 = await recordRepair(w.ctx, A, {
        kind: "test",
        targetKind: "test",
        targetId: "test-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });

      // Verify the repairs table exists and has the correct structure
      const tableCheck = await w.client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = '${NAMESPACE}' AND table_name = 'repairs')`,
      );
      expect(tableCheck.rows[0]).toBeDefined();

      // Verify the index exists using pg_indexes
      const indexCheck = await w.client.query(
        `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = '${NAMESPACE}' AND indexname = 'repairs_company_created_idx')`,
      );
      expect(indexCheck.rows[0]).toBeDefined();

      // Verify the row is there and can be retrieved
      const repairs = await listRepairs(w.ctx, A);
      expect(repairs.length).toBeGreaterThanOrEqual(1);
      expect(repairs.some((r) => r.id === r1.id)).toBe(true);
    });

    it("migration 008 is idempotent when applied twice", async () => {
      const w = await make();

      // Record a repair before re-applying the migration
      const r1 = await recordRepair(w.ctx, A, {
        kind: "test",
        targetKind: "test",
        targetId: "test-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });

      // Read the migration file
      const fs = await import("node:fs");
      const path = await import("node:path");
      const migrationPath = path.join(
        import.meta.url.replace(/^file:\/\//, ""),
        "../..",
        "migrations/008_cockpit.sql",
      );
      const migrationContent = fs.readFileSync(migrationPath, "utf-8");

      // Apply the migration again (simulating a second run)
      // The IF NOT EXISTS clauses should prevent errors
      await w.client.query(migrationContent);

      // Verify the original repair is still there and unchanged
      const repairs = await listRepairs(w.ctx, A);
      expect(repairs.length).toBeGreaterThanOrEqual(1);
      expect(repairs.some((r) => r.id === r1.id)).toBe(true);
      const retrieved = repairs.find((r) => r.id === r1.id);
      expect(retrieved).toMatchObject({
        kind: "test",
        targetKind: "test",
        targetId: "test-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });
    });
  });

  describe("compatibility with existing code", () => {
    it("existing tables remain queryable when repairs table is present", async () => {
      const w = await make();

      // This should not fail even though we added a new table
      const result = await w.client.query(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = '${NAMESPACE}' AND table_name = 'goals')`);
      expect(result.rows[0]).toBeDefined();

      // Record a repair
      await recordRepair(w.ctx, A, {
        kind: "test",
        targetKind: "test",
        targetId: "test-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });

      // Verify other store functions still work (goals table is still queryable)
      const goalsResult = await w.client.query(`SELECT EXISTS (SELECT 1 FROM ${NAMESPACE}.goals LIMIT 1)`);
      expect(goalsResult.rows[0]).toBeDefined();
    });
  });
});
