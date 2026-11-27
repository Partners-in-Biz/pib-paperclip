/**
 * 021: `campaigns.autopilot_mode` (NOT NULL DEFAULT safe, CHECK off | safe | full) and `campaigns.paused_by`. The 0.18.0
 * statements (copied here as they shipped) must still run against the new schema, so a rollback to 0.18.0 keeps working
 * and its new campaigns read Safe (rule PAR-4100, F14).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCampaign, insertCampaign, saveCampaign, setCampaignMode, setCampaignStatus } from "../src/db.js";
import { createCampaign } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const available = await embeddedAvailable();
const FILE = readFileSync(join(import.meta.dirname, "../migrations/021_campaigns.sql"), "utf8");
const T = `${NAMESPACE}.campaigns`;

/** plugin-campaigns 0.18.0 `insertCampaign` and `saveCampaign`, as they shipped. */
const OLD = {
  insert: `INSERT INTO ${T}
      (id, company_id, name, description, status, from_name, from_local, reply_to, audience_tags, start_at, end_at, approval_issue_id, winner_variant,
       client_kind, client_ref, client_name, audience_mode, delivery, owner_user_id, owner_agent_id, feed_url, feed_category, feed_item_keys)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb)`,
  save: `UPDATE ${T}
        SET name = $2, description = $3, status = $4, from_name = $5, from_local = $6, reply_to = $7,
            audience_tags = $8::jsonb, start_at = $9, end_at = $10, approval_issue_id = $11, winner_variant = $12,
            client_kind = $13, client_ref = $14, client_name = $15, audience_mode = $16, delivery = $17, updated_at = now()
      WHERE id = $1`,
};

describe("021_campaigns.sql", () => {
  it("passes the host migration guard, only adds the two columns and the check, and has no quotes in comments", () => {
    for (const statement of splitSqlStatements(FILE)) {
      expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    }
    for (const line of FILE.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    const sql = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/\b(delete|drop|update)\b/i);
    expect(sql).toContain("ADD COLUMN autopilot_mode text NOT NULL DEFAULT 'safe'");
    expect(sql).toContain("ADD COLUMN paused_by text;");
    expect(sql).toContain("CHECK (autopilot_mode IN ('off', 'safe', 'full'))");
  });
});

describe.skipIf(!available)("autopilot_mode and paused_by (postgres)", () => {
  let h: PgHarness;
  beforeAll(async () => {
    h = await startPg();
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
  });
  const q = (sql: string, params: unknown[] = []) => h.client.query(sql, params);

  it("applies over the previous head (001-020) with seeded campaigns, which read Safe and never paused", async () => {
    await q(`ALTER TABLE ${T} DROP CONSTRAINT campaigns_autopilot_mode, DROP COLUMN autopilot_mode, DROP COLUMN paused_by`);
    await q(`INSERT INTO ${T} (id, company_id, name, status) VALUES ('cmp1', 'c', 'Spring', 'active'), ('cmp2', 'c', 'Old pause', 'paused')`);
    await q(FILE);
    const rows = (await q(`SELECT id, status, autopilot_mode, paused_by FROM ${T} ORDER BY id`)).rows;
    expect(rows).toEqual([
      { id: "cmp1", status: "active", autopilot_mode: "safe", paused_by: null },
      { id: "cmp2", status: "paused", autopilot_mode: "safe", paused_by: null },
    ]);
  });

  it("runs the 0.18.0 insert and update against the new schema: the campaign is Safe and the update leaves mode and pauser alone", async () => {
    const run = (sql: string, params: unknown[]) => h.ctx.db.execute(sql, params);
    await run(OLD.insert, ["old-1", "c", "Old", "", "draft", "PiB", "hello", null, JSON.stringify(["vip"]), null, null, null, null, null, null, null, "tags", "email", "user-peet", null, null, null, null]);
    expect(await getCampaign(h.ctx, "old-1")).toMatchObject({ autopilotMode: "safe", pausedBy: null });
    await setCampaignMode(h.ctx, { id: "old-1", companyId: "c" }, "off");
    await setCampaignStatus(h.ctx, { id: "old-1", companyId: "c" }, "paused", "user:user-peet");
    await run(OLD.save, ["old-1", "Old 2", "d", "active", "PiB", "hello", null, JSON.stringify(["vip"]), null, null, null, null, null, null, null, "tags", "email"]);
    expect(await getCampaign(h.ctx, "old-1")).toMatchObject({ name: "Old 2", status: "active", autopilotMode: "off", pausedBy: "user:user-peet" });
  });

  it("the new insert stores the mode, saveCampaign does not touch it, and the check refuses an unknown mode", async () => {
    const campaign = createCampaign({ companyId: "c", name: "New", autopilotMode: "off" });
    await insertCampaign(h.ctx, campaign);
    await saveCampaign(h.ctx, { ...campaign, name: "Renamed", autopilotMode: "safe" });
    expect(await getCampaign(h.ctx, campaign.id)).toMatchObject({ name: "Renamed", autopilotMode: "off" });
    expect(await setCampaignMode(h.ctx, { id: campaign.id, companyId: "other" }, "safe")).toBe(false);
    await expect(q(`UPDATE ${T} SET autopilot_mode = 'turbo' WHERE id = $1`, [campaign.id])).rejects.toThrow(/campaigns_autopilot_mode/);
    await expect(q(`UPDATE ${T} SET autopilot_mode = NULL WHERE id = $1`, [campaign.id])).rejects.toThrow(/not-null|null value/);
  });
});
