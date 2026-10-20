/**
 * Ladder reconciliation (Postgres): marker issue to repair row idempotency,
 * company isolation, and duplicate prevention.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileMarkers } from "../src/ladder.js";
import { listRepairs, recordRepair } from "../src/repairs.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds } from "./helpers/hybrid.js";
import type { MarkerIssueRow } from "../src/watch.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = "company-b";
const NOW = new Date("2026-09-26T10:00:00.000Z");

d("ladder reconciliation (Postgres)", () => {
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

  describe("inserting repair rows", () => {
    it("inserts a repair row for each marker issue", async () => {
      const w = await make();
      const markers: MarkerIssueRow[] = [
        {
          id: "m-1",
          identifier: "PAR-1001",
          title: "Unblock L1",
          stuckIssueId: "stuck-1",
          level: 1,
          status: "todo",
          originId: "escalate:stuck-1:L1",
          description: null,
          createdAt: NOW.toISOString(),
        },
        {
          id: "m-2",
          identifier: "PAR-1002",
          title: "Unblock L2",
          stuckIssueId: "stuck-2",
          level: 2,
          status: "todo",
          originId: "escalate:stuck-2:L2",
          description: null,
          createdAt: NOW.toISOString(),
        },
      ];

      const inserted = await reconcileMarkers(w.ctx, A, markers, NOW);
      expect(inserted).toBe(2);

      const repairs = await listRepairs(w.ctx, A, { kind: "escalation" });
      expect(repairs).toHaveLength(2);
      expect(repairs.map((r) => r.action).sort()).toEqual(["create_L1", "create_L2"]);
    });

    it("inserts nothing on second call (idempotent)", async () => {
      const w = await make();
      const markers: MarkerIssueRow[] = [
        {
          id: "m-1",
          identifier: "PAR-1001",
          title: "Unblock L1",
          stuckIssueId: "stuck-1",
          level: 1,
          status: "todo",
          originId: "escalate:stuck-1:L1",
          description: null,
          createdAt: NOW.toISOString(),
        },
      ];

      const inserted1 = await reconcileMarkers(w.ctx, A, markers, NOW);
      const inserted2 = await reconcileMarkers(w.ctx, A, markers, NOW);

      expect(inserted1).toBe(1);
      expect(inserted2).toBe(0);

      const repairs = await listRepairs(w.ctx, A, { kind: "escalation" });
      expect(repairs).toHaveLength(1);
    });

    it("does not duplicate a row already recorded by recordRepair with the same target+action", async () => {
      const w = await make();

      // Manually record a repair
      await recordRepair(w.ctx, A, {
        kind: "escalation",
        targetKind: "issue",
        targetId: "m-1",
        action: "create_L1",
        outcome: "created",
        actor: "cockpit-ladder",
      });

      // Now reconcile with the same marker
      const markers: MarkerIssueRow[] = [
        {
          id: "m-1",
          identifier: "PAR-1001",
          title: "Unblock L1",
          stuckIssueId: "stuck-1",
          level: 1,
          status: "todo",
          originId: "escalate:stuck-1:L1",
          description: null,
          createdAt: NOW.toISOString(),
        },
      ];

      const inserted = await reconcileMarkers(w.ctx, A, markers, NOW);
      expect(inserted).toBe(0); // Should not insert again

      const repairs = await listRepairs(w.ctx, A, { kind: "escalation" });
      expect(repairs).toHaveLength(1);
    });
  });

  describe("company isolation", () => {
    it("scopes repairs by company", async () => {
      const w = await make();
      const markers: MarkerIssueRow[] = [
        {
          id: "m-1",
          identifier: "PAR-1001",
          title: "Unblock L1",
          stuckIssueId: "stuck-1",
          level: 1,
          status: "todo",
          originId: "escalate:stuck-1:L1",
          description: null,
          createdAt: NOW.toISOString(),
        },
      ];

      const insertedA = await reconcileMarkers(w.ctx, A, markers, NOW);
      const insertedB = await reconcileMarkers(w.ctx, B, markers, NOW);

      expect(insertedA).toBe(1);
      expect(insertedB).toBe(1);

      const repairsA = await listRepairs(w.ctx, A, { kind: "escalation" });
      const repairsB = await listRepairs(w.ctx, B, { kind: "escalation" });

      expect(repairsA).toHaveLength(1);
      expect(repairsB).toHaveLength(1);
      expect(repairsA[0].companyId).toBe(A);
      expect(repairsB[0].companyId).toBe(B);
    });
  });

  describe("multiple levels", () => {
    it("handles multiple markers at different levels for the same stuck issue", async () => {
      const w = await make();
      const markers: MarkerIssueRow[] = [
        {
          id: "m-l1",
          identifier: "PAR-1001",
          title: "Unblock L1",
          stuckIssueId: "stuck-1",
          level: 1,
          status: "done",
          originId: "escalate:stuck-1:L1",
          description: null,
          createdAt: NOW.toISOString(),
        },
        {
          id: "m-l2",
          identifier: "PAR-1002",
          title: "Unblock L2",
          stuckIssueId: "stuck-1",
          level: 2,
          status: "todo",
          originId: "escalate:stuck-1:L2",
          description: null,
          createdAt: NOW.toISOString(),
        },
      ];

      const inserted = await reconcileMarkers(w.ctx, A, markers, NOW);
      expect(inserted).toBe(2);

      const repairs = await listRepairs(w.ctx, A, { kind: "escalation" });
      expect(repairs).toHaveLength(2);
      expect(repairs.map((r) => r.targetId).sort()).toEqual(["m-l1", "m-l2"]);
    });
  });
});
