import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Chat privacy CP-4b-1 (PAR-12827, plan PAR-12774 4.9 part A): chat-free read views for plugin SQL.
const migrationSql = await readFile(new URL(
  "../../../packages/db/src/migrations/0450_plugin_core_read_views.sql", import.meta.url,
), "utf8");
const migrationStatements = migrationSql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const VIEWS = ["issues", "issue_comments", "heartbeat_runs"] as const;
const BLANKED_RUN_COLUMNS = ["error", "stdout_excerpt", "stderr_excerpt", "result_json", "context_snapshot"];

const support = await getEmbeddedPostgresTestSupport();

describe("plugin_core_read views database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("plugin_core_read views (migration 0450)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), userId = `chat-user-${randomUUID()}`;
  const chatId = randomUUID(), taskId = randomUUID();
  const chatCommentId = randomUUID(), taskCommentId = randomUUID();
  const runs = {
    task: randomUUID(), chatByIssueId: randomUUID(), chatByContext: randomUUID(),
    chatByNative: randomUUID(), chatByTaskKey: randomUUID(), companyRun: randomUUID(),
  };

  const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as Array<Record<string, unknown>>;
  const columns = (schema: string, table: string) => rows(sql`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table} ORDER BY ordinal_position`);

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-plugin-core-read-");
    db = createDb(temporary.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Core read', 'PCR')`);
    await db.execute(sql`INSERT INTO agents (id, company_id, name, role, adapter_type)
      VALUES (${agentId}, ${companyId}, 'Chat agent', 'engineer', 'process')`);
    await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Chat user', ${`${userId}@example.test`}, true, now(), now())`);
    await db.execute(sql`INSERT INTO issues (id, company_id, title, assignee_agent_id, status,
      conversation_agent_id, conversation_user_id, conversation_state)
      VALUES (${chatId}, ${companyId}, 'Private chat', ${agentId}, 'todo', ${agentId}, ${userId}, 'waiting')`);
    await db.execute(sql`INSERT INTO issues (id, company_id, title, status) VALUES (${taskId}, ${companyId}, 'Open task', 'todo')`);
    await db.execute(sql`INSERT INTO issue_comments (id, company_id, issue_id, author_user_id, body) VALUES
      (${chatCommentId}, ${companyId}, ${chatId}, ${userId}, 'secret chat text'),
      (${taskCommentId}, ${companyId}, ${taskId}, ${userId}, 'task text')`);
    // How a run names its task (recorded for this ticket on the 43 runs of agent-conversations.test.ts: every
    // chat run had issue_id = the chat): the trigger set_heartbeat_run_scope_kind (0313) fills issue_id on
    // insert from native_issue_id or context issueId/taskId. issue_id can later become NULL (ON DELETE SET
    // NULL, or an update) while the other three still name the chat, so the view checks all four.
    const insertRun = (id: string, issueId: string | null, nativeIssueId: string | null, context: Record<string, unknown>) =>
      db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, scope_kind, issue_id, native_issue_id,
        error, stdout_excerpt, stderr_excerpt, result_json, context_snapshot, error_code)
        VALUES (${id}, ${companyId}, ${agentId}, 'failed', ${issueId ? "issue" : "company"}, ${issueId}, ${nativeIssueId},
        'error text', 'stdout text', 'stderr text', ${JSON.stringify({ reply: "agent reply" })}::jsonb,
        ${JSON.stringify(context)}::jsonb, 'adapter_failed')`);
    await insertRun(runs.task, taskId, null, { issueId: taskId });
    await insertRun(runs.chatByIssueId, chatId, null, {});
    await insertRun(runs.chatByContext, null, null, { issueId: chatId });
    await insertRun(runs.chatByNative, null, chatId, {});
    await insertRun(runs.chatByTaskKey, null, null, { taskId: chatId });
    await insertRun(runs.companyRun, null, null, { wakeReason: "timer" });
    const detached = [runs.chatByContext, runs.chatByNative, runs.chatByTaskKey];
    await db.execute(sql`UPDATE heartbeat_runs SET issue_id = NULL WHERE id IN (${sql.join(detached.map((id) => sql`${id}`), sql`, `)})`);
    const detachedRows = await rows(sql`SELECT issue_id FROM heartbeat_runs WHERE id IN (${sql.join(detached.map((id) => sql`${id}`), sql`, `)})`);
    expect(detachedRows).toEqual(detached.map(() => ({ issue_id: null })));
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  it("AC-P16: each view has exactly the columns of its table, in table order", async () => {
    for (const view of VIEWS) {
      const tableColumns = await columns("public", view);
      expect(tableColumns.length).toBeGreaterThan(0);
      expect(
        await columns("plugin_core_read", view),
        `plugin_core_read.${view} no longer matches public.${view}. A view does not pick up a new column: `
          + `recreate plugin_core_read.${view} (CREATE OR REPLACE VIEW, full column list in table order) `
          + `in the migration that adds the column.`,
      ).toEqual(tableColumns);
    }
  });

  it("hides chats and their comments and blanks chat text on a chat's runs, keeping every run row", async () => {
    const issueIds = (await rows(sql`SELECT id FROM plugin_core_read.issues WHERE company_id = ${companyId}`)).map((r) => r.id);
    expect(issueIds).toEqual([taskId]);
    const commentIds = (await rows(sql`SELECT id FROM plugin_core_read.issue_comments WHERE company_id = ${companyId}`))
      .map((r) => r.id);
    expect(commentIds).toEqual([taskCommentId]);

    const runRows = await rows(sql`SELECT * FROM plugin_core_read.heartbeat_runs WHERE company_id = ${companyId}`);
    expect(runRows.map((r) => r.id).sort()).toEqual(Object.values(runs).sort());
    for (const run of runRows) {
      const isChatRun = run.id !== runs.task && run.id !== runs.companyRun;
      for (const column of BLANKED_RUN_COLUMNS) {
        expect(run[column] === null, `${column} of run ${String(run.id)}`).toBe(isChatRun);
      }
      expect(run.status).toBe("failed");
      expect(run.error_code).toBe("adapter_failed");
    }
  });

  it("works for a non-superuser that runs the migration, and grants nothing to anyone else", async () => {
    const owner = `pcr_owner_${randomUUID().slice(0, 8)}`;
    const outsider = `pcr_outsider_${randomUUID().slice(0, 8)}`;
    await db.execute(sql.raw(`CREATE ROLE "${owner}" NOSUPERUSER NOCREATEROLE NOCREATEDB LOGIN`));
    await db.execute(sql.raw(`CREATE ROLE "${outsider}" NOSUPERUSER NOCREATEROLE NOCREATEDB LOGIN`));
    // Production (R-Chat-0, PAR-12840): one non-superuser role runs migrations and queries and owns the tables.
    await db.execute(sql.raw(`DROP SCHEMA plugin_core_read CASCADE`));
    for (const table of VIEWS) await db.execute(sql.raw(`ALTER TABLE public."${table}" OWNER TO "${owner}"`));
    await db.execute(sql.raw(`GRANT CREATE ON DATABASE "${temporary.connectionString.split("/").pop()!.split("?")[0]}" TO "${owner}"`));

    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE "${owner}"`));
      const [who] = (await tx.execute(sql`SELECT current_user AS name, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)) as unknown as Array<Record<string, unknown>>;
      expect(who).toEqual({ name: owner, su: false });
      for (const statement of migrationStatements) await tx.execute(sql.raw(statement));
      for (const view of VIEWS) {
        const result = (await tx.execute(sql.raw(`SELECT id FROM plugin_core_read."${view}" WHERE company_id = '${companyId}'`))) as unknown as unknown[];
        expect(result.length, view).toBeGreaterThan(0);
      }
    });

    const owners = await rows(sql`SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'plugin_core_read' ORDER BY c.relname`);
    expect(owners).toEqual([...VIEWS].sort().map((relname) => ({ relname, owner })));
    const publicGrants = await rows(sql`
      SELECT 'schema' AS object FROM pg_namespace n, aclexplode(n.nspacl) a
        WHERE n.nspname = 'plugin_core_read' AND a.grantee = 0
      UNION ALL
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
        WHERE n.nspname = 'plugin_core_read' AND a.grantee = 0`);
    expect(publicGrants).toEqual([]);

    for (const view of VIEWS) {
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE "${outsider}"`));
        await tx.execute(sql.raw(`SELECT 1 FROM plugin_core_read."${view}" LIMIT 1`));
      })).rejects.toThrow();
    }
  });
});
