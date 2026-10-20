/**
 * Ladder reads: marker issues, candidate stuck issues, blocker counts,
 * and their unblock children. Real Postgres harness.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Env } from "../src/env.js";
import { readBlocked, readLadderIssues, readMarkerIssues, readStorms } from "../src/watch.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

d("ladder reads (Postgres)", () => {
  let h: PgHarness;
  const ago = (minutes: number) => new Date(h.clock.now.getTime() - minutes * 60_000).toISOString();

  const run = (agentId: string, status: string, minutesAgo: number, extra: { code?: string | null; issueId?: string | null; error?: string | null; company?: string; id?: string } = {}) =>
    h.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, error, error_code, context_snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [extra.id ?? uuid(), extra.company ?? COMPANY, agentId, status, ago(minutesAgo), extra.error ?? null, extra.code ?? null, extra.issueId === undefined ? null : JSON.stringify({ issueId: extra.issueId })],
    );

  const issue = (id: string, identifier: string, status: string, extra: { title?: string; company?: string; agent?: string | null; user?: string | null; blockedMinutesAgo?: number | null; updatedMinutesAgo?: number; descriptor?: string | null; hidden?: boolean; originId?: string | null } = {}) =>
    h.client.query(
      `INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, assignee_user_id, blocked_transition_at, updated_at, unblock_descriptor, hidden_at, origin_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, now())`,
      [
        id,
        extra.company ?? COMPANY,
        identifier,
        extra.title ?? `Issue ${identifier}`,
        status,
        extra.agent ?? null,
        extra.user ?? null,
        extra.blockedMinutesAgo == null ? null : ago(extra.blockedMinutesAgo),
        ago(extra.updatedMinutesAgo ?? 0),
        extra.descriptor ?? null,
        extra.hidden ? ago(1) : null,
        extra.originId ?? null,
      ],
    );

  const relation = (blockerId: string, blockedId: string, company?: string) =>
    h.client.query(`INSERT INTO public.issue_relations (company_id, issue_id, related_issue_id, type) VALUES ($1, $2, $3, 'blocks')`, [company ?? COMPANY, blockerId, blockedId]);

  beforeAll(async () => {
    h = await startPg();
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    seq = 0;
  });

  describe("readMarkerIssues", () => {
    it("finds issues with origin_id LIKE 'escalate:*' and parses stuck id and level", async () => {
      const stuck = uuid();
      const m1 = uuid();
      const m2 = uuid();
      const m3 = uuid();
      await issue(m1, "PAR-100", "blocked", { originId: `escalate:${stuck}:L1` });
      await issue(m2, "PAR-101", "blocked", { originId: `escalate:${stuck}:L2` });
      await issue(m3, "PAR-102", "done", { originId: `escalate:${stuck}:L3` });
      const markers = await readMarkerIssues(h.ctx, COMPANY);
      expect(markers).toHaveLength(3);
      expect(markers.map((m) => [m.stuckIssueId, m.level, m.status])).toEqual([
        [stuck, 1, "blocked"],
        [stuck, 2, "blocked"],
        [stuck, 3, "done"],
      ]);
    });

    it("rejects malformed origin_id (not escalate format, bad level)", async () => {
      const m1 = uuid();
      const m2 = uuid();
      const m3 = uuid();
      const m4 = uuid();
      await issue(m1, "PAR-103", "blocked", { originId: "some-other-origin" });
      await issue(m2, "PAR-104", "blocked", { originId: `escalate:${uuid()}:L0` }); // level 0
      await issue(m3, "PAR-105", "blocked", { originId: `escalate:${uuid()}:L5` }); // level 5
      await issue(m4, "PAR-106", "blocked", { originId: `escalate:${uuid()}:Lbad` }); // level not numeric
      const markers = await readMarkerIssues(h.ctx, COMPANY);
      expect(markers).toHaveLength(0);
    });

    it("excludes hidden issues", async () => {
      const stuck = uuid();
      const m1 = uuid();
      const m2 = uuid();
      await issue(m1, "PAR-107", "blocked", { originId: `escalate:${stuck}:L1`, hidden: true });
      await issue(m2, "PAR-108", "blocked", { originId: `escalate:${stuck}:L2` });
      const markers = await readMarkerIssues(h.ctx, COMPANY);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({ identifier: "PAR-108", level: 2 });
    });

    it("does not leak other companies' markers", async () => {
      const stuck = uuid();
      const m1 = uuid();
      const m2 = uuid();
      await issue(m1, "PAR-109", "blocked", { originId: `escalate:${stuck}:L1`, company: COMPANY });
      await issue(m2, "PAR-110", "blocked", { originId: `escalate:${stuck}:L1`, company: OTHER_COMPANY });
      const markers = await readMarkerIssues(h.ctx, COMPANY);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({ identifier: "PAR-109" });
    });
  });

  describe("readLadderIssues", () => {
    it("includes a stuck issue with an open L1 child, even though readBlocked skips it (has open blocker)", async () => {
      const stuck = uuid();
      const blocker = uuid();
      const marker = uuid();
      const agentId = "aaaaaaaa-0000-4000-8000-000000000001";
      // Stuck issue, currently blocked with an open blocker (so readBlocked won't list it)
      await issue(stuck, "PAR-201", "blocked", { blockedMinutesAgo: 2 * 1440, agent: agentId });
      // The blocker is in progress
      await issue(blocker, "PAR-201-blocker", "in_progress");
      await relation(blocker, stuck);
      // Marker child (L1 unblock issue)
      await issue(marker, "PAR-201-L1", "in_progress", { originId: `escalate:${stuck}:L1` });

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.stuck).toMatchObject({ id: stuck, identifier: "PAR-201", status: "blocked", openBlockers: 1, closedBlockers: 0 });
      expect(ladder[0]!.unblocks).toHaveLength(1);
      expect(ladder[0]!.unblocks[0]).toMatchObject({ id: marker, identifier: "PAR-201-L1", status: "in_progress" });
    });

    it("lists an unblock child with blockedNoPath true when its stuck issue is in readBlocked", async () => {
      const stuck = uuid();
      const marker = uuid();
      // Stuck issue: blocked, no open blockers, no descriptor, no question -> readBlocked item
      await issue(stuck, "PAR-202", "blocked", { blockedMinutesAgo: 2 * 1440 });
      // Marker child
      await issue(marker, "PAR-202-L1", "in_progress", { originId: `escalate:${stuck}:L1` });

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.unblocks[0]).toMatchObject({ blockedNoPath: true, id: marker });
    });

    it("marks an unblock with inStorm true when it appears in readStorms", async () => {
      const stuck = uuid();
      const marker = uuid();
      const agentId = "aaaaaaaa-0000-4000-8000-000000000001";
      await issue(stuck, "PAR-203", "blocked", { agent: agentId, blockedMinutesAgo: 2 * 1440 });
      await issue(marker, "PAR-203-L1", "in_progress", { originId: `escalate:${stuck}:L1` });
      // Marker issue has 4+ failed runs to trigger storm
      for (let i = 0; i < 4; i += 1) await run(agentId, "failed", 100 + i, { code: "timeout", issueId: marker });

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.unblocks[0]).toMatchObject({ inStorm: true, id: marker });
    });

    it("does not list marker issues themselves as stuck issues", async () => {
      const stuck = uuid();
      const marker1 = uuid();
      const marker2 = uuid();
      // Two levels on the same stuck issue
      await issue(stuck, "PAR-204", "blocked", { blockedMinutesAgo: 2 * 1440 });
      await issue(marker1, "PAR-204-L1", "in_progress", { originId: `escalate:${stuck}:L1` });
      await issue(marker2, "PAR-204-L2", "in_progress", { originId: `escalate:${stuck}:L2` });

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      // Only one stuck issue (the original), not the markers
      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.stuck.identifier).toBe("PAR-204");
      expect(ladder[0]!.unblocks).toHaveLength(2);
    });

    it("includes a stuck issue with no markers (plain blocked issue)", async () => {
      const stuck = uuid();
      await issue(stuck, "PAR-205", "blocked", { blockedMinutesAgo: 2 * 1440 });

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      expect(ladder).toHaveLength(1);
      expect(ladder[0]).toMatchObject({
        stuck: { id: stuck, identifier: "PAR-205", status: "blocked", openBlockers: 0, closedBlockers: 0 },
        unblocks: [],
      });
    });

    it("counts open and closed blockers correctly", async () => {
      const stuck = uuid();
      const marker = uuid();
      const open1 = uuid();
      const open2 = uuid();
      const closed = uuid();
      await issue(stuck, "PAR-206", "blocked", { blockedMinutesAgo: 2 * 1440 });
      await issue(marker, "PAR-206-L1", "in_progress", { originId: `escalate:${stuck}:L1` });
      await issue(open1, "PAR-206-open-1", "in_progress");
      await issue(open2, "PAR-206-open-2", "todo");
      await issue(closed, "PAR-206-done", "done");
      await relation(open1, stuck);
      await relation(open2, stuck);
      await relation(closed, stuck);

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.stuck).toMatchObject({ openBlockers: 2, closedBlockers: 1 });
    });

    it("does not leak other companies' issues", async () => {
      const stuck1 = uuid();
      const stuck2 = uuid();
      const marker1 = uuid();
      const marker2 = uuid();
      // Company 1: stuck + marker
      await issue(stuck1, "PAR-207", "blocked", { company: COMPANY, blockedMinutesAgo: 2 * 1440 });
      await issue(marker1, "PAR-207-L1", "in_progress", { company: COMPANY, originId: `escalate:${stuck1}:L1` });
      // Company 2: stuck + marker
      await issue(stuck2, "PAR-208", "blocked", { company: OTHER_COMPANY, blockedMinutesAgo: 2 * 1440 });
      await issue(marker2, "PAR-208-L1", "in_progress", { company: OTHER_COMPANY, originId: `escalate:${stuck2}:L1` });

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.stuck.identifier).toBe("PAR-207");
      expect(ladder[0]!.unblocks[0]!.identifier).toBe("PAR-207-L1");
    });

    it("handles a stuck issue that no longer exists in the marker (skips it)", async () => {
      const fakeStuck = uuid();
      const marker = uuid();
      // Marker points to a stuck issue that doesn't exist
      await issue(marker, "PAR-209-L1", "in_progress", { originId: `escalate:${fakeStuck}:L1` });

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      // Marker's stuck issue is skipped because it doesn't exist in DB
      expect(ladder).toHaveLength(0);
    });

    it("returns empty for a company with no blocked or marker issues", async () => {
      const active = uuid();
      await issue(active, "PAR-210", "in_progress");
      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      expect(ladder).toHaveLength(0);
    });

    it("computes blocker counts when a marker issue is on a stuck issue with blockers", async () => {
      const stuck = uuid();
      const blocker1 = uuid();
      const blocker2 = uuid();
      const marker = uuid();
      await issue(stuck, "PAR-211", "blocked", { blockedMinutesAgo: 2 * 1440 });
      await issue(blocker1, "PAR-211-blocker1", "done");
      await issue(blocker2, "PAR-211-blocker2", "cancelled");
      await relation(blocker1, stuck);
      await relation(blocker2, stuck);
      await issue(marker, "PAR-211-L1", "in_progress", { originId: `escalate:${stuck}:L1` });

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.stuck).toMatchObject({ openBlockers: 0, closedBlockers: 2, id: stuck });
    });

    it("passes marker description through to unblock (for parseMarker classification)", async () => {
      const stuck = uuid();
      const marker = uuid();
      const description = `Some reason\n\n<!-- pib:escalation {"issue":"${stuck}","level":1,"deadline":"2026-09-26T12:00:00.000Z"} -->`;
      await issue(stuck, "PAR-212", "blocked", { blockedMinutesAgo: 2 * 1440 });
      await issue(marker, "PAR-212-L1", "in_progress", { originId: `escalate:${stuck}:L1` });

      // Update with description manually
      await h.client.query(`UPDATE public.issues SET description = $1 WHERE id = $2`, [description, marker]);

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.unblocks[0]).toMatchObject({ id: marker });
      // Verify description is present (not empty string)
      expect(ladder[0]!.unblocks[0]!.description).toContain("pib:escalation");
    });

    it("readBlocked limit parameter works: readLadderIssues calls readBlocked with LADDER_CANDIDATES", async () => {
      const stuck1 = uuid();
      const stuck2 = uuid();
      const stuck3 = uuid();
      const stuck4 = uuid();
      const stuck5 = uuid();
      const stuck6 = uuid();
      const stuck7 = uuid();
      const stuck8 = uuid();
      // Create 8 blocked issues to test that more than 5 can be candidates
      for (let i = 1; i <= 8; i++) {
        await issue(uuid(), `PAR-213-${i}`, "blocked", { blockedMinutesAgo: 2 * 1440 });
      }

      const ladder = await readLadderIssues(h.ctx, COMPANY, h.clock.now);
      // Should return more than 5 candidates (up to 25)
      expect(ladder.length).toBeGreaterThan(5);
      expect(ladder.length).toBeLessThanOrEqual(8); // We only created 8
    });
  });
});
