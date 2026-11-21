// Seeds one company of PAR's size into a disposable local Paperclip database, for the
// task-list time measure of PAR-12608 AC-L12 (PAR-12747, C-sweep-3). See
// `measure-task-list-time.ts` for the method.
//
// Raw SQL with explicit columns only, so the same script seeds a database migrated by
// the code from before stage C (no restriction columns) and one migrated by the code
// after it. Every id and value is derived from the row number, so two databases get the
// same rows and the two task lists can be compared row for row.
//
//   node server/node_modules/tsx/dist/cli.mjs server/scripts/seed-task-list-company.ts \
//     --database-url=postgres://paperclip:paperclip@127.0.0.1:54329/paperclip
//   (owner board key from the environment variable MEASURE_OWNER_TOKEN)
//
//   ... seed-task-list-company.ts --database-url=... --set-mode=report
//   (only changes the seeded company's member_restriction_mode; needs the stage C schema)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDb } from "../../packages/db/src/index.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const count = (name: string, fallback: number) => {
  const value = Number(arg(name) ?? fallback);
  assert.ok(Number.isInteger(value) && value >= 0, `--${name} must be a whole number`);
  return value;
};

// PAR on 18 Nov 2026 (dashboard and lists): about 13,200 tasks (done 11,018, open 867,
// blocked 564, in progress 21, the rest cancelled), 129 projects, 38 agents, 9 labels.
export const PAR_SIZE = { tasks: 13_200, projects: 129, agents: 38, members: 8, labels: 9, commentsPerTask: 6 };

/** Deterministic uuid for row `n` of `kind`, the same in every database. */
export const seededId = (kind: string, n: number) => {
  const hex = createHash("md5").update(`par-12747:${kind}:${n}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
export const SEEDED_COMPANY_ID = seededId("company", 1);
export const SEEDED_OWNER_ID = "par12747-owner";
const OPERATOR_ID = "par12747-operator";
const RESTRICTED_ID = "par12747-restricted";

function loopbackUrl(raw: string | undefined) {
  assert.ok(raw, "Pass --database-url=<disposable local Paperclip database>");
  const url = new URL(raw);
  assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname), "Only a disposable loopback database may be seeded");
  return url.href;
}

async function main() {
  const db = createDb(loopbackUrl(arg("database-url")), { maxConnections: 1 });
  const sql = db.$client;
  try {
    const hasRestriction = (await sql.unsafe(
      "select 1 from information_schema.columns where table_schema = 'public' and table_name = 'companies' and column_name = 'member_restriction_mode'",
    )).length > 0;
    const mode = arg("set-mode");
    if (mode) {
      assert.ok(["off", "report", "enforce"].includes(mode), "--set-mode must be off, report or enforce");
      assert.ok(hasRestriction, "This database has no member_restriction_mode column (code from before stage C)");
      const rows = await sql.unsafe("update companies set member_restriction_mode = $1 where id = $2 returning id", [mode, SEEDED_COMPANY_ID]);
      assert.equal(rows.length, 1, "Seed the company first");
      console.log(JSON.stringify({ companyId: SEEDED_COMPANY_ID, mode }));
      return;
    }

    const token = process.env.MEASURE_OWNER_TOKEN;
    assert.ok(token && token.length >= 24, "Set MEASURE_OWNER_TOKEN (24+ characters) for the owner's board key");
    const size = {
      tasks: count("tasks", PAR_SIZE.tasks),
      projects: count("projects", PAR_SIZE.projects),
      agents: count("agents", PAR_SIZE.agents),
      members: count("members", PAR_SIZE.members),
      labels: count("labels", PAR_SIZE.labels),
      commentsPerTask: count("comments-per-task", PAR_SIZE.commentsPerTask),
    };
    assert.ok(size.projects > 0 && size.agents > 0 && size.tasks > 0, "Tasks, projects and agents must be at least 1");
    const existing = await sql.unsafe("select 1 from companies where id = $1", [SEEDED_COMPANY_ID]);
    assert.equal(existing.length, 0, "This database already holds the seeded company");

    const started = performance.now();
    await sql.begin(async (tx) => {
      const run = (text: string, params: unknown[] = []) => tx.unsafe(text, params as never[]);
      // Fixed timestamps, so before and after databases hold identical rows.
      const base = "timestamptz '2026-11-01 00:00:00+00'";

      const people = [
        [SEEDED_OWNER_ID, "Seed Owner", "owner"],
        [OPERATOR_ID, "Seed Operator", "operator"],
        [RESTRICTED_ID, "Seed Restricted Operator", "operator"],
        ...Array.from({ length: Math.max(0, size.members - 3) }, (_, i) => [`par12747-member-${i + 1}`, `Seed Member ${i + 1}`, i % 2 ? "viewer" : "operator"]),
      ];
      for (const [id, name] of people) {
        await run(`insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, ${base}, ${base})`, [id, name, `${id}@example.invalid`]);
      }
      await run(
        "insert into companies (id, name, issue_prefix, issue_counter, created_at, updated_at) values ($1, 'Seeded PAR-size company', 'PAR', $2, " + base + ", " + base + ")",
        [SEEDED_COMPANY_ID, size.tasks],
      );
      for (const [id, , role] of people) {
        await run(
          "insert into company_memberships (company_id, principal_type, principal_id, status, membership_role, created_at, updated_at) values ($1, 'user', $2, 'active', $3, " + base + ", " + base + ")",
          [SEEDED_COMPANY_ID, id, role],
        );
      }
      await run(
        "insert into board_api_keys (user_id, name, key_hash, created_at) values ($1, 'task-list measure', $2, " + base + ")",
        [SEEDED_OWNER_ID, createHash("sha256").update(token).digest("hex")],
      );

      // md5(...)::uuid in SQL gives the same ids as seededId() above. Agents are paused, so
      // the servers start no runs for the seeded tasks while the measure runs.
      const id = (kind: string, n: string) => `md5('par-12747:${kind}:' || ${n})::uuid`;
      await run(`
        insert into agents (id, company_id, name, role, status, pause_reason, paused_at, adapter_type, created_at, updated_at)
        select ${id("agent", "g")}, $1, 'Seed Agent ' || g, 'general', 'paused', 'manual', ${base}, 'process', ${base}, ${base}
        from generate_series(1, $2::int) g`, [SEEDED_COMPANY_ID, size.agents]);
      await run(`
        insert into projects (id, company_id, name, status, visibility, created_at, updated_at)
        select ${id("project", "g")}, $1, 'Seed Project ' || g,
          (array['backlog', 'planned', 'in_progress', 'completed'])[1 + g % 4], 'open',
          ${base} + g * interval '1 hour', ${base} + g * interval '1 hour'
        from generate_series(1, $2::int) g`, [SEEDED_COMPANY_ID, size.projects]);
      if (size.labels > 0) {
        await run(`
          insert into labels (id, company_id, name, color, created_at, updated_at)
          select ${id("label", "g")}, $1, 'seed-label-' || g, '#4f46e5', ${base}, ${base}
          from generate_series(1, $2::int) g`, [SEEDED_COMPANY_ID, size.labels]);
      }

      // Status mix per 1000 tasks follows PAR: 837 done, 53 cancelled, 43 blocked,
      // 40 todo, 25 backlog, 2 in progress. Two in five tasks after the first 50 have a
      // parent among the 400 tasks before them, so chains of several levels form.
      // One task in 50 is private, created by the owner.
      await run(`
        insert into issues (
          id, company_id, project_id, parent_id, title, description, status, priority,
          assignee_agent_id, assignee_user_id, created_by_agent_id, created_by_user_id,
          issue_number, identifier, origin_kind, visibility, created_at, updated_at, started_at, completed_at, cancelled_at
        )
        select
          ${id("issue", "i")}, $1,
          case when i % 10 = 0 then null else ${id("project", "(1 + (i * 31) % $3::int)")} end,
          case when i > 50 and i % 5 in (1, 2) then ${id("issue", "(i - 1 - (i * 7919) % least(i - 1, 400))")} end,
          'Seeded task ' || i || ' ' || left(md5(i::text), 12),
          repeat('Seeded description for the task-list measure. ', 30),
          s.status,
          (array['critical', 'high', 'medium', 'low'])[1 + i % 4],
          case when i % 20 = 0 then null else ${id("agent", "(1 + (i * 17) % $4::int)")} end,
          case when i % 20 = 0 then (case when i % 97 = 0 then '${RESTRICTED_ID}' else '${SEEDED_OWNER_ID}' end) end,
          case when i % 10 < 7 and i % 50 <> 7 then ${id("agent", "(1 + (i * 13) % $4::int)")} end,
          case when i % 10 >= 7 or i % 50 = 7 then (case when i % 89 = 0 and i % 50 <> 7 then '${RESTRICTED_ID}' else '${SEEDED_OWNER_ID}' end) end,
          i, 'PAR-' || i, 'manual',
          case when i % 50 = 7 then 'private' else 'open' end,
          ${base} - ($2::int - i) * interval '25 minutes',
          ${base} - ($2::int - i) * interval '25 minutes' + interval '3 hours',
          case when s.status <> 'backlog' and s.status <> 'todo' then ${base} - ($2::int - i) * interval '25 minutes' + interval '10 minutes' end,
          case when s.status = 'done' then ${base} - ($2::int - i) * interval '25 minutes' + interval '3 hours' end,
          case when s.status = 'cancelled' then ${base} - ($2::int - i) * interval '25 minutes' + interval '3 hours' end
        from generate_series(1, $2::int) i
        cross join lateral (select case
          when (i * 7) % 1000 < 837 then 'done'
          when (i * 7) % 1000 < 890 then 'cancelled'
          when (i * 7) % 1000 < 933 then 'blocked'
          when (i * 7) % 1000 < 973 then 'todo'
          when (i * 7) % 1000 < 998 then 'backlog'
          else 'in_progress' end as status) s`,
        [SEEDED_COMPANY_ID, size.tasks, size.projects, size.agents]);
      // The privacy columns as the app writes them: parent, and the root of the chain.
      await run(`
        with recursive chain as (
          select id, id as root from issues where company_id = $1 and parent_id is null
          union all
          select c.id, chain.root from issues c join chain on c.parent_id = chain.id where c.company_id = $1
        )
        update issues i set privacy_parent_issue_id = i.parent_id, privacy_root_issue_id = chain.root
        from chain where chain.id = i.id and i.parent_id is not null`, [SEEDED_COMPANY_ID]);

      if (size.commentsPerTask > 0) {
        // Between 1 and 2 * commentsPerTask - 1 comments per task, commentsPerTask on average.
        await run(`
          insert into issue_comments (id, company_id, issue_id, author_type, author_agent_id, author_user_id, body, created_at, updated_at)
          select md5('par-12747:comment:' || i || ':' || k)::uuid, $1, ${id("issue", "i")},
            case when k % 3 = 0 then 'user' else 'agent' end,
            case when k % 3 = 0 then null else ${id("agent", "(1 + (i + k) % $3::int)")} end,
            case when k % 3 = 0 then '${SEEDED_OWNER_ID}' end,
            repeat('Seeded comment body. ', 20),
            ${base} - ($2::int - i) * interval '25 minutes' + k * interval '5 minutes',
            ${base} - ($2::int - i) * interval '25 minutes' + k * interval '5 minutes'
          from generate_series(1, $2::int) i
          cross join lateral generate_series(1, 1 + (i * 13) % (2 * $4::int - 1)) k`,
          [SEEDED_COMPANY_ID, size.tasks, size.agents, size.commentsPerTask]);
      }
      if (size.labels > 0) {
        await run(`
          insert into issue_labels (company_id, issue_id, label_id, created_at)
          select $1, ${id("issue", "i")}, ${id("label", "(1 + i % $3::int)")}, ${base}
          from generate_series(3, $2::int, 3) i`, [SEEDED_COMPANY_ID, size.tasks, size.labels]);
      }
      // The restricted operator is an access member of three projects in both databases.
      await run(`
        insert into project_access_members (id, company_id, project_id, subject_type, subject_id, created_at)
        select ${id("project-access", "g")}, $1, ${id("project", "g")}, 'user', '${RESTRICTED_ID}', ${base} from generate_series(1, least(3, $2::int)) g`,
        [SEEDED_COMPANY_ID, size.projects]);
      if (hasRestriction) {
        // After stage C: the operator is flagged, with two agents on his list.
        await run(
          "update company_memberships set restricted = true, restricted_agent_ids = $3::jsonb where company_id = $1 and principal_id = $2",
          [SEEDED_COMPANY_ID, RESTRICTED_ID, JSON.stringify([seededId("agent", 1), seededId("agent", 2)])],
        );
      }
    });
    await sql.unsafe("analyze");

    const [counts] = await sql.unsafe(`select
      (select count(*)::int from issues where company_id = $1) tasks,
      (select count(*)::int from issues where company_id = $1 and parent_id is not null) children,
      (select count(*)::int from issues where company_id = $1 and visibility = 'private') private_tasks,
      (select count(*)::int from issue_comments where company_id = $1) comments,
      (select count(*)::int from projects where company_id = $1) projects,
      (select count(*)::int from agents where company_id = $1) agents,
      (select count(*)::int from company_memberships where company_id = $1) members`, [SEEDED_COMPANY_ID]);
    console.log(JSON.stringify({
      companyId: SEEDED_COMPANY_ID,
      ownerUserId: SEEDED_OWNER_ID,
      restrictionColumns: hasRestriction,
      size,
      counts,
      seedMs: Math.round(performance.now() - started),
    }));
  } finally {
    await sql.end({ timeout: 1 });
  }
}

await main();
