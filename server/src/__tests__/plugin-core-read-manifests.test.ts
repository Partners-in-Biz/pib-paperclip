// PAR-12828 (chat privacy CP-4c, AC-P15): each plugin that declares issues or issue_comments, run through the
// host's query path with its real manifest and its real migrations, gets no chat and no chat message.
// F10 guard: no plugin manifest may declare issue_documents while plugin_core_read has no issue_documents view.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginDatabaseService } from "../services/plugin-database.js";
// Real manifests by relative path, as bundled-plugin-package.test.ts does: server/package.json does not change.
import accounting from "../../../packages/plugins/plugin-accounting/src/manifest.js";
import billing from "../../../packages/plugins/plugin-billing/src/manifest.js";
import campaigns from "../../../packages/plugins/plugin-campaigns/src/manifest.js";
import cockpit from "../../../packages/plugins/plugin-cockpit/src/manifest.js";
import crm from "../../../packages/plugins/plugin-crm/src/manifest.js";
import llmWiki from "../../../packages/plugins/plugin-llm-wiki/src/manifest.js";
import seo from "../../../packages/plugins/plugin-seo/src/manifest.js";
import { readOutwardSends } from "../../../packages/plugins/plugin-cockpit/src/outward-sends.js";

const pluginsRoot = fileURLToPath(new URL("../../../packages/plugins/", import.meta.url));
const CHAT_TABLES = ["issues", "issue_comments", "heartbeat_runs"];
// Every chat text carries this marker; no plugin read may return it.
const SECRET = "CHAT-SECRET";

const seven = Object.entries({
  "plugin-accounting": accounting,
  "plugin-billing": billing,
  "plugin-campaigns": campaigns,
  "plugin-cockpit": cockpit,
  "plugin-crm": crm,
  "plugin-llm-wiki": llmWiki,
  "plugin-seo": seo,
} as Record<string, PaperclipPluginManifestV1>).map(([dir, manifest]) => ({ dir, manifest }));

/** Every plugin manifest source in the repo (dist and node_modules excluded). */
function repoManifestSources(root = pluginsRoot): Array<{ file: string; source: string }> {
  const found: Array<{ file: string; source: string }> = [];
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) found.push(...repoManifestSources(full));
    else if (/^manifest\.(ts|js|mjs|json)$/.test(name)) found.push({ file: path.relative(pluginsRoot, full), source: readFileSync(full, "utf8") });
  }
  return found;
}

/** F10: the manifests that would read public.issue_documents with no chat-free view in front of it. */
function issueDocumentsWithoutView(manifests: Array<{ file: string; source: string }>, viewExists: boolean): string[] {
  const offenders: string[] = [];
  for (const { file, source } of manifests) {
    for (const match of source.matchAll(/coreReadTables"?\s*:\s*(\[[^\]]*\])?/g)) {
      // A list the scan cannot read is refused too, so the guard never passes by not seeing a declaration.
      if (!match[1]) offenders.push(`${file}: coreReadTables is not a literal list`);
      else if (/["']issue_documents["']/.test(match[1]) && !viewExists) offenders.push(`${file}: declares issue_documents`);
    }
  }
  return offenders;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("the seven plugins under test", () => {
  it("are exactly the shipped plugins whose manifest declares issues or issue_comments", () => {
    // examples/ holds upstream sample plugins that are not shipped; the F10 guard below still scans them.
    const declaring = repoManifestSources()
      .filter(({ file }) => !file.startsWith(`examples${path.sep}`))
      .filter(({ source }) => /coreReadTables"?\s*:\s*\[[^\]]*["'](issues|issue_comments)["']/.test(source))
      .map(({ file }) => file.split(path.sep)[0])
      .sort();
    expect(declaring).toEqual(seven.map((p) => p.dir).sort());
    for (const { manifest } of seven) {
      expect(manifest.database?.coreReadTables?.some((t) => t === "issues" || t === "issue_comments"), manifest.id).toBe(true);
    }
  });
});

describeEmbeddedPostgres("AC-P15: each plugin's real manifest gets no chat", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const pluginIds = new Map<string, string>();
  const s = { companyId: randomUUID(), agentId: randomUUID(), userId: `chat-user-${randomUUID()}`, chatId: randomUUID(), taskId: randomUUID(), chatRunId: randomUUID(), taskRunId: randomUUID() };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-core-read-manifests-");
    db = createDb(tempDb.connectionString);
    const pluginDb = pluginDatabaseService(db);
    // Each plugin installs as the host installs it: its real manifest record and its real migrations.
    for (const [index, { dir, manifest }] of seven.entries()) {
      const pluginId = randomUUID();
      await db.insert(plugins).values({
        id: pluginId, pluginKey: manifest.id, packageName: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion,
        categories: manifest.categories, manifestJson: manifest, status: "installed", installOrder: index + 1,
      });
      await pluginDb.applyMigrations(pluginId, manifest, path.join(pluginsRoot, dir));
      pluginIds.set(manifest.id, pluginId);
    }

    // Person A chats with Agent A; the company also has one open task. Every chat text carries SECRET.
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${s.companyId}, 'Chat privacy', 'CPM')`);
    await db.execute(sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${s.agentId}, ${s.companyId}, 'Agent A', 'engineer', 'process')`);
    await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${s.userId}, 'Person A', ${`${s.userId}@example.test`}, true, now(), now())`);
    await db.execute(sql`INSERT INTO issues (id, company_id, title, description, assignee_agent_id, status, identifier,
      conversation_agent_id, conversation_user_id, conversation_state)
      VALUES (${s.chatId}, ${s.companyId}, ${`${SECRET} chat title`}, ${`${SECRET} chat description`}, ${s.agentId}, 'todo', 'CPM-1',
      ${s.agentId}, ${s.userId}, 'waiting')`);
    await db.execute(sql`INSERT INTO issues (id, company_id, title, status, identifier) VALUES (${s.taskId}, ${s.companyId}, 'Open task', 'todo', 'CPM-2')`);
    await db.execute(sql`INSERT INTO issue_comments (company_id, issue_id, author_user_id, body) VALUES
      (${s.companyId}, ${s.chatId}, ${s.userId}, ${`${SECRET} chat message`}),
      (${s.companyId}, ${s.chatId}, ${s.userId}, ${`OUTWARD SEND (Tier A): to ${SECRET} client | email | ${SECRET} offer | CPM-1`}),
      (${s.companyId}, ${s.chatId}, ${s.userId}, ${`REVIEWER: PASS ${SECRET}`}),
      (${s.companyId}, ${s.taskId}, ${s.userId}, 'task message'),
      (${s.companyId}, ${s.taskId}, ${s.userId}, 'OUTWARD SEND (Tier A): to Client B | email | task offer | CPM-2')`);
    await db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, finished_at, issue_id,
      error, stdout_excerpt, stderr_excerpt, result_json, context_snapshot) VALUES
      (${s.chatRunId}, ${s.companyId}, ${s.agentId}, 'succeeded', now(), ${s.chatId}, ${`${SECRET} error`}, ${`${SECRET} stdout`},
       ${`${SECRET} stderr`}, ${JSON.stringify({ reply: `${SECRET} reply` })}::jsonb, ${JSON.stringify({ issueId: s.chatId, note: SECRET })}::jsonb),
      (${s.taskRunId}, ${s.companyId}, ${s.agentId}, 'succeeded', now(), ${s.taskId}, null, 'task stdout', null, null, null)`);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const query = (pluginKey: string, statement: string) =>
    pluginDatabaseService(db).query<Record<string, unknown>>(pluginIds.get(pluginKey)!, statement);

  it.each(seven.map((p) => [p.manifest.id, p.manifest] as const))("%s: a select on each table it declares returns no chat", async (pluginKey, manifest) => {
    const declared = manifest.database!.coreReadTables!;
    expect(declared.filter((t) => CHAT_TABLES.includes(t)).length).toBeGreaterThan(0);
    for (const table of declared) {
      const rows = await query(pluginKey, `SELECT * FROM public.${table}`);
      expect(JSON.stringify(rows), `${pluginKey} public.${table}`).not.toContain(SECRET);
      if (table === "issues") {
        expect(rows.map((r) => r.id)).toEqual([s.taskId]);
      } else if (table === "issue_comments") {
        expect(rows.every((r) => r.issue_id === s.taskId), `${pluginKey} chat message`).toBe(true);
        expect(rows.map((r) => r.body)).toContain("task message");
      } else if (table === "heartbeat_runs") {
        // The chat's run stays (counts and costs) with its text NULL; the task's run keeps its text.
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(s.chatRunId)).toMatchObject({ error: null, stdout_excerpt: null, stderr_excerpt: null, result_json: null, context_snapshot: null });
        expect(byId.get(s.taskRunId)).toMatchObject({ stdout_excerpt: "task stdout" });
      }
    }
  });

  it("Cockpit: the outward-sends query that joins the message text to the task returns nothing from A's chat", async () => {
    const ctx = { db: { query: (statement: string, params?: unknown[]) => pluginDatabaseService(db).query(pluginIds.get(cockpit.id)!, statement, params) } };
    const env = { ctx } as unknown as Parameters<typeof readOutwardSends>[0];
    const { sends, gates } = await readOutwardSends(env, s.companyId, new Date(Date.now() - 86_400_000).toISOString());
    expect(sends.map((send) => [send.issueId, send.issueTitle, send.what])).toEqual([[s.taskId, "Open task", "task offer"]]);
    expect(JSON.stringify({ sends, gates })).not.toContain(SECRET);
    // The host's own read still holds the chat send, so the empty result is the view, not the seed.
    const core = Array.from((await db.execute(sql`SELECT count(*)::int AS n FROM public.issue_comments WHERE body LIKE 'OUTWARD SEND%'`)) as Iterable<{ n: number }>);
    expect(core).toEqual([{ n: 2 }]);
  });

  it("F10 guard: no plugin manifest declares issue_documents while plugin_core_read has no issue_documents view", async () => {
    const [{ exists }] = Array.from((await db.execute(sql`SELECT to_regclass('plugin_core_read.issue_documents') IS NOT NULL AS exists`)) as Iterable<{ exists: boolean }>);
    const manifests = repoManifestSources();
    expect(manifests.length).toBeGreaterThanOrEqual(seven.length);
    expect(issueDocumentsWithoutView(manifests, exists)).toEqual([]);

    // The same guard fails on a test manifest that declares issue_documents.
    const probe = { file: "plugin-probe/src/manifest.ts", source: `database: { coreReadTables: ["issues", "issue_documents"] }` };
    expect(exists).toBe(false);
    expect(issueDocumentsWithoutView([...manifests, probe], exists)).toEqual(["plugin-probe/src/manifest.ts: declares issue_documents"]);
  });
});

describe("plugin core-read manifest tests run under CI", () => {
  it.runIf(Boolean(process.env.CI))("has a real database under CI", () => {
    expect(embeddedPostgresSupport.supported).toBe(true);
  });
});
