/**
 * 016: the client's yes and the approved audience on `campaigns`. The 0.8.11
 * statements (copied here as they shipped) must still run against the new
 * schema, so a rollback to 0.8.11 keeps working (rule PAR-4100, F14).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearApproval, getCampaign, insertCampaign, saveCampaign, setApprovalAudience, setClientYes } from "../src/db.js";
import type { CampaignDraft } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const available = await embeddedAvailable();
const FILE = readFileSync(join(import.meta.dirname, "../migrations/016_campaigns.sql"), "utf8");
const T = `${NAMESPACE}.campaigns`;

/** plugin-campaigns 0.8.11 `insertCampaign`, `saveCampaign`, `claimLaunch`, `setLaunchError`, `clearApproval` and the campaign read. */
const OLD = {
  insert: `INSERT INTO ${T}
      (id, company_id, name, description, status, from_name, from_local, reply_to, audience_tags, start_at, end_at, approval_issue_id, winner_variant,
       client_kind, client_ref, client_name, audience_mode, delivery, owner_user_id, owner_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
  save: `UPDATE ${T}
        SET name = $2, description = $3, status = $4, from_name = $5, from_local = $6, reply_to = $7,
            audience_tags = $8::jsonb, start_at = $9, end_at = $10, approval_issue_id = $11, winner_variant = $12,
            client_kind = $13, client_ref = $14, client_name = $15, audience_mode = $16, delivery = $17, updated_at = now()
      WHERE id = $1`,
  claim: `UPDATE ${T}
        SET status = 'active', launched_at = now(), launch_error = NULL, approved_by_user_id = $3, updated_at = now()
      WHERE id = $1 AND status = $2`,
  launchError: `UPDATE ${T} SET launch_error = $2, updated_at = now() WHERE id = $1`,
  clear: `UPDATE ${T} SET approval_issue_id = NULL, launch_error = NULL, updated_at = now() WHERE id = $1`,
  read: `SELECT id, company_id, name, description, status, from_name, from_local, reply_to, audience_tags, start_at, end_at, approval_issue_id, winner_variant, client_kind, client_ref, client_name, audience_mode, delivery, owner_user_id, owner_agent_id, approved_by_user_id, launched_at, launch_error
       FROM ${T} WHERE id = $1 LIMIT 1`,
};

describe("016_campaigns.sql", () => {
  it("passes the host migration guard, only adds nullable columns and has no quotes in comments", () => {
    for (const statement of splitSqlStatements(FILE)) {
      expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    }
    for (const line of FILE.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    const sql = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/\b(delete|drop|not null|default)\b/i);
    for (const column of ["client_yes_ref", "client_yes_by", "client_yes_at", "approval_audience_count", "approval_audience_hash"]) expect(sql).toContain(`ADD COLUMN ${column}`);
  });
});

describe.skipIf(!available)("client's yes and approved audience columns (postgres)", () => {
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

  it("applies over the previous head (001-015) with a seeded campaign and leaves it alone", async () => {
    await q(`ALTER TABLE ${T} DROP COLUMN client_yes_ref, DROP COLUMN client_yes_by, DROP COLUMN client_yes_at, DROP COLUMN approval_audience_count, DROP COLUMN approval_audience_hash`);
    await q(`INSERT INTO ${T} (id, company_id, name, status, approval_issue_id) VALUES ('cmp1', 'c', 'Spring', 'draft', 'iss-1')`);
    await q(FILE);
    const rows = (await q(`SELECT name, status, approval_issue_id, client_yes_ref, client_yes_by, client_yes_at, approval_audience_count, approval_audience_hash FROM ${T} WHERE id = 'cmp1'`)).rows;
    expect(rows).toEqual([{ name: "Spring", status: "draft", approval_issue_id: "iss-1", client_yes_ref: null, client_yes_by: null, client_yes_at: null, approval_audience_count: null, approval_audience_hash: null }]);
  });

  it("runs the 0.8.11 insert, update, launch, clear and read against the new schema", async () => {
    const run = (sql: string, params: unknown[]) => h.ctx.db.execute(sql, params);
    await run(OLD.insert, ["old-1", "c", "Old", "", "draft", "PiB", "hello", null, JSON.stringify(["vip"]), null, null, null, null, "company", "acme", "Acme", "client_contacts", "email", "user-peet", null]);
    await run(OLD.save, ["old-1", "Old 2", "d", "draft", "PiB", "hello", null, JSON.stringify(["vip"]), null, null, "iss-2", null, "company", "acme", "Acme", "client_contacts", "email"]);
    await setClientYes(h.ctx, "old-1", { ref: "https://mail.example/thread/1", by: "user-peet" });
    await run(OLD.launchError, ["old-1", "no sender"]);
    await run(OLD.clear, ["old-1"]);
    await run(OLD.save, ["old-1", "Old 3", "d", "draft", "PiB", "hello", null, JSON.stringify(["vip"]), null, null, "iss-3", null, "company", "acme", "Acme", "client_contacts", "email"]);
    expect((await run(OLD.claim, ["old-1", "draft", "user-peet"])).rowCount).toBe(1);
    const old = await h.ctx.db.query<Record<string, unknown>>(OLD.read, ["old-1"]);
    expect(old[0]).toMatchObject({ name: "Old 3", status: "active", approval_issue_id: "iss-3", approved_by_user_id: "user-peet", launch_error: null });
    // The old version never touches the new columns: the yes it cannot see stays as recorded.
    const now = await getCampaign(h.ctx, "old-1");
    expect(now).toMatchObject({ clientYesRef: "https://mail.example/thread/1", clientYesBy: "user-peet", approvalAudienceCount: null, approvalAudienceHash: null });
  });

  it("reads and writes the five columns; clearing the approval clears the client's yes and keeps the audience", async () => {
    const draft: CampaignDraft = {
      id: "new-1", companyId: "c", name: "New", description: "", status: "draft", fromName: "PiB", fromLocal: "hello", replyTo: null, audienceTags: ["vip"],
      startAt: null, endAt: null, approvalIssueId: null, winnerVariant: null, clientKind: "company", clientRef: "acme", clientName: "Acme",
      audienceMode: "client_contacts", delivery: "email", ownerUserId: "user-peet", ownerAgentId: null,
    };
    await insertCampaign(h.ctx, draft);
    expect(await getCampaign(h.ctx, "new-1")).toMatchObject({ clientYesRef: null, clientYesBy: null, clientYesAt: null, approvalAudienceCount: null, approvalAudienceHash: null });
    await saveCampaign(h.ctx, { ...draft, approvalIssueId: "iss-9" });
    await setApprovalAudience(h.ctx, "new-1", { count: 12, hash: "abc" });
    await setClientYes(h.ctx, "new-1", { ref: "https://mail.example/thread/2", by: "user-peet" });
    const recorded = await getCampaign(h.ctx, "new-1");
    expect(recorded).toMatchObject({ approvalIssueId: "iss-9", clientYesRef: "https://mail.example/thread/2", clientYesBy: "user-peet", approvalAudienceCount: 12, approvalAudienceHash: "abc" });
    expect(Number.isFinite(Date.parse(recorded!.clientYesAt!))).toBe(true);
    await clearApproval(h.ctx, "new-1");
    expect(await getCampaign(h.ctx, "new-1")).toMatchObject({ approvalIssueId: null, clientYesRef: null, clientYesBy: null, clientYesAt: null, approvalAudienceCount: 12, approvalAudienceHash: "abc" });
  });
});
